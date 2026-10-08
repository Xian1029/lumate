"""Course CRUD endpoints: list, create, get, update, delete, content tree."""

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from sqlalchemy import delete, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import Base, get_db
from models.agent_task import AgentTask
from models.course import Course
from models.content import CourseContentTree
from models.chat_session import ChatSession
from models.chat_message import ChatMessageLog
from models.ingestion import IngestionJob
from models.knowledge_graph import ConceptMastery, KnowledgeEdge, KnowledgeNode
from models.practice import PracticeProblem, PracticeResult
from models.study_goal import StudyGoal
from models.learning_plan import LearningPlan, LearningPlanStatus
from models.learning_task import LearningTask, LearningTaskStatus
from models.user import User
from schemas.course import CourseCreate, CourseOverviewCard, CourseResponse, ContentNodeResponse, CourseUpdate
from services.auth.dependency import get_current_user
from services.course_access import get_course_or_404
from services.upload_storage import resolve_upload_path
from services.content_text import (
    clean_course_text,
    clean_course_title,
    normalize_pdf_markdown,
    split_embedded_heading_from_title,
)

logger = logging.getLogger(__name__)

router = APIRouter()

DEFAULT_USER_NAME = "Local User"


def _serialize_content_tree(nodes: list[CourseContentTree]) -> list[ContentNodeResponse]:
    by_parent: dict[uuid.UUID | None, list[CourseContentTree]] = {}
    for node in nodes:
        by_parent.setdefault(node.parent_id, []).append(node)

    for siblings in by_parent.values():
        siblings.sort(key=lambda item: (item.order_index, item.created_at))

    def build(node: CourseContentTree) -> ContentNodeResponse:
        return ContentNodeResponse(
            id=node.id,
            # Defensive read-time cleanup protects courses imported before the
            # ingestion fix was introduced.
            title=clean_course_title(node.title),
            content=clean_course_text(node.content),
            level=node.level,
            order_index=node.order_index,
            source_type=node.source_type,
            source_file=getattr(node, "source_file", None),
            content_category=getattr(node, "content_category", None),
            children=[build(child) for child in by_parent.get(node.id, [])],
        )

    return [build(node) for node in by_parent.get(None, [])]


async def get_or_create_user(db: AsyncSession) -> User:
    """Get or create the single local user."""
    result = await db.execute(select(User).limit(1))
    user = result.scalar_one_or_none()
    if not user:
        user = User(name=DEFAULT_USER_NAME)
        db.add(user)
        await db.commit()
        await db.refresh(user)
    return user


@router.get("/", response_model=list[CourseResponse], summary="List all courses", description="Return all courses for the current user, ordered by creation date.")
async def list_courses(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Course).where(Course.user_id == user.id, Course.status == "ACTIVE").order_by(Course.created_at.desc())
    )
    return result.scalars().all()


