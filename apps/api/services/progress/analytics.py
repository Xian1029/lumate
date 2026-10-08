"""Progress analytics — course-level summaries and error pattern analysis.

Split from tracker.py to separate analytics queries from core mastery tracking.
"""

import uuid
import logging

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from models.progress import LearningProgress
from models.content import CourseContentTree
from services.learning_progress import course_progress_snapshot, course_progress_view

logger = logging.getLogger(__name__)


async def get_course_progress(
    db: AsyncSession,
    user_id: uuid.UUID,
    course_id: uuid.UUID,
) -> dict:
    """Get overall progress for a course."""
    nodes_result = await db.execute(
        select(CourseContentTree).where(CourseContentTree.course_id == course_id)
    )
    nodes = list(nodes_result.scalars().all())

    progress_result = await db.execute(
        select(LearningProgress)
        .where(
            LearningProgress.user_id == user_id,
            LearningProgress.course_id == course_id,
        )
    )
    progress_entries = progress_result.scalars().all()

    snapshot = course_progress_snapshot(nodes, progress_entries)
    learning_progress = course_progress_view(snapshot)
    # Keep all progress analytics on the same learnable-node denominator used
    # by the home learning-space cards.
    mastered = sum(1 for p in snapshot.progress_by_node.values() if p.status == "mastered")
    reviewed = sum(1 for p in snapshot.progress_by_node.values() if p.status == "reviewed")
    in_progress = sum(1 for p in snapshot.progress_by_node.values() if p.status == "in_progress")
    total_time = sum(p.time_spent_minutes for p in progress_entries)
    avg_mastery = (
        sum(p.mastery_score for p in progress_entries) / len(progress_entries)
        if progress_entries else 0.0
    )
    gap_type_breakdown: dict[str, int] = {}
    for entry in progress_entries:
        if entry.gap_type:
            gap_type_breakdown[entry.gap_type] = gap_type_breakdown.get(entry.gap_type, 0) + 1

    return {
        "course_id": str(course_id),
        # Canonical learner-facing contract. Keep the legacy analytics fields
        # below for charts, but no UI should recalculate completion itself.
        "learning_progress": learning_progress,
        "total_nodes": snapshot.total_count,
        "mastered": mastered,
        "reviewed": reviewed,
        "in_progress": in_progress,
        "not_started": max(0, snapshot.total_count - mastered - reviewed - in_progress),
        "total_study_minutes": total_time,
        "average_mastery": avg_mastery,
        "completion_percent": learning_progress["progress_percent"] or 0,
        "gap_type_breakdown": gap_type_breakdown,
    }


async def get_error_pattern_summary(
    db: AsyncSession,
    user_id: uuid.UUID,
    course_id: uuid.UUID,
    limit: int = 5,
) -> list[dict]:
    """Return top error categories by frequency for a user+course.

    Aggregates unmastered WrongAnswer entries grouped by error_category.
    Returns: [{"category": str, "count": int, "percentage": float}]
    """
    from models.ingestion import WrongAnswer

    result = await db.execute(
        select(WrongAnswer.error_category, func.count(WrongAnswer.id).label("cnt"))
        .where(
            WrongAnswer.user_id == user_id,
            WrongAnswer.course_id == course_id,
            WrongAnswer.mastered.is_(False),
            WrongAnswer.error_category.isnot(None),
        )
        .group_by(WrongAnswer.error_category)
        .order_by(func.count(WrongAnswer.id).desc())
        .limit(limit)
    )
    rows = result.all()
    total = sum(r.cnt for r in rows)
    return [
        {
            "category": r.error_category,
            "count": r.cnt,
            "percentage": round(r.cnt / max(total, 1) * 100, 1),
        }
        for r in rows
    ]
