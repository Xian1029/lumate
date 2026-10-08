"""Portable and secure access to files managed by the upload directory."""

from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.ingestion import IngestionJob

logger = logging.getLogger(__name__)


def upload_record_path(file_path: str, upload_root: str) -> str:
    """Return a portable database value for a file in the upload directory."""
    root = Path(upload_root).expanduser().resolve()
    candidate = Path(file_path).expanduser()
    resolved = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
    if resolved.is_relative_to(root):
        return resolved.relative_to(root).as_posix()
    return str(file_path)


def resolve_upload_path(stored_path: str, upload_root: str) -> Path | None:
    """Resolve an existing managed upload, including relocated legacy records."""
    root = Path(upload_root).expanduser().resolve()
    raw = Path(stored_path).expanduser()
    recorded = raw.resolve() if raw.is_absolute() else (root / raw).resolve()
    candidates = [recorded]
    legacy_relocated = (root / raw.name).resolve()
    if legacy_relocated != recorded:
        candidates.append(legacy_relocated)

    for candidate in candidates:
        if candidate.is_relative_to(root) and candidate.is_file():
            return candidate
    return None


async def migrate_legacy_upload_paths(db: AsyncSession, upload_root: str) -> int:
    """Rewrite resolvable legacy absolute paths to portable relative paths."""
    result = await db.execute(
        select(IngestionJob).where(IngestionJob.file_path.is_not(None))
    )
    migrated = 0
    for job in result.scalars():
        resolved = resolve_upload_path(job.file_path, upload_root)
        if resolved is None:
            continue
        portable = upload_record_path(str(resolved), upload_root)
        if job.file_path != portable:
            job.file_path = portable
            migrated += 1

    if migrated:
        await db.commit()
        logger.info("Migrated %d upload path(s) to portable storage records", migrated)
    return migrated
