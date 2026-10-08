"""File upload, URL scraping, and ingestion pipeline endpoints."""

import asyncio
import hashlib
import logging
import mimetypes
import os
import re
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, UploadFile, File, Form, Request
from fastapi.responses import FileResponse
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from libs.exceptions import AppError, IngestionError, ValidationError, NotFoundError, public_ingestion_message
from database import get_db, async_session
from models.ingestion import IngestionJob
from models.course import Course
from models.user import User
from services.ingestion.pipeline import run_ingestion_pipeline
from services.agent.background_runtime import track_background_task
from services.auth.dependency import get_current_user
from services.course_access import get_course_or_404
from services.upload_storage import resolve_upload_path

import socket  # noqa: F401 — re-exported for test monkeypatching compatibility

from routers.upload_processing import (  # noqa: F401 — re-exported for consumers
    _safe_filename,
    _validate_url,
    _validate_url_dns,
    _normalize_scrape_url,
    _load_scrape_fixture_html,
    _derive_filename,
    _fetch_canvas_with_auth,
    _background_auto_generate,
    _background_import_canvas_quizzes,
    _background_embed,
)

logger = logging.getLogger(__name__)

router = APIRouter()


async def _get_failed_file_replacement_target(
    db: AsyncSession,
    *,
    target_id: str | None,
    user_id: uuid.UUID,
    course_id: uuid.UUID,
) -> IngestionJob | None:
    """Return a failed file job explicitly selected for replacement.

    A replacement is deliberately explicit: uploading an unrelated file with
    the same filename must never remove a historical failure.  The caller only
    receives a target after proving that it belongs to the current user and
    learning space and is still a failed file ingestion.
    """
    if not target_id:
        return None

    try:
        failed_job_id = uuid.UUID(target_id)
    except ValueError as exc:
        raise ValidationError("Invalid replace_failed_job_id") from exc

    result = await db.execute(
        select(IngestionJob).where(
            IngestionJob.id == failed_job_id,
            IngestionJob.user_id == user_id,
            IngestionJob.course_id == course_id,
            IngestionJob.source_type == "file",
            IngestionJob.status == "failed",
        )
    )
    failed_job = result.scalar_one_or_none()
    if not failed_job:
        raise ValidationError("这条失败资料已不存在，或不属于当前学习空间")
    return failed_job


async def _retire_replaced_failed_job(
    db: AsyncSession,
    *,
    failed_job: IngestionJob,
    replacement_job: IngestionJob,
) -> bool:
    """Remove a superseded failure only after its replacement is usable.

    The ingestion record is a processing artefact, so removing it never
    removes course content, notes, questions, plans, or learning progress.
    The uploaded binary is deleted only when no remaining ingestion record
    references it (the same content hash can legitimately share a path).
    """
    if replacement_job.status not in {"embedding", "completed"} or not replacement_job.dispatched:
        return False

    old_path = failed_job.file_path
    old_id = failed_job.id
    try:
        await db.delete(failed_job)
        await db.commit()
    except Exception:
        await db.rollback()
        logger.exception(
            "Failed to retire replaced ingestion job %s after replacement %s succeeded",
            old_id,
            replacement_job.id,
        )
        return False

    if old_path:
        remaining_reference = await db.scalar(
            select(IngestionJob.id)
            .where(IngestionJob.file_path == old_path)
            .limit(1)
        )
        if remaining_reference is None:
            old_file = resolve_upload_path(old_path, settings.upload_dir)
            if old_file is not None:
                try:
                    await asyncio.to_thread(old_file.unlink)
                except OSError:
                    logger.warning("Failed to remove retired upload file: %s", old_file)

    logger.info(
        "Retired failed ingestion job %s after successful replacement %s",
        old_id,
        replacement_job.id,
    )
    return True