@router.get("/overview", response_model=list[CourseOverviewCard], summary="List course overview cards", description="Return enriched course cards with file counts, goals, and agent activity.")
async def list_course_overview(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    file_counts = (
        select(
            IngestionJob.course_id.label("course_id"),
            func.count(IngestionJob.id).label("file_count"),
        )
        .where(IngestionJob.user_id == user.id)
        .group_by(IngestionJob.course_id)
        .subquery()
    )
    content_counts = (
        select(
            CourseContentTree.course_id.label("course_id"),
            func.count(CourseContentTree.id).label("content_node_count"),
        )
        .group_by(CourseContentTree.course_id)
        .subquery()
    )
    goal_counts = (
        select(
            StudyGoal.course_id.label("course_id"),
            func.count(StudyGoal.id).label("active_goal_count"),
        )
        .where(StudyGoal.status == "active", StudyGoal.user_id == user.id)
        .group_by(StudyGoal.course_id)
        .subquery()
    )
    # These overview fields are learner-facing.  They must describe the
    # authoritative LearningPlan domain, not technical AgentTask execution.
    pending_tasks = (
        select(
            LearningTask.course_id.label("course_id"),
            func.count(LearningTask.id).label("pending_task_count"),
        )
        .join(LearningPlan, LearningPlan.id == LearningTask.plan_id)
        .where(LearningPlan.user_id == user.id, LearningPlan.status == LearningPlanStatus.ACTIVE.value, LearningTask.status.in_((LearningTaskStatus.PENDING.value, LearningTaskStatus.READY.value, LearningTaskStatus.IN_PROGRESS.value, LearningTaskStatus.POSTPONED.value, LearningTaskStatus.MISSED.value)))
        .group_by(LearningTask.course_id)
        .subquery()
    )
    pending_approvals = (
        select(
            LearningPlan.course_id.label("course_id"),
            func.count(LearningPlan.id).label("pending_approval_count"),
        )
        .where(LearningPlan.user_id == user.id, LearningPlan.status == LearningPlanStatus.PENDING_APPROVAL.value)
        .group_by(LearningPlan.course_id)
        .subquery()
    )
    last_activity = (
        select(
            AgentTask.course_id.label("course_id"),
            func.max(AgentTask.updated_at).label("last_agent_activity_at"),
        )
        .where(AgentTask.user_id == user.id)
        .group_by(AgentTask.course_id)
        .subquery()
    )
    latest_scene_id = (
        select(ChatSession.scene_id)
        .where(ChatSession.course_id == Course.id)
        .order_by(ChatSession.updated_at.desc(), ChatSession.created_at.desc())
        .limit(1)
        .scalar_subquery()
    )

    result = await db.execute(
        select(
            Course.id,
            Course.name,
            Course.description,
            Course.metadata_.label("metadata"),
            Course.created_at,
            Course.updated_at,
            func.coalesce(file_counts.c.file_count, literal(0)).label("file_count"),
            func.coalesce(content_counts.c.content_node_count, literal(0)).label("content_node_count"),
            func.coalesce(goal_counts.c.active_goal_count, literal(0)).label("active_goal_count"),
            func.coalesce(pending_tasks.c.pending_task_count, literal(0)).label("pending_task_count"),
            func.coalesce(pending_approvals.c.pending_approval_count, literal(0)).label("pending_approval_count"),
            last_activity.c.last_agent_activity_at,
            func.coalesce(latest_scene_id, Course.active_scene).label("last_scene_id"),
        )
        .select_from(Course)
        .outerjoin(file_counts, file_counts.c.course_id == Course.id)
        .outerjoin(content_counts, content_counts.c.course_id == Course.id)
        .outerjoin(goal_counts, goal_counts.c.course_id == Course.id)
        .outerjoin(pending_tasks, pending_tasks.c.course_id == Course.id)
        .outerjoin(pending_approvals, pending_approvals.c.course_id == Course.id)
        .outerjoin(last_activity, last_activity.c.course_id == Course.id)
        .where(Course.user_id == user.id, Course.status == "ACTIVE")
        .order_by(Course.updated_at.desc(), Course.created_at.desc())
    )

    return [
        CourseOverviewCard(
            id=row.id,
            name=row.name,
            description=row.description,
            metadata=row.metadata,
            created_at=row.created_at,
            updated_at=row.updated_at,
            file_count=int(row.file_count or 0),
            content_node_count=int(row.content_node_count or 0),
            active_goal_count=int(row.active_goal_count or 0),
            pending_task_count=int(row.pending_task_count or 0),
            pending_approval_count=int(row.pending_approval_count or 0),
            last_agent_activity_at=row.last_agent_activity_at,
        last_scene_id=row.last_scene_id,
            status="ACTIVE",
            deleted_at=None,
        )
        for row in result.all()
    ]


# These static paths are registered before /{course_id}, otherwise a UUID
# parameter route would consume the word "trash".
@router.get("/trash", response_model=list[CourseResponse], summary="List trashed learning spaces")
async def list_trashed_courses(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Course).where(Course.user_id == user.id, Course.status == "TRASHED").order_by(Course.deleted_at.desc()))
    return result.scalars().all()


