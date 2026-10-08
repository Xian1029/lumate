"""AI Notes restructuring endpoint."""

import logging
import uuid

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends
from libs.exceptions import AppError, NotFoundError, ValidationError, reraise_as_app_error
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models.content import CourseContentTree
from models.user import User
from services.auth.dependency import get_current_user
from services.course_access import get_course_or_404
from services.llm.readiness import ensure_llm_ready
from services.content_text import is_assessment_content
from services.parser.notes import normalize_generated_markdown, restructure_notes
from services.preference.engine import resolve_preferences

router = APIRouter()


class RestructureRequest(BaseModel):
    content_node_id: uuid.UUID
    format_override: str | None = None  # Override user preference


class RestructureResponse(BaseModel):
    original_title: str
    ai_content: str
    format_used: str


class SaveGeneratedNotesRequest(BaseModel):
    course_id: uuid.UUID
    title: str
    markdown: str
    source_node_id: uuid.UUID | None = None
    replace_batch_id: uuid.UUID | None = None


PERSONAL_NOTE_STYLES = {"sunshine", "mint", "sky", "berry"}


class PersonalNoteRequest(BaseModel):
    content_node_id: uuid.UUID
    text: str = Field(min_length=1, max_length=5000)
    style: str = "sunshine"


async def _validate_personal_note_node(
    db: AsyncSession,
    *,
    course_id: uuid.UUID,
    node_id: uuid.UUID,
) -> CourseContentTree:
    result = await db.execute(
        select(CourseContentTree).where(
            CourseContentTree.id == node_id,
            CourseContentTree.course_id == course_id,
        )
    )
    node = result.scalar_one_or_none()
    if not node or not is_assessment_content(
        node.title,
        node.content,
        content_category=node.content_category,
        level=node.level,
    ):
        raise NotFoundError(resource="content_node", resource_id=str(node_id))
    return node


def _serialize_personal_note(asset) -> dict:
    metadata = asset.metadata_ or {}
    content = asset.content or {}
    return {
        "id": str(asset.id),
        "content_node_id": str(metadata.get("source_node_id") or ""),
        "text": str(content.get("text") or ""),
        "style": str(metadata.get("style") or "sunshine"),
        "created_at": asset.created_at.isoformat() if asset.created_at else None,
        "updated_at": asset.updated_at.isoformat() if asset.updated_at else None,
    }


def _clean_personal_note(body: PersonalNoteRequest) -> tuple[str, str]:
    text = body.text.strip()
    if not text:
        raise ValidationError("Personal note cannot be empty")
    if body.style not in PERSONAL_NOTE_STYLES:
        raise ValidationError("Unsupported personal note style")
    return text, body.style


