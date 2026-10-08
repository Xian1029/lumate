"""Progress tracking — core progress endpoints (CRUD, overview)."""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models.course import Course
from models.content import CourseContentTree
from models.ingestion import StudySession, StudySessionHeartbeat, WrongAnswer
from models.practice import PracticeProblem
from models.progress import LearningProgress
from models.user import User
from services.auth.dependency import get_current_user
from services.course_access import get_course_or_404
from services.learning_progress import NON_LEARNING_CATEGORIES
from services.content_text import is_body_content

from routers.progress_analytics import router as analytics_router
from routers.progress_knowledge import router as knowledge_router

router = APIRouter()

# Include sub-routers so all endpoints remain under /api/progress
router.include_router(analytics_router)
router.include_router(knowledge_router)


def _active_seconds(session: StudySession) -> int:
    """Prefer focused seconds, while retaining pre-migration session history."""
    if session.active_seconds:
        return session.active_seconds
    return (session.duration_minutes or 0) * 60


class StudyHeartbeatRequest(BaseModel):
    heartbeat_id: str = Field(min_length=8, max_length=64)
    client_session_id: str = Field(min_length=8, max_length=64)
    course_id: uuid.UUID
    content_node_id: uuid.UUID | None = None
    target_module: str | None = Field(default=None, max_length=30)
    active_seconds: int = Field(ge=0, le=120)
    elapsed_seconds: int = Field(ge=0, le=300)
    last_activity_at: datetime | None = None
    activity_breakdown: dict[str, int] = Field(default_factory=dict)
    ended: bool = False