@router.post("/trash/{course_id}/restore", response_model=CourseResponse, summary="Restore learning space")
async def restore_course(course_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Course).where(Course.id == course_id, Course.user_id == user.id, Course.status == "TRASHED"))
    course = result.scalar_one_or_none()
    if course is None:
        from libs.exceptions import NotFoundError
        raise NotFoundError("Trashed course", course_id)
    course.status, course.deleted_at = "ACTIVE", None
    await db.commit()
    await db.refresh(course)
    return course


@router.delete("/trash/{course_id}", status_code=204, summary="Permanently delete trashed learning space")
async def permanently_delete_trashed_course(course_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Course).where(Course.id == course_id, Course.user_id == user.id, Course.status == "TRASHED"))
    course = result.scalar_one_or_none()
    if course is None:
        from libs.exceptions import NotFoundError
        raise NotFoundError("Trashed course", course_id)
    await _purge_course(course_id, user, db)


@router.delete("/trash", status_code=204, summary="Empty learning-space trash")
async def empty_course_trash(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    ids = (await db.execute(select(Course.id).where(Course.user_id == user.id, Course.status == "TRASHED"))).scalars().all()
    for course_id in ids:
        await _purge_course(course_id, user, db)


@router.post("/", response_model=CourseResponse, status_code=201, summary="Create a course", description="Create a new course for the current user.")
async def create_course(body: CourseCreate, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    course = Course(
        user_id=user.id,
        name=body.name,
        description=body.description,
        metadata_=body.metadata.model_dump(exclude_none=True) if body.metadata else None,
        status=body.status,
    )
    db.add(course)
    await db.commit()
    await db.refresh(course)
    return course


@router.post("/{course_id}/activate", response_model=CourseResponse, summary="Publish a parsed learning space")
async def activate_course(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Make a successfully reviewed setup space visible to the learner."""
    result = await db.execute(
        select(Course).where(Course.id == course_id, Course.user_id == user.id, Course.status == "SETUP")
    )
    course = result.scalar_one_or_none()
    if not course:
        # ACTIVE is intentionally idempotent so a double click cannot fail the
        # final step of an otherwise completed creation flow.
        return await get_course_or_404(db, course_id, user_id=user.id)
    course.status = "ACTIVE"
    await db.commit()
    await db.refresh(course)
    return course


@router.delete("/{course_id}/setup", status_code=204, summary="Cancel a provisional learning space")
async def cancel_setup_course(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove only an unpublished setup space and its unreferenced uploads."""
    course = (await db.execute(select(Course).where(
        Course.id == course_id, Course.user_id == user.id, Course.status == "SETUP"
    ))).scalar_one_or_none()
    if course is None:
        from libs.exceptions import NotFoundError
        raise NotFoundError("Provisional learning space", course_id)
    await _purge_course(course_id, user, db)


@router.get("/{course_id}", response_model=CourseResponse, summary="Get a course", description="Return a single course by ID for the current user.")
async def get_course(course_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await get_course_or_404(db, course_id, user_id=user.id)


@router.patch("/{course_id}", response_model=CourseResponse, summary="Update a course", description="Partially update course name, description, or metadata.")
async def update_course(
    course_id: uuid.UUID,
    body: CourseUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    course = await get_course_or_404(db, course_id, user_id=user.id)
    if body.name is not None:
        course.name = body.name
    if body.description is not None:
        course.description = body.description
    if body.metadata is not None:
        existing_metadata = dict(course.metadata_ or {})
        incoming_metadata = body.metadata.model_dump(exclude_none=True)
        existing_metadata.update(incoming_metadata)
        course.metadata_ = existing_metadata
    await db.commit()
    await db.refresh(course)
    return course


@router.get("/{course_id}/layout", summary="Get workspace layout", description="Return the saved workspace layout from course metadata.")
async def get_layout(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the saved workspace layout configuration from course metadata."""
    course = await get_course_or_404(db, course_id, user_id=user.id)
    metadata = course.metadata_ or {}
    return metadata.get("spaceLayout", {})


@router.patch("/{course_id}/layout", summary="Update workspace layout", description="Save the workspace layout configuration in course metadata.")
async def update_layout(
    course_id: uuid.UUID,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update the workspace layout configuration stored in course metadata."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    from services.workspace_layout import WorkspaceLayoutService
    body = WorkspaceLayoutService.normalize(body)
    course = await get_course_or_404(db, course_id, user_id=user.id)
    metadata = dict(course.metadata_ or {})
    metadata["spaceLayout"] = body
    mode = body.get("mode")
    if isinstance(mode, str) and mode:
        metadata["learning_mode"] = mode
    course.metadata_ = metadata
    await db.commit()
    await db.refresh(course)
    return {"status": "ok", "layout": body}


@router.get("/{course_id}/content-tree", response_model=list[ContentNodeResponse], summary="Get course content tree", description="Return the hierarchical content tree for a course.")
async def get_content_tree(course_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get the full content tree for a course (top-level nodes with children)."""
    await get_course_or_404(db, course_id, user_id=user.id)
    result = await db.execute(
        select(CourseContentTree)
        .where(CourseContentTree.course_id == course_id)
        .order_by(CourseContentTree.level, CourseContentTree.order_index, CourseContentTree.created_at)
    )
    return _serialize_content_tree(result.scalars().all())


@router.post("/{course_id}/repair-imported-text", summary="Repair imported course text")
async def repair_imported_text(course_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Persistently remove invisible PDF extraction artefacts from one course.

    This is idempotent and deliberately conservative: it only removes control
    characters and invisible formatting marks, never rewrites lesson content.
    """
    await get_course_or_404(db, course_id, user_id=user.id)
    result = await db.execute(
        select(CourseContentTree).where(CourseContentTree.course_id == course_id)
    )
    repaired_nodes = 0
    repaired_titles = 0
    repaired_contents = 0
    for node in result.scalars():
        title, embedded_heading = split_embedded_heading_from_title(node.title)
        content = normalize_pdf_markdown(node.content)
        if embedded_heading:
            content = normalize_pdf_markdown(f"{embedded_heading}\n\n{content or ''}")
        changed = False
        if title != node.title:
            node.title = title
            repaired_titles += 1
            changed = True
        if content != node.content:
            node.content = content
            repaired_contents += 1
            changed = True
        if changed:
            repaired_nodes += 1

    if repaired_nodes:
        await db.commit()

    return {
        "status": "ok",
        "course_id": str(course_id),
        "repaired_nodes": repaired_nodes,
        "repaired_titles": repaired_titles,
        "repaired_contents": repaired_contents,
    }


@router.get("/{course_id}/course-info", summary="Get course info summary", description="Return structured course info: grading scheme, assignments, deadlines, quiz details.")
async def get_course_info(course_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Extract and summarize information-type content (syllabus, assignments, quizzes)."""
    from models.ingestion import Assignment

    await get_course_or_404(db, course_id, user_id=user.id)

    # Get syllabus content nodes (assignments listing, quizzes, etc.)
    syllabus_result = await db.execute(
        select(CourseContentTree)
        .where(
            CourseContentTree.course_id == course_id,
            CourseContentTree.content_category == "syllabus",
            CourseContentTree.content.isnot(None),
        )
        .order_by(CourseContentTree.order_index)
    )
    syllabus_nodes = syllabus_result.scalars().all()

    # Get assignments from dedicated table
    assignments_result = await db.execute(
        select(Assignment)
        .where(Assignment.course_id == course_id)
        .order_by(Assignment.due_date.asc().nullslast())
    )
    assignments = assignments_result.scalars().all()

    # Build grading info from "Assignments" summary node
    grading_items = []
    for node in syllabus_nodes:
        if node.title == "Assignments" and node.content:
            import re
            # Parse lines like: "**Short Assignment 1** (due: 2026-03-22) [12.0 pts]"
            for match in re.finditer(
                r"\*\*(.+?)\*\*\s*\(due:\s*([^)]+)\)\s*\[([0-9.]+)\s*pts?\]",
                node.content,
            ):
                grading_items.append({
                    "title": match.group(1).strip(),
                    "due_date": match.group(2).strip(),
                    "points": float(match.group(3)),
                })
            break

    # Build quiz info
    quizzes = []
    for node in syllabus_nodes:
        if "quiz" in node.title.lower() and "reference" not in node.title.lower():
            quizzes.append({
                "title": node.title,
                "content": (node.content or "")[:500],
            })

    # Build assignment list from DB
    assignment_list = [
        {
            "title": a.title,
            "type": a.assignment_type,
            "due_date": str(a.due_date) if a.due_date else None,
            "description": (a.description or "")[:200],
        }
        for a in assignments
    ]

    return {
        "grading_scheme": grading_items,
        "quizzes": quizzes,
        "assignments": assignment_list,
        "syllabus_node_count": len(syllabus_nodes),
    }


async def _purge_course(course_id: uuid.UUID, user: User, db: AsyncSession) -> None:
    """Transactionally remove a trashed course and all course-scoped data."""
    # Purge operates on TRASHED rows, which the normal course-access helper
    # intentionally hides from all learning routes.
    course = (await db.execute(select(Course).where(Course.id == course_id, Course.user_id == user.id))).scalar_one_or_none()
    if course is None:
        from libs.exceptions import NotFoundError
        raise NotFoundError("Course", course_id)

    # Some child tables do not carry course_id themselves.  Newer databases
    # cascade these foreign keys, but older local SQLite databases may not.  In
    # that case deleting the parent course used to fail with a foreign-key
    # error, leaving the space visible. Clean these dependent rows first.
    session_ids = select(ChatSession.id).where(ChatSession.course_id == course_id)
    await db.execute(delete(ChatMessageLog).where(ChatMessageLog.session_id.in_(session_ids)))

    problem_ids = select(PracticeProblem.id).where(PracticeProblem.course_id == course_id)
    await db.execute(delete(PracticeResult).where(PracticeResult.problem_id.in_(problem_ids)))

    knowledge_node_ids = select(KnowledgeNode.id).where(KnowledgeNode.course_id == course_id)
    await db.execute(delete(ConceptMastery).where(ConceptMastery.knowledge_node_id.in_(knowledge_node_ids)))
    await db.execute(
        delete(KnowledgeEdge).where(
            or_(
                KnowledgeEdge.source_id.in_(knowledge_node_ids),
                KnowledgeEdge.target_id.in_(knowledge_node_ids),
            )
        )
    )

    file_paths = set(
        (await db.execute(
            select(IngestionJob.file_path).where(
                IngestionJob.course_id == course_id,
                IngestionJob.file_path.is_not(None),
            )
        )).scalars().all()
    )
    other_paths = set(
        (await db.execute(
            select(IngestionJob.file_path).where(
                IngestionJob.course_id != course_id,
                IngestionJob.file_path.is_not(None),
            )
        )).scalars().all()
    )
    shared_files = {
        resolved
        for raw_path in other_paths
        if (resolved := resolve_upload_path(raw_path, settings.upload_dir)) is not None
    }

    # Several legacy SQLite schemas predate ON DELETE CASCADE. Delete every
    # course-scoped table in reverse dependency order so populated spaces can
    # be removed atomically without leaving orphaned learning data.
    for table in reversed(Base.metadata.sorted_tables):
        if table.name == Course.__tablename__ or "course_id" not in table.c:
            continue
        await db.execute(delete(table).where(table.c.course_id == course_id))

    await db.execute(
        delete(Course).where(Course.id == course_id, Course.user_id == user.id)
    )
    await db.commit()

    for raw_path in file_paths:
        file_path = resolve_upload_path(raw_path, settings.upload_dir)
        if file_path is None:
            logger.warning("Skipped missing or unmanaged course file: %s", raw_path)
            continue
        if file_path in shared_files:
            continue
        try:
            file_path.unlink(missing_ok=True)
        except OSError:
            logger.exception("Failed to remove deleted course file: %s", file_path)


@router.delete("/{course_id}", status_code=204, summary="Move a course to trash", description="Recoverably move a learning space to trash.")
async def delete_course(course_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    course = await get_course_or_404(db, course_id, user_id=user.id)
    if course.status != "TRASHED":
        course.status = "TRASHED"
        course.deleted_at = datetime.now(timezone.utc)
        await db.commit()