@router.post("/restructure", response_model=RestructureResponse, summary="Restructure content node", description="Restructure a content node into AI-formatted notes based on user preferences.")
async def restructure_content(body: RestructureRequest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Restructure a content node based on user preferences."""
    result = await db.execute(
        select(CourseContentTree).where(CourseContentTree.id == body.content_node_id)
    )
    node = result.scalar_one_or_none()
    if not node or not node.content:
        raise NotFoundError(resource="content_node", resource_id=str(body.content_node_id))

    # Verify course ownership
    await get_course_or_404(db, node.course_id, user_id=user.id)

    if not is_assessment_content(
        node.title,
        node.content,
        content_category=node.content_category,
        level=node.level,
    ):
        raise ValidationError("Preface, catalog and reference sections do not generate AI notes")

    # Get user preferences
    resolved = await resolve_preferences(db, user.id, node.course_id)

    note_format = body.format_override or resolved.preferences.get("note_format", "bullet_point")
    visual_pref = resolved.preferences.get("visual_preference", "auto")

    await ensure_llm_ready("Notes restructuring")
    try:
        ai_content = await restructure_notes(
            node.content, node.title, note_format, visual_pref
        )
    except (ConnectionError, TimeoutError, ValueError, KeyError, RuntimeError) as exc:
        reraise_as_app_error(exc, "Notes restructuring failed")
    except SQLAlchemyError as exc:
        reraise_as_app_error(exc, "Notes restructuring failed")

    return RestructureResponse(
        original_title=node.title,
        ai_content=ai_content,
        format_used=note_format,
    )


@router.post("/generated/save", summary="Save generated notes", description="Persist AI-generated notes as a versioned asset for a course.")
async def save_generated_notes(
    body: SaveGeneratedNotesRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_course_or_404(db, body.course_id, user_id=user.id)

    from services.generated_assets import save_generated_asset

    try:
        result = await save_generated_asset(
            db,
            user_id=user.id,
            course_id=body.course_id,
            asset_type="notes",
            title=normalize_generated_markdown(body.title),
            content={"markdown": normalize_generated_markdown(body.markdown)},
            metadata={"source_node_id": str(body.source_node_id) if body.source_node_id else None},
            replace_batch_id=body.replace_batch_id,
        )
    except ValueError as exc:
        raise NotFoundError(resource="generated_asset", resource_id=str(body.replace_batch_id)) from exc

    await db.commit()

    # Emit standardized learning event for analytics + plugin hooks
    try:
        from services.analytics.events import emit_learning_event, LearningEventData
        await emit_learning_event(db, LearningEventData(
            user_id=user.id,
            verb="created",
            object_type="note",
            object_id=result.get("batch_id") or str(body.course_id),
            course_id=body.course_id,
            context_json={"title": body.title, "source_node_id": str(body.source_node_id) if body.source_node_id else None},
        ))
        await db.commit()
    except (SQLAlchemyError, ValueError, TypeError):
        logger.exception("Notes learning event emission failed (best-effort)")

    return result


@router.get("/personal/{course_id}/by-node/{node_id}", summary="List personal notes for content node")
async def list_personal_notes(
    course_id: uuid.UUID,
    node_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_course_or_404(db, course_id, user_id=user.id)
    await _validate_personal_note_node(db, course_id=course_id, node_id=node_id)

    from models.generated_asset import GeneratedAsset
    result = await db.execute(
        select(GeneratedAsset)
        .where(
            GeneratedAsset.user_id == user.id,
            GeneratedAsset.course_id == course_id,
            GeneratedAsset.asset_type == "personal_note",
            GeneratedAsset.is_archived == False,  # noqa: E712
        )
        .order_by(GeneratedAsset.created_at.desc())
    )
    return [
        _serialize_personal_note(asset)
        for asset in result.scalars().all()
        if str((asset.metadata_ or {}).get("source_node_id") or "") == str(node_id)
    ]


@router.post("/personal/{course_id}", summary="Create a personal note")
async def create_personal_note(
    course_id: uuid.UUID,
    body: PersonalNoteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_course_or_404(db, course_id, user_id=user.id)
    node = await _validate_personal_note_node(db, course_id=course_id, node_id=body.content_node_id)
    text, style = _clean_personal_note(body)

    from models.generated_asset import GeneratedAsset
    asset = GeneratedAsset(
        user_id=user.id,
        course_id=course_id,
        asset_type="personal_note",
        title=f"我的认识 · {node.title}"[:200],
        content={"text": text},
        metadata_={"source_node_id": str(body.content_node_id), "style": style},
    )
    db.add(asset)
    await db.commit()
    await db.refresh(asset)
    return _serialize_personal_note(asset)


@router.patch("/personal/{course_id}/{note_id}", summary="Update a personal note")
async def update_personal_note(
    course_id: uuid.UUID,
    note_id: uuid.UUID,
    body: PersonalNoteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_course_or_404(db, course_id, user_id=user.id)
    await _validate_personal_note_node(db, course_id=course_id, node_id=body.content_node_id)
    text, style = _clean_personal_note(body)

    from models.generated_asset import GeneratedAsset
    result = await db.execute(
        select(GeneratedAsset).where(
            GeneratedAsset.id == note_id,
            GeneratedAsset.user_id == user.id,
            GeneratedAsset.course_id == course_id,
            GeneratedAsset.asset_type == "personal_note",
            GeneratedAsset.is_archived == False,  # noqa: E712
        )
    )
    asset = result.scalar_one_or_none()
    if not asset or str((asset.metadata_ or {}).get("source_node_id") or "") != str(body.content_node_id):
        raise NotFoundError(resource="personal_note", resource_id=str(note_id))
    asset.content = {"text": text}
    asset.metadata_ = {**(asset.metadata_ or {}), "style": style}
    await db.commit()
    await db.refresh(asset)
    return _serialize_personal_note(asset)


@router.delete("/personal/{course_id}/{note_id}", summary="Delete a personal note")
async def delete_personal_note(
    course_id: uuid.UUID,
    note_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_course_or_404(db, course_id, user_id=user.id)

    from models.generated_asset import GeneratedAsset
    result = await db.execute(
        select(GeneratedAsset).where(
            GeneratedAsset.id == note_id,
            GeneratedAsset.user_id == user.id,
            GeneratedAsset.course_id == course_id,
            GeneratedAsset.asset_type == "personal_note",
            GeneratedAsset.is_archived == False,  # noqa: E712
        )
    )
    asset = result.scalar_one_or_none()
    if not asset:
        raise NotFoundError(resource="personal_note", resource_id=str(note_id))
    asset.is_archived = True
    await db.commit()
    return {"deleted": True, "id": str(note_id)}


@router.get("/generated/{course_id}/by-node/{node_id}", summary="Get note for content node", description="Return the auto-generated AI note for a specific content node.")
async def get_generated_note_for_node(
    course_id: uuid.UUID,
    node_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get auto-generated AI note for a specific content node."""
    await get_course_or_404(db, course_id, user_id=user.id)

    from models.generated_asset import GeneratedAsset
    result = await db.execute(
        select(GeneratedAsset)
        .where(
            GeneratedAsset.user_id == user.id,
            GeneratedAsset.course_id == course_id,
            GeneratedAsset.asset_type == "notes",
            GeneratedAsset.is_archived == False,
        )
        .order_by(GeneratedAsset.version.desc())
    )
    assets = result.scalars().all()
    for asset in assets:
        meta = asset.metadata_ or {}
        if meta.get("source_node_id") == str(node_id):
            return {
                "id": str(asset.id),
                "title": normalize_generated_markdown(asset.title),
                # Older note assets predate the write-time normalizer. Reading
                # through the same boundary keeps legacy notes from rendering
                # as mojibake without mutating them during a GET request.
                "markdown": normalize_generated_markdown((asset.content or {}).get("markdown")),
                "format": (meta.get("format") or "bullet_point"),
                "auto_generated": meta.get("auto_generated", False),
                "version": asset.version,
            }
    return None


@router.get("/generated/{course_id}", summary="List generated notes", description="Return all saved AI-generated note batches for a course.")
async def list_generated_notes(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_course_or_404(db, course_id, user_id=user.id)

    from services.generated_assets import list_generated_asset_batches

    batches = await list_generated_asset_batches(
        db,
        user_id=user.id,
        course_id=course_id,
        asset_type="notes",
    )
    # Keep historical batch previews readable too. This endpoint remains a
    # side-effect-free read; it does not silently rewrite old assets.
    for batch in batches:
        batch["title"] = normalize_generated_markdown(batch.get("title"))
        preview = batch.get("preview")
        if isinstance(preview, dict) and "markdown" in preview:
            batch["preview"] = {**preview, "markdown": normalize_generated_markdown(preview.get("markdown"))}
    return batches