async def _remove_unreferenced_upload_file(db: AsyncSession, stored_path: str | None) -> None:
    """Delete a managed file only after its final ingestion reference is gone."""
    if not stored_path:
        return
    remaining_reference = await db.scalar(
        select(IngestionJob.id).where(IngestionJob.file_path == stored_path).limit(1)
    )
    if remaining_reference is not None:
        return
    old_file = resolve_upload_path(stored_path, settings.upload_dir)
    if old_file is None:
        return
    try:
        await asyncio.to_thread(old_file.unlink)
    except OSError:
        logger.warning("Failed to remove retired upload file: %s", old_file)


@router.post("/upload", summary="Upload a file", description="Upload a document and run the 7-step ingestion pipeline.")
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    course_id: str = Form(...),
    replace_failed_job_id: str | None = Form(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload any file -> 7-step ingestion pipeline -> content tree."""
    try:
        cid = uuid.UUID(course_id)
    except ValueError as e:
        raise ValidationError("Invalid course_id") from e

    await get_course_or_404(db, cid, user_id=user.id)
    failed_replacement_target = await _get_failed_file_replacement_target(
        db,
        target_id=replace_failed_job_id,
        user_id=user.id,
        course_id=cid,
    )

    if not file.filename:
        raise ValidationError("No filename provided")

    supported_exts = {".pdf", ".pptx", ".ppt", ".docx", ".doc", ".html", ".htm", ".txt", ".md"}
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in supported_exts:
        raise ValidationError(f"Unsupported file type: {ext}. Supported: {', '.join(supported_exts)}")

    file_bytes = await file.read()
    if len(file_bytes) > settings.max_upload_size_mb * 1024 * 1024:
        raise ValidationError("File too large")

    # Validate magic bytes match declared extension for binary formats
    import filetype as ft
    detected = ft.guess(file_bytes)
    _MAGIC_EXT_MAP = {
        "application/pdf": {".pdf"},
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": {".pptx"},
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {".docx"},
        "application/zip": {".pptx", ".docx"},  # Office files are ZIP-based
    }
    if detected and detected.mime in _MAGIC_EXT_MAP:
        allowed_exts = _MAGIC_EXT_MAP[detected.mime]
        if ext not in allowed_exts:
            logger.warning(
                "SECURITY | MIME_MISMATCH | declared_ext=%s | detected_mime=%s | filename=%s",
                ext, detected.mime, file.filename,
            )
            raise ValidationError(
                f"File content ({detected.mime}) does not match extension ({ext})"
            )

    file_hash = hashlib.sha256(file_bytes).hexdigest()[:16]
    os.makedirs(settings.upload_dir, exist_ok=True)
    safe_name = re.sub(r"[^\w.\-]", "_", os.path.basename(file.filename)) or "unnamed"
    safe_name = safe_name[:255]
    save_path = os.path.join(settings.upload_dir, f"{file_hash}_{safe_name}")
    await asyncio.to_thread(Path(save_path).write_bytes, file_bytes)

    try:
        job = await run_ingestion_pipeline(
            db=db,
            user_id=user.id,
            file_path=save_path,
            filename=file.filename,
            course_id=cid,
            file_bytes=file_bytes,
        )
        await db.commit()
    except Exception:
        # Clean up saved file if ingestion fails, then re-raise the original error.
        try:
            os.remove(save_path)
        except OSError:
            logger.warning("Failed to clean up uploaded file: %s", save_path)
        raise

    if job.status == "failed":
        # Keep a logical failure's file so the Processing Center can genuinely
        # retry it.  A successful explicit re-upload retires this record and
        # its unreferenced file through _retire_replaced_failed_job().
        if failed_replacement_target is not None:
            # The replacement attempt is authoritative even when it also
            # fails. Old errors must never win the UI race after a re-upload.
            failed_replacement_target.is_current_attempt = False
            failed_replacement_target.superseded_by_id = job.id
            await db.commit()
        raise IngestionError(public_ingestion_message(job.error_message), source=file.filename)

    retired_failed_job = False
    retired_failed_job_id: str | None = None
    if failed_replacement_target is not None:
        candidate_id = str(failed_replacement_target.id)
        retired_failed_job = await _retire_replaced_failed_job(
            db,
            failed_job=failed_replacement_target,
            replacement_job=job,
        )
        if retired_failed_job:
            retired_failed_job_id = candidate_id

    is_test_request = request is not None and hasattr(request.app.state, "test_session_factory")
    if (job.nodes_created or 0) > 0 and not is_test_request:
        track_background_task(asyncio.create_task(_background_embed(cid, job.id, user_id=user.id)))

    return {
        "status": "ok",
        "file": file.filename,
        "job_id": str(job.id),
        "category": job.content_category,
        "dispatched_to": job.dispatched_to,
        "nodes_created": job.nodes_created or 0,
        "course_id": str(cid),
        "retired_failed_job_id": retired_failed_job_id,
    }


@router.post("/url", summary="Scrape a URL", description="Fetch content from a URL and run it through the ingestion pipeline.")
async def scrape_url(
    request: Request,
    url: str = Form(...),
    course_id: str = Form(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Scrape a URL -> ingestion pipeline -> content tree."""
    from libs.url_validation import validate_url, validate_url_dns

    url = _normalize_scrape_url(url)
    fixture_html = _load_scrape_fixture_html(url)
    if fixture_html is not None:
        logger.info("Using local scrape fixture for %s", url)
    if fixture_html is None:
        validate_url(url)
        await validate_url_dns(url)
    try:
        cid = uuid.UUID(course_id)
    except ValueError as e:
        raise ValidationError("Invalid course_id") from e

    await get_course_or_404(db, cid, user_id=user.id)

    from services.scraper.canvas_detector import detect_canvas_url

    canvas_info = detect_canvas_url(url)
    pre_fetched = fixture_html
    requires_auth = False

    if canvas_info.is_canvas and fixture_html is None:
        requires_auth = True
        logger.info("Canvas URL detected: %s (course_id=%s, page=%s)",
                     canvas_info.domain, canvas_info.course_id, canvas_info.page_type)

    filename = _derive_filename(url)

    # Pass session_name for authenticated Canvas API access
    from routers.scrape import _default_session_name as _dsn
    scrape_session_name = None
    if canvas_info.is_canvas:
        scrape_session_name = _dsn(user.id, canvas_info.domain)

    job = await run_ingestion_pipeline(
        db=db,
        user_id=user.id,
        url=url,
        filename=filename,
        course_id=cid,
        pre_fetched_html=pre_fetched,
        session_name=scrape_session_name,
    )
    await db.commit()

    if job.status == "failed":
        error_msg = job.error_message or "Scrape failed"
        if requires_auth and not pre_fetched:
            error_msg = (
                f"Canvas URL requires authentication. "
                f"Please login to {canvas_info.domain} first via Settings -> Canvas Login, "
                f"then retry. Original error: {error_msg}"
            )
        raise AppError(error_msg)

    is_test_request = request is not None and hasattr(request.app.state, "test_session_factory")
    if (job.nodes_created or 0) > 0 and not is_test_request:
        track_background_task(asyncio.create_task(_background_embed(cid, job.id, user_id=user.id)))

    # Auto-ingest discovered Canvas files (PDFs, docs) in background,
    # then link PDFs to topics, summarize titles, and auto-generate notes.
    canvas_file_urls = getattr(job, "_canvas_file_urls", [])
    files_discovered = len(canvas_file_urls)
    if canvas_file_urls and canvas_info.is_canvas and scrape_session_name and not is_test_request:
        from routers.upload_processing import start_background_canvas_pipeline
        start_background_canvas_pipeline(
            user_id=user.id, course_id=cid,
            canvas_file_urls=canvas_file_urls,
            scrape_session_name=scrape_session_name,
            canvas_domain=canvas_info.domain,
        )
        logger.info("Queued %d Canvas files for background ingestion + auto-processing", files_discovered)

    # Auto-import Canvas quiz questions as PracticeProblem records
    canvas_quiz_questions = getattr(job, "_canvas_quiz_questions", [])
    if canvas_quiz_questions and not is_test_request:
        track_background_task(asyncio.create_task(
            _background_import_canvas_quizzes(
                course_id=cid,
                quiz_questions=canvas_quiz_questions,
            )
        ))
        logger.info("Queued %d Canvas quiz questions for import", len(canvas_quiz_questions))

    return {
        "status": "ok",
        "url": url,
        "job_id": str(job.id),
        "category": job.content_category,
        "nodes_created": job.nodes_created or 0,
        "course_id": str(cid),
        "is_canvas": canvas_info.is_canvas,
        "canvas_auth_used": requires_auth and pre_fetched is not None,
        "files_discovered": files_discovered,
        "quiz_questions_queued": len(canvas_quiz_questions),
    }


@router.post("/spaces/plan", summary="Plan learning spaces for uploads", description="Analyze a batch of filenames and propose subject-based grouping into learning spaces.")
async def plan_spaces(
    body: dict,
    user: User = Depends(get_current_user),
):
    """Group uploaded filenames into proposed learning spaces by subject/grade.

    Body: {"files": ["七年级数学教材.pdf", ...]}
    Returns: {"groups": [...], "unclassified": [...]} — unclassified files
    must be confirmed by the user before creating spaces.
    """
    from services.ingestion.subject_detection import build_upload_plan

    filenames = body.get("files") or []
    if not isinstance(filenames, list) or not all(isinstance(f, str) for f in filenames):
        raise ValidationError("files must be a list of filename strings")
    if len(filenames) > 50:
        raise ValidationError("Too many files (max 50)")
    return build_upload_plan(filenames)


def _job_to_dict(j: IngestionJob) -> dict:
    return {
        "id": str(j.id),
        "course_id": str(j.course_id) if j.course_id else None,
        "filename": j.original_filename,
        "source_type": j.source_type,
        "category": j.content_category,
        "status": j.status,
        "processing_attempt_id": str(j.processing_attempt_id),
        "workflow_state": j.workflow_state,
        "failure_code": j.failure_code,
        "is_current_attempt": j.is_current_attempt,
        "phase_label": j.phase_label,
        "progress_percent": j.progress_percent,
        "embedding_status": j.embedding_status,
        "nodes_created": j.nodes_created,
        "page_stats": j.page_stats,
        "error_message": public_ingestion_message(j.error_message) if j.status == "failed" else None,
        "dispatched_to": j.dispatched_to,
        "created_at": j.created_at.isoformat(),
        "updated_at": j.updated_at.isoformat() if j.updated_at else None,
    }


@router.get("/jobs", summary="List all ingestion jobs", description="Return all ingestion jobs for the current user across courses (processing center).")
async def list_all_ingestion_jobs(
    limit: int = 50,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List ingestion jobs across all courses for the processing center."""
    result = await db.execute(
        select(IngestionJob)
        .join(Course, Course.id == IngestionJob.course_id)
        .where(
            IngestionJob.user_id == user.id,
            IngestionJob.is_current_attempt.is_(True),
            or_(
                Course.status == "ACTIVE",
                and_(
                    Course.status == "SETUP",
                    IngestionJob.status != "completed",
                ),
            ),
        )
        .order_by(IngestionJob.created_at.desc())
        .limit(min(max(limit, 1), 200))
    )
    return [_job_to_dict(j) for j in result.scalars().all()]


@router.post("/jobs/{job_id}/retry", summary="Retry a failed ingestion job", description="Re-run the ingestion pipeline for a failed job from its stored file or URL.")
async def retry_ingestion_job(
    job_id: uuid.UUID,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Retry a failed ingestion job (fallback chain: stored file -> URL)."""
    result = await db.execute(
        select(IngestionJob).where(
            IngestionJob.id == job_id,
            IngestionJob.user_id == user.id,
        )
    )
    job = result.scalar_one_or_none()
    if not job:
        raise NotFoundError("Job")
    if job.status not in ("failed",):
        raise ValidationError("只有解析失败的文件才能重新处理")

    # Resolve stored file path back to an absolute path
    file_path = None
    if job.file_path:
        file_path = resolve_upload_path(job.file_path, settings.upload_dir)
        if file_path is None:
            raise NotFoundError("Uploaded file on disk")

    # The pipeline creates a fresh processing record.  Do not mutate the
    # historical failed row to ``pending`` first: doing so previously left a
    # permanently spinning orphan when the new retry record failed or the
    # process stopped mid-run.
    failed_job = job
    replacement_job = await run_ingestion_pipeline(
        db=db,
        user_id=user.id,
        file_path=str(file_path) if file_path else None,
        url=failed_job.url,
        filename=failed_job.original_filename or "",
        course_id=failed_job.course_id,
    )
    # A retry always establishes a new authoritative attempt. Keeping the
    # old failure as audit history is useful, but it must never be returned by
    # the creation flow or overwrite the retry's status.
    failed_job.is_current_attempt = False
    failed_job.superseded_by_id = replacement_job.id
    await db.commit()

    if replacement_job.status in {"embedding", "completed"}:
        await _retire_replaced_failed_job(
            db,
            failed_job=failed_job,
            replacement_job=replacement_job,
        )

    is_test_request = request is not None and hasattr(request.app.state, "test_session_factory")
    if (replacement_job.nodes_created or 0) > 0 and replacement_job.course_id and not is_test_request:
        track_background_task(asyncio.create_task(_background_embed(replacement_job.course_id, replacement_job.id, user_id=user.id)))

    # Server-generated updated_at is expired after UPDATE even with
    # expire_on_commit=False. Load it explicitly before synchronous JSON
    # serialization, otherwise successful retries raise MissingGreenlet/503.
    await db.refresh(replacement_job)
    return _job_to_dict(replacement_job)


@router.delete("/jobs/failed", summary="Clear failed ingestion history", description="Remove failed processing records without touching course learning data.")
async def clear_failed_ingestion_jobs(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Clear only failed processing artefacts selected by the learner."""
    failed_jobs = list((await db.execute(
        select(IngestionJob).where(
            IngestionJob.user_id == user.id,
            IngestionJob.status == "failed",
        )
    )).scalars().all())
    paths = {job.file_path for job in failed_jobs if job.file_path}
    for job in failed_jobs:
        await db.delete(job)
    if failed_jobs:
        await db.commit()
        for path in paths:
            await _remove_unreferenced_upload_file(db, path)
    logger.info("Cleared %d failed ingestion record(s) for user %s", len(failed_jobs), user.id)
    return {"deleted_count": len(failed_jobs)}


@router.get("/jobs/{course_id}", summary="List ingestion jobs", description="Return all ingestion jobs for a course with status and progress.")
async def list_ingestion_jobs(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List ingestion jobs for a course."""
    await get_course_or_404(db, course_id, user_id=user.id)
    result = await db.execute(
        select(IngestionJob)
        .where(IngestionJob.course_id == course_id, IngestionJob.is_current_attempt == True)  # noqa: E712
        .order_by(IngestionJob.created_at.desc())
    )
    jobs = result.scalars().all()
    return [
        {
            "id": str(j.id),
            "course_id": str(j.course_id) if j.course_id else None,
            "filename": j.original_filename,
            "source_type": j.source_type,
            "category": j.content_category,
            "status": j.status,
            "processing_attempt_id": str(j.processing_attempt_id),
            "workflow_state": j.workflow_state,
            "failure_code": j.failure_code,
            "is_current_attempt": j.is_current_attempt,
            "phase_label": j.phase_label,
            "progress_percent": j.progress_percent,
            "embedding_status": j.embedding_status,
            "nodes_created": j.nodes_created,
            "page_stats": j.page_stats,
            "error_message": public_ingestion_message(j.error_message) if j.status == "failed" else None,
            "dispatched_to": j.dispatched_to,
            "created_at": j.created_at.isoformat(),
            "updated_at": j.updated_at.isoformat() if j.updated_at else None,
        }
        for j in jobs
    ]


@router.get("/files/by-course/{course_id}", summary="List course files", description="Return uploaded files for a course that completed ingestion.")
async def list_course_files(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List uploaded files for a course."""
    await get_course_or_404(db, course_id, user_id=user.id)

    result = await db.execute(
        select(IngestionJob)
        .where(
            IngestionJob.course_id == course_id,
            IngestionJob.user_id == user.id,
            IngestionJob.status == "completed",
            IngestionJob.file_path.isnot(None),
        )
        .order_by(IngestionJob.created_at.desc())
    )
    jobs = result.scalars().all()
    return [
        {
            "id": str(job.id),
            "job_id": str(job.id),
            "filename": job.original_filename,
            "file_name": job.original_filename,
            "mime_type": job.mime_type,
            "created_at": job.created_at.isoformat() if job.created_at else None,
        }
        for job in jobs
    ]


@router.post("/image", summary="Upload an image", description="Upload an image for chat context such as a math problem photo.")
async def upload_image(
    file: UploadFile = File(...),
    course_id: str = Form(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload an image for chat context (e.g., math problem photo)."""
    import base64

    try:
        cid = uuid.UUID(course_id)
    except ValueError as e:
        raise ValidationError("Invalid course_id") from e

    await get_course_or_404(db, cid, user_id=user.id)

    if not file.filename:
        raise ValidationError("No filename provided")

    supported_types = {"image/jpeg", "image/png", "image/webp", "image/gif"}
    content_type = file.content_type or ""
    if content_type not in supported_types:
        ext = os.path.splitext(file.filename)[1].lower()
        ext_to_mime = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}
        content_type = ext_to_mime.get(ext, "")
        if content_type not in supported_types:
            raise ValidationError("Unsupported image type. Supported: JPEG, PNG, WebP, GIF")

    file_bytes = await file.read()
    max_image_size = 10 * 1024 * 1024  # 10MB
    if len(file_bytes) > max_image_size:
        raise ValidationError("Image too large (max 10MB)")

    file_hash = hashlib.sha256(file_bytes).hexdigest()[:16]
    os.makedirs(settings.upload_dir, exist_ok=True)
    safe_name = re.sub(r"[^\w.\-]", "_", os.path.basename(file.filename)) or "unnamed"
    safe_name = safe_name[:255]
    save_path = os.path.join(settings.upload_dir, f"img_{file_hash}_{safe_name}")
    await asyncio.to_thread(Path(save_path).write_bytes, file_bytes)

    b64_data = base64.b64encode(file_bytes).decode("utf-8")

    return {
        "status": "ok",
        "filename": file.filename,
        "content_type": content_type,
        "size_bytes": len(file_bytes),
        "base64": b64_data,
        "media_type": content_type,
        "course_id": str(cid),
    }


@router.get("/files/{job_id}", summary="Download an uploaded file", description="Serve an uploaded file by ingestion job ID for preview.")
async def get_uploaded_file(
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Serve an uploaded file for preview (e.g., PDF viewer)."""
    result = await db.execute(
        select(IngestionJob).where(
            IngestionJob.id == job_id,
            IngestionJob.user_id == user.id,
        )
    )
    job = result.scalar_one_or_none()
    if not job or not job.file_path:
        raise NotFoundError("File")

    file_path = resolve_upload_path(job.file_path, settings.upload_dir)
    if file_path is None:
        raise NotFoundError("File on disk")

    media_type = mimetypes.guess_type(job.original_filename or "")[0] or "application/octet-stream"

    return FileResponse(
        path=str(file_path),
        media_type=media_type,
        filename=job.original_filename,
        content_disposition_type="inline",
    )