@router.post("/study-sessions/heartbeat", summary="Record effective study time")
async def record_study_heartbeat(
    body: StudyHeartbeatRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Idempotently add focused seconds from one active browser tab."""
    await get_course_or_404(db, body.course_id, user_id=user.id)

    duplicate = await db.get(StudySessionHeartbeat, body.heartbeat_id)
    if duplicate:
        session = await db.get(StudySession, duplicate.session_id)
        return {
            "session_id": str(duplicate.session_id),
            "active_seconds": session.active_seconds if session else 0,
            "duplicate": True,
        }

    content_node_id = body.content_node_id
    if content_node_id:
        node_result = await db.execute(
            select(CourseContentTree).where(
                CourseContentTree.id == content_node_id,
                CourseContentTree.course_id == body.course_id,
            )
        )
        node = node_result.scalar_one_or_none()
        # Front matter/contents may be opened in the original textbook but
        # must never become the student's LastLearningContext.
        if (
            node is None
            or (node.content_category or "").lower() in NON_LEARNING_CATEGORIES
            or not is_body_content(node.title, node.content or "学习内容")
        ):
            content_node_id = None

    session_result = await db.execute(
        select(StudySession).where(
            StudySession.user_id == user.id,
            StudySession.course_id == body.course_id,
            StudySession.client_session_id == body.client_session_id,
        )
    )
    session = session_result.scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if session is None:
        session = StudySession(
            user_id=user.id,
            course_id=body.course_id,
            content_node_id=content_node_id,
            target_module=body.target_module,
            client_session_id=body.client_session_id,
            active_seconds=0,
            elapsed_seconds=0,
            status="active",
            activity_breakdown={},
        )
        db.add(session)
        await db.flush()

    # One focused session is capped at two hours; a later visit receives a new
    # client session after the inactivity gap.
    remaining_active = max(0, 2 * 60 * 60 - (session.active_seconds or 0))
    active_delta = min(body.active_seconds, body.elapsed_seconds, remaining_active)
    session.active_seconds = (session.active_seconds or 0) + active_delta
    session.elapsed_seconds = (session.elapsed_seconds or 0) + body.elapsed_seconds
    session.duration_minutes = session.active_seconds // 60
    session.last_activity_at = body.last_activity_at or now
    session.content_node_id = content_node_id or session.content_node_id
    # A course-level heartbeat may add time, but must not erase a more precise
    # module captured by this session.
    session.target_module = body.target_module or session.target_module

    breakdown = dict(session.activity_breakdown or {})
    unassigned = active_delta
    for activity, seconds in body.activity_breakdown.items():
        if activity not in {"reading", "notes", "practice", "review", "graph"}:
            continue
        assigned = max(0, min(int(seconds), unassigned))
        breakdown[activity] = int(breakdown.get(activity, 0)) + assigned
        unassigned -= assigned
        if unassigned <= 0:
            break
    session.activity_breakdown = breakdown

    if body.ended:
        session.status = "completed"
        session.ended_at = now
    else:
        session.status = "active"

    db.add(
        StudySessionHeartbeat(
            id=body.heartbeat_id,
            session_id=session.id,
            active_seconds=active_delta,
            elapsed_seconds=body.elapsed_seconds,
        )
    )
    await db.commit()
    return {
        "session_id": str(session.id),
        "active_seconds": session.active_seconds,
        "duplicate": False,
    }


# ── Progress Endpoints ──


@router.get("/courses/{course_id}", summary="Get course progress", description="Return learning progress overview for a specific course.")
async def get_course_progress(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get learning progress overview for a course."""
    from services.progress.analytics import get_course_progress as get_course_progress_summary

    return await get_course_progress_summary(db, user.id, course_id)


@router.get("/overview", summary="Get learning overview", description="Return aggregate cross-course learning analytics for the current user.")
async def get_learning_overview(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Aggregate cross-course learning analytics for the current user."""
    course_result = await db.execute(
        select(Course).where(Course.user_id == user.id).order_by(Course.created_at.desc())
    )
    courses = course_result.scalars().all()
    course_ids = [course.id for course in courses]
    if not course_ids:
        return {
            "total_courses": 0,
            "total_study_minutes": 0,
            "average_mastery": 0.0,
            "gap_type_breakdown": {},
            "diagnosis_breakdown": {},
            "error_category_breakdown": {},
            "course_summaries": [],
        }

    progress_result = await db.execute(
        select(LearningProgress).where(
            LearningProgress.user_id == user.id,
            LearningProgress.course_id.in_(course_ids),
        )
    )
    progress_rows = progress_result.scalars().all()

    wrong_result = await db.execute(
        select(WrongAnswer, PracticeProblem)
        .join(PracticeProblem, WrongAnswer.problem_id == PracticeProblem.id)
        .where(
            WrongAnswer.user_id == user.id,
            WrongAnswer.course_id.in_(course_ids),
        )
    )
    wrong_rows = wrong_result.all()

    session_result = await db.execute(
        select(StudySession).where(
            StudySession.user_id == user.id,
            StudySession.course_id.in_(course_ids),
        )
    )
    sessions = session_result.scalars().all()

    gap_type_breakdown: dict[str, int] = {}
    diagnosis_breakdown: dict[str, int] = {}
    error_category_breakdown: dict[str, int] = {}
    progress_by_course: dict[uuid.UUID, list[LearningProgress]] = {course_id: [] for course_id in course_ids}
    wrong_by_course: dict[uuid.UUID, list[WrongAnswer]] = {course_id: [] for course_id in course_ids}
    session_by_course: dict[uuid.UUID, list[StudySession]] = {course_id: [] for course_id in course_ids}

    for progress in progress_rows:
        progress_by_course.setdefault(progress.course_id, []).append(progress)
        if progress.gap_type:
            gap_type_breakdown[progress.gap_type] = gap_type_breakdown.get(progress.gap_type, 0) + 1

    for wrong_answer, _problem in wrong_rows:
        wrong_by_course.setdefault(wrong_answer.course_id, []).append(wrong_answer)
        if wrong_answer.diagnosis:
            diagnosis_breakdown[wrong_answer.diagnosis] = diagnosis_breakdown.get(wrong_answer.diagnosis, 0) + 1
        if wrong_answer.error_category:
            error_category_breakdown[wrong_answer.error_category] = error_category_breakdown.get(wrong_answer.error_category, 0) + 1

    for session in sessions:
        session_by_course.setdefault(session.course_id, []).append(session)

    course_summaries = []
    all_mastery_scores = [row.mastery_score for row in progress_rows]
    total_study_minutes = sum(_active_seconds(session) for session in sessions) // 60

    for course in courses:
        course_progress = progress_by_course.get(course.id, [])
        course_wrong = wrong_by_course.get(course.id, [])
        course_sessions = session_by_course.get(course.id, [])
        avg_mastery = (
            sum(item.mastery_score for item in course_progress) / len(course_progress)
            if course_progress else 0.0
        )
        course_summaries.append(
            {
                "course_id": str(course.id),
                "course_name": course.name,
                "average_mastery": avg_mastery,
                "study_minutes": sum(_active_seconds(item) for item in course_sessions) // 60,
                "wrong_answers": len(course_wrong),
                "diagnosed_count": sum(1 for item in course_wrong if item.diagnosis),
                "gap_types": {
                    gap: sum(1 for item in course_progress if item.gap_type == gap)
                    for gap in {item.gap_type for item in course_progress if item.gap_type}
                },
            }
        )

    return {
        "total_courses": len(courses),
        "total_study_minutes": total_study_minutes,
        "average_mastery": (
            sum(all_mastery_scores) / len(all_mastery_scores) if all_mastery_scores else 0.0
        ),
        "gap_type_breakdown": gap_type_breakdown,
        "diagnosis_breakdown": diagnosis_breakdown,
        "error_category_breakdown": error_category_breakdown,
        "course_summaries": course_summaries,
    }
