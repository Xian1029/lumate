"""Application startup and shutdown hooks."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import httpx

from config import settings
from database import Base, engine, is_sqlite

logger = logging.getLogger(__name__)


async def _maybe_create_tables() -> None:
    if not settings.app_auto_create_tables:
        return

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        if is_sqlite():
            await conn.run_sync(_upgrade_local_study_session_schema)
            await conn.run_sync(_upgrade_local_question_catalog_schema)
            await conn.run_sync(_upgrade_local_additive_columns)
    logger.info("Ensured database tables exist via Base.metadata.create_all()")


def _upgrade_local_study_session_schema(connection) -> None:
    """Keep existing local SQLite databases compatible with create_all bootstrap.

    ``create_all`` creates missing tables but does not add columns to an existing
    table. Hosted databases use Alembic; this small additive sync is only for the
    local SQLite path.
    """
    import sqlalchemy as sa

    inspector = sa.inspect(connection)
    if "study_sessions" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("study_sessions")}
    additions = {
        "active_seconds": "INTEGER NOT NULL DEFAULT 0",
        "elapsed_seconds": "INTEGER NOT NULL DEFAULT 0",
        "last_activity_at": "DATETIME",
        "client_session_id": "VARCHAR(64)",
        "content_node_id": "VARCHAR(36)",
        "status": "VARCHAR(20) NOT NULL DEFAULT 'active'",
        "activity_breakdown": "JSON",
    }
    for name, definition in additions.items():
        if name not in columns:
            connection.exec_driver_sql(f"ALTER TABLE study_sessions ADD COLUMN {name} {definition}")
    connection.exec_driver_sql("DROP INDEX IF EXISTS ix_study_sessions_client_session_id")
    connection.exec_driver_sql(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_study_sessions_user_course_client "
        "ON study_sessions (user_id, course_id, client_session_id)"
    )
    connection.exec_driver_sql(
        "UPDATE study_sessions SET active_seconds = COALESCE(duration_minutes, 0) * 60 "
        "WHERE active_seconds = 0 AND COALESCE(duration_minutes, 0) > 0"
    )


def _upgrade_local_question_catalog_schema(connection) -> None:
    """Additive SQLite upgrades for the textbook-first question catalog."""
    import sqlalchemy as sa

    inspector = sa.inspect(connection)
    if "question_catalog_entries" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("question_catalog_entries")}
    additions = {
        "common_mistake": "TEXT",
        "solution_method": "TEXT",
    }
    for name, definition in additions.items():
        if name not in columns:
            connection.exec_driver_sql(
                f"ALTER TABLE question_catalog_entries ADD COLUMN {name} {definition}"
            )


# Nullable columns added to pre-existing tables after the create_all
# bootstrap was introduced.  Hosted databases receive them via Alembic
# (0026/0027); old local SQLite files must not 500 on INSERT just because
# create_all cannot alter an existing table.
_LOCAL_ADDITIVE_COLUMNS: dict[str, dict[str, str]] = {
    "courses": {
        "status": "VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'",
        "deleted_at": "DATETIME",
    },
    "practice_results": {
        "grading_meta": "JSON",
    },
    "learning_progress": {
        "metadata_json": "JSON",
    },
    "wrong_answers": {
        "wrong_attempt_count": "INTEGER NOT NULL DEFAULT 1",
    },
    "ingestion_jobs": {
        "page_stats": "JSON",
        "processing_attempt_id": "VARCHAR(36)",
        "workflow_state": "VARCHAR(50) NOT NULL DEFAULT 'UPLOADED'",
        "failure_code": "VARCHAR(50)",
        "is_current_attempt": "BOOLEAN NOT NULL DEFAULT 1",
        "superseded_by_id": "VARCHAR(36)",
    },
    "study_sessions": {
        "target_module": "VARCHAR(30)",
    },
}


def _upgrade_local_additive_columns(connection) -> None:
    """Additive SQLite sync for columns that postdate the create_all bootstrap."""
    import sqlalchemy as sa

    inspector = sa.inspect(connection)
    existing_tables = set(inspector.get_table_names())
    for table, additions in _LOCAL_ADDITIVE_COLUMNS.items():
        if table not in existing_tables:
            continue
        columns = {column["name"] for column in inspector.get_columns(table)}
        for name, definition in additions.items():
            if name not in columns:
                connection.exec_driver_sql(
                    f"ALTER TABLE {table} ADD COLUMN {name} {definition}"
                )
    if "ingestion_jobs" in existing_tables:
        connection.exec_driver_sql(
            "UPDATE ingestion_jobs SET processing_attempt_id = id "
            "WHERE processing_attempt_id IS NULL"
        )


async def _maybe_bootstrap_migration_tracking() -> None:
    # Local SQLite flow uses create_all() for bootstrap and does not require
    # migration stamping during startup.
    return None


async def _maybe_seed_system_data() -> None:
    if not settings.app_auto_seed_system:
        return

    from database import async_session
    from services.templates.system import seed_builtin_templates

    async with async_session() as db:
        await seed_builtin_templates(db)
        await db.commit()
    logger.info("Seeded built-in templates")


async def _migrate_upload_storage_records() -> None:
    """Keep uploaded textbooks usable when a local project/database is moved."""
    from database import async_session
    from services.upload_storage import migrate_legacy_upload_paths

    async with async_session() as db:
        await migrate_legacy_upload_paths(db, settings.upload_dir)


async def _finalize_legacy_embedding_jobs() -> None:
    """Close historic jobs whose optional indexing stage outlived the process.

    Before the ingestion lifecycle split, successful material dispatch changed
    the primary job status to ``embedding``.  A restart or provider outage
    could then leave the learner-facing record spinning forever even though
    the textbook was already available.  This startup repair is deliberately
    explicit (never a read-side effect) and preserves embedding as a
    secondary, retryable status.
    """
    from sqlalchemy import select

    from database import async_session
    from models.ingestion import IngestionJob
    from services.ingestion.pipeline import _set_job_phase

    async with async_session() as db:
        jobs = list((await db.execute(
            select(IngestionJob).where(IngestionJob.status == "embedding")
        )).scalars().all())
        for job in jobs:
            _set_job_phase(
                job,
                status="completed",
                progress_percent=100,
                embedding_status=(
                    "pending" if job.embedding_status in {"pending", "running"}
                    else job.embedding_status
                ),
                nodes_created=job.nodes_created,
            )
        if jobs:
            await db.commit()
            logger.info("Finalized %d legacy embedding job(s) as material-ready", len(jobs))


async def _repair_orphaned_retry_jobs() -> None:
    """Restore failed status for old retry records stranded in ``pending``.

    Earlier retry code mutated the old failed row to pending, but the pipeline
    then created a new row. If that new attempt did not succeed, the original
    row never received a terminal state and the UI polled it forever.
    """
    from sqlalchemy import select

    from database import async_session
    from models.ingestion import IngestionJob
    from services.ingestion.pipeline import _set_job_phase

    async with async_session() as db:
        jobs = list((await db.execute(
            select(IngestionJob).where(
                IngestionJob.status == "pending",
                IngestionJob.embedding_status == "failed",
            )
        )).scalars().all())
        for job in jobs:
            _set_job_phase(
                job,
                status="failed",
                progress_percent=0,
                embedding_status="failed",
                nodes_created=job.nodes_created,
                error_message=job.error_message or "Previous retry did not finish",
            )
        if jobs:
            await db.commit()
            logger.info("Repaired %d orphaned ingestion retry job(s)", len(jobs))


async def _repair_orphaned_dispatch_jobs() -> None:
    """Resolve uploads interrupted after workspace content was dispatched.

    A client disconnect or process restart can occur between inserting the
    content tree and committing the final ingestion status.  Such jobs used
    to remain at 70% forever even though their material was already usable.
    This is an explicit startup repair, not a side effect of a GET request.
    """
    from sqlalchemy import exists, select

    from database import async_session
    from models.content import CourseContentTree
    from models.ingestion import IngestionJob
    from services.ingestion.pipeline import _set_job_phase

    async with async_session() as db:
        jobs = list((await db.execute(
            select(IngestionJob).where(
                IngestionJob.status == "dispatching",
                IngestionJob.is_current_attempt.is_(True),
            )
        )).scalars().all())
        repaired = 0
        failed = 0
        for job in jobs:
            has_content = bool((await db.execute(
                select(exists().where(
                    CourseContentTree.course_id == job.course_id,
                    CourseContentTree.source_file == job.original_filename,
                ))
            )).scalar())
            if has_content:
                _set_job_phase(
                    job,
                    status="completed",
                    progress_percent=100,
                    embedding_status="pending",
                    nodes_created=max(job.nodes_created or 0, 1),
                )
                repaired += 1
            else:
                _set_job_phase(
                    job,
                    status="failed",
                    progress_percent=70,
                    embedding_status="failed",
                    nodes_created=0,
                    error_message="Workspace construction was interrupted; please upload this material again",
                )
                failed += 1
        if jobs:
            await db.commit()
            logger.info(
                "Resolved %d orphaned dispatch job(s): %d ready, %d retryable",
                len(jobs), repaired, failed,
            )


async def _cleanup_stale_provisional_workspaces() -> None:
    """Remove abandoned, unpublished creation attempts after retention expiry.

    SETUP courses are processing containers, not learner workspaces.  They may
    be retained briefly so a live creation flow can recover, but must not keep
    uploads indefinitely when the browser is closed before publication.
    """
    from sqlalchemy import select

    from database import async_session
    from models.course import Course
    from models.user import User
    from routers.courses_crud import _purge_course

    retention_hours = max(settings.provisional_workspace_cleanup_hours, 1)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=retention_hours)
    async with async_session() as db:
        rows = list((await db.execute(
            select(Course, User)
            .join(User, User.id == Course.user_id)
            .where(Course.status == "SETUP", Course.updated_at < cutoff)
        )).all())
        for course, user in rows:
            await _purge_course(course.id, user, db)
        if rows:
            logger.info(
                "Removed %d stale provisional workspace(s) older than %d hour(s)",
                len(rows), retention_hours,
            )


async def _backfill_question_catalog() -> None:
    """Index existing course questions without changing their learning flow."""
    from database import async_session
    from services.question_catalog import backfill_question_catalog

    async with async_session() as db:
        created = await backfill_question_catalog(db)
    if created:
        logger.info("Indexed %d existing question(s) in the curriculum catalog", created)


def _maybe_start_scheduler() -> None:
    if not settings.app_run_scheduler:
        return

    from services.scheduler.engine import start_scheduler

    start_scheduler()
    logger.info("Scheduler started")


def _maybe_stop_scheduler() -> None:
    if not settings.app_run_scheduler:
        return

    from services.scheduler.engine import stop_scheduler

    stop_scheduler()
    logger.info("Scheduler stopped")


def _should_run_activity_engine() -> bool:
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return False
    return settings.app_run_activity_engine


def _maybe_start_activity_engine() -> None:
    if not _should_run_activity_engine():
        return

    from services.activity.engine import start_activity_engine

    start_activity_engine()
    logger.info("Activity engine started")


async def _maybe_stop_activity_engine() -> None:
    if not _should_run_activity_engine():
        return

    from services.activity.engine import stop_activity_engine

    await stop_activity_engine()
    logger.info("Activity engine stopped")




async def _detect_local_llm() -> None:
    """Detect local LLM providers (Ollama, LM Studio) on startup.

    If a provider is found and no explicit LLM is configured,
    auto-configure it so the user doesn't need to edit .env.
    Inspired by OpenClaw's auto-detection and AnythingLLM's provider discovery.
    """
    import asyncio

    detected: list[dict] = []

    async def _probe_ollama() -> dict | None:
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                resp = await client.get(f"{settings.ollama_base_url}/api/tags")
                if resp.status_code == 200:
                    models = resp.json().get("models", [])
                    return {"provider": "ollama", "url": settings.ollama_base_url, "models": [m.get("name", "?") for m in models]}
        except (httpx.HTTPError, OSError, ValueError) as exc:
            logger.debug("Ollama probe failed: %s", exc)
        return None

    async def _probe_lmstudio() -> dict | None:
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                resp = await client.get(f"{settings.lmstudio_base_url}/models")
                if resp.status_code == 200:
                    data = resp.json()
                    models = [m["id"] for m in data.get("data", [])]
                    return {"provider": "lmstudio", "url": settings.lmstudio_base_url, "models": models}
        except (httpx.HTTPError, OSError, ValueError) as exc:
            logger.debug("LM Studio probe failed: %s", exc)
        return None

    results = await asyncio.gather(_probe_ollama(), _probe_lmstudio(), return_exceptions=True)
    for r in results:
        if isinstance(r, dict) and r is not None:
            detected.append(r)

    if not detected:
        if settings.llm_provider.lower() in ("ollama", "lmstudio"):
            logger.warning(
                "No local LLM detected. Install Ollama (https://ollama.com) "
                "or set LLM_PROVIDER / API keys for a cloud provider."
            )
        return

    for p in detected:
        model_count = len(p["models"])
        names = ", ".join(p["models"][:5])
        if model_count > 0:
            logger.info(
                "%s detected at %s with %d model(s): %s",
                p["provider"].upper(), p["url"], model_count, names,
            )
        else:
            logger.warning(
                "%s is running at %s but has no models loaded.",
                p["provider"].upper(), p["url"],
            )


def _start_health_monitor() -> None:
    """Start background LLM health probe loop (OpenClaw pattern)."""
    from services.llm.router import get_registry

    registry = get_registry()
    registry.start_health_monitor(interval=30.0)


def _should_run_health_monitor() -> bool:
    """Disable health monitor in pytest to avoid cross-loop teardown races."""
    return not os.environ.get("PYTEST_CURRENT_TEST")


async def _stop_health_monitor() -> None:
    from services.llm.router import get_registry

    registry = get_registry()
    try:
        await registry.stop_health_monitor()
    except RuntimeError as exc:
        if "Event loop is closed" in str(exc):
            logger.debug("Skipping health monitor shutdown after loop closed")
            return
        raise


def _print_auth_warning() -> None:
    """Print a visible console warning when authentication is disabled."""
    if settings.auth_enabled:
        return
    logger.warning(
        "\n"
        "╔══════════════════════════════════════════════════════════════╗\n"
        "║  ⚠  AUTHENTICATION IS DISABLED (AUTH_ENABLED=false)        ║\n"
        "║                                                            ║\n"
        "║  This is fine for local single-user use.                   ║\n"
        "║  DO NOT expose this instance to the public internet.       ║\n"
        "║                                                            ║\n"
        "║  To enable auth:                                           ║\n"
        "║    1. Set AUTH_ENABLED=true in .env                        ║\n"
        "║    2. Set JWT_SECRET_KEY to a random string (>=32 chars)   ║\n"
        "╚══════════════════════════════════════════════════════════════╝"
    )


async def run_startup_hooks() -> None:
    _print_auth_warning()
    await _maybe_create_tables()
    await _maybe_bootstrap_migration_tracking()
    await _migrate_upload_storage_records()
    await _finalize_legacy_embedding_jobs()
    await _repair_orphaned_retry_jobs()
    await _repair_orphaned_dispatch_jobs()
    await _cleanup_stale_provisional_workspaces()
    await _backfill_question_catalog()
    await _maybe_seed_system_data()
    if _should_run_health_monitor():
        await _detect_local_llm()
    _maybe_start_scheduler()
    _maybe_start_activity_engine()
    if _should_run_health_monitor():
        _start_health_monitor()


async def run_shutdown_hooks() -> None:
    from services.agent.background_runtime import wait_for_background_tasks

    if _should_run_health_monitor():
        await _stop_health_monitor()
    await _maybe_stop_activity_engine()
    _maybe_stop_scheduler()
    await wait_for_background_tasks()
    await engine.dispose()


@asynccontextmanager
async def lifespan(_: object):
    os.makedirs(settings.upload_dir, exist_ok=True)
    await run_startup_hooks()
    yield
    await run_shutdown_hooks()
