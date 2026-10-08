"""Shared learner-facing progress and resume-context read model.

The homepage and a learning space must not independently decide what counts as
learning.  This module deliberately separates *course material processing*
from *student learning progress*: only leaf, teachable content nodes count in
the denominator, and only a session on one of those nodes can become a resume
location.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable
import uuid

from models.content import CourseContentTree, INFO_CATEGORIES
from models.ingestion import StudySession
from models.progress import LearningProgress
from services.content_text import is_body_content


# These categories are document structure / logistics, never a student lesson.
NON_LEARNING_CATEGORIES = INFO_CATEGORIES | {"reference", "other"}


@dataclass(frozen=True)
class CourseProgressSnapshot:
    learnable_nodes: list[CourseContentTree]
    progress_by_node: dict[uuid.UUID, LearningProgress]
    completed_count: int
    total_count: int

    @property
    def percent(self) -> int | None:
        return round(self.completed_count / self.total_count * 100) if self.total_count else None


def learnable_leaf_nodes(nodes: Iterable[CourseContentTree]) -> list[CourseContentTree]:
    """Return exactly the nodes that may represent a completed learning unit.

    Parsed covers, front matter, table of contents and appendix pages used to
    enter this list because they are leaves.  The title/body check keeps those
    source records available in the textbook while excluding them from student
    progress and resume suggestions.
    """
    node_list = list(nodes)
    parent_ids = {node.parent_id for node in node_list if node.parent_id is not None}
    return sorted(
        [
            node for node in node_list
            if node.id not in parent_ids
            and (node.content_category or "").lower() not in NON_LEARNING_CATEGORIES
            # Some legacy parsed trees store body text in generated blocks and
            # leave ``content`` empty.  Use a harmless body sentinel for the
            # title/front-matter check so we do not erase their real lessons.
            and is_body_content(node.title, node.content or "学习内容")
        ],
        key=lambda node: (node.level, getattr(node, "order_index", 0), node.title),
    )


def course_progress_snapshot(
    nodes: Iterable[CourseContentTree],
    progress_rows: Iterable[LearningProgress],
) -> CourseProgressSnapshot:
    learnable = learnable_leaf_nodes(nodes)
    ids = {node.id for node in learnable}
    by_node = {row.content_node_id: row for row in progress_rows if row.content_node_id in ids}
    completed = sum(1 for row in by_node.values() if row.status == "mastered")
    return CourseProgressSnapshot(learnable, by_node, completed, len(learnable))


def course_progress_view(snapshot: CourseProgressSnapshot) -> dict[str, int | None]:
    """Return the one learner-facing progress contract for a learning space.

    Home cards, the knowledge-graph path, and future course views must not
    recompute or rename completion numbers independently.  This view is based
    only on the canonical snapshot: mastered learnable leaf nodes divided by
    all learnable leaf nodes.  It deliberately excludes ingestion, task, and
    mastery-quality percentages.
    """
    return {
        "completed_learning_items": snapshot.completed_count,
        "total_learning_items": snapshot.total_count,
        "progress_percent": snapshot.percent,
    }


def aggregate_course_progress_views(views: Iterable[dict[str, int | None]]) -> dict[str, int | None]:
    """Aggregate workspace progress by learning-unit count, never by averaging percentages."""
    completed = sum(int(view.get("completed_learning_items") or 0) for view in views)
    total = sum(int(view.get("total_learning_items") or 0) for view in views)
    return {
        "completed_learning_items": completed,
        "total_learning_items": total,
        "progress_percent": round(completed / total * 100) if total else None,
    }


def latest_valid_session(
    sessions: Iterable[StudySession],
    learnable_node_ids: set[uuid.UUID],
) -> StudySession | None:
    """Find a real resume context, ignoring course-home heartbeats and metadata.

    A session needs both a real teachable node and an actual interaction.  The
    latter condition protects the resume card from route preloads/initializers
    that happen to create an empty session.
    """
    candidates = [
        session for session in sessions
        if session.content_node_id in learnable_node_ids
        and ((session.active_seconds or 0) > 0 or (session.duration_minutes or 0) > 0
             or bool(session.activity_breakdown) or session.status == "completed")
    ]
    return max(
        candidates,
        key=lambda session: session.last_activity_at or session.started_at,
        default=None,
    )
