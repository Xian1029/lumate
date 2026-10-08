"""Read models for learning-plan UI and the personal learning home.

The home page consumes ``/overview`` as a single view model.  Keeping the
selection and ordering here prevents the browser from inventing a second
"today" or "continue learning" rule.
"""

from datetime import date, datetime, timezone
import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models.course import Course
from models.content import CourseContentTree
from models.ingestion import IngestionJob, StudySession
from models.learning_plan import LearningPlan, LearningPlanStatus
from models.learning_task import LearningTask, LearningTaskStatus
from models.progress import LearningProgress
from models.user import User
from routers.learning_plans import _plan_response, _task_response
from schemas.learning_plan import LearningPlanResponse, LearningTaskResponse
from services.auth.dependency import get_current_user
from services.learning_progress import aggregate_course_progress_views, course_progress_snapshot, course_progress_view, latest_valid_session

router = APIRouter()

OPEN_TASK_STATUSES = ("READY", "PENDING", "IN_PROGRESS", "POSTPONED", "MISSED")
# Indexing is a background enhancement. Only states that block using the
# material belong in the learner-facing processing center.
PROCESSING_UPLOAD_STATUSES = {"uploaded", "extracting", "classifying", "dispatching", "pending", "failed"}


async def _tasks_for_active_plans(db: AsyncSession, user_id: uuid.UUID, course_id: uuid.UUID | None = None) -> list[LearningTask]:
    query = select(LearningTask).join(LearningPlan).where(
        LearningPlan.user_id == user_id,
        LearningPlan.status == LearningPlanStatus.ACTIVE.value,
        LearningTask.status.in_(OPEN_TASK_STATUSES),
    ).join(Course, Course.id == LearningTask.course_id).where(Course.status == "ACTIVE")
    if course_id:
        query = query.where(LearningTask.course_id == course_id)
    # An in-progress task must always be surfaced first; then due date and the plan sequence.
    query = query.order_by(
        case((LearningTask.status == LearningTaskStatus.IN_PROGRESS.value, 0), else_=1),
        case((LearningTask.postponed_to.isnot(None), LearningTask.postponed_to), else_=LearningTask.scheduled_for).nullsfirst(),
        LearningTask.sequence,
    )
    return list((await db.execute(query)).scalars().all())


def _effective_task_date(task: LearningTask) -> date | None:
    """Return the date the learner should act on a task, without client guesses."""
    value = task.postponed_to or task.scheduled_for
    if value is None:
        return None
    if value.tzinfo is None:
        return value.date()
    return value.astimezone(timezone.utc).date()


def _task_href(task: LearningTask, existing_nodes: set[uuid.UUID]) -> str:
    """Deep link into the module that can execute this task.

    Computed from the task's structured fields (single source of truth); the
    legacy Markdown link is only a fallback for node-less compat tasks.  A
    deleted content node degrades to the module's course-level page — never a
    404.
    """
    from services.learning_plans.action_links import build_action_href

    if task.content_node_id:
        return build_action_href(
            task_type=task.task_type,
            course_id=task.course_id,
            content_node_id=task.content_node_id,
            node_exists=task.content_node_id in existing_nodes,
        )
    if task.action_href:
        return task.action_href
    return build_action_href(
        task_type=task.task_type,
        course_id=task.course_id,
        content_node_id=None,
        node_exists=False,
    )


async def _existing_node_ids(db: AsyncSession, tasks: list[LearningTask]) -> set[uuid.UUID]:
    """Batch capability check: which referenced content nodes still exist."""
    ids = {task.content_node_id for task in tasks if task.content_node_id}
    if not ids:
        return set()
    rows = (await db.execute(
        select(CourseContentTree.id).where(CourseContentTree.id.in_(ids))
    )).all()
    return {row[0] for row in rows}


async def _review_queue(db: AsyncSession, user_id: uuid.UUID, courses: list[Course]) -> list[dict]:
    """Aggregate existing LECTOR results server-side, once per learning space."""
    from services.lector import get_smart_review_session

    queue: list[dict] = []
    for course in courses:
        items = await get_smart_review_session(db, user_id, course.id, max_items=10)
        if not items:
            continue
        top = max(items, key=lambda item: item.priority)
        queue.append({
            "course_id": str(course.id),
            "course_name": course.name,
            "count": len(items),
            "estimated_minutes": len(items) * 3,
            "highest_priority_knowledge": top.concept_name,
            "priority": top.priority,
            "href": f"/course/{course.id}/review",
        })
    return sorted(queue, key=lambda item: item["priority"], reverse=True)


async def _plan_summary(db: AsyncSession, plan: LearningPlan) -> dict:
    rows = (await db.execute(select(LearningTask.status, LearningTask.estimated_minutes, LearningTask.required).where(LearningTask.plan_id == plan.id))).all()
    total = len(rows)
    completed = sum(1 for status, _, _ in rows if status == LearningTaskStatus.COMPLETED.value)
    remaining_minutes = sum(minutes or 0 for status, minutes, _ in rows if status != LearningTaskStatus.COMPLETED.value)
    return {"plan": _plan_response(plan), "task_count": total, "completed_task_count": completed, "remaining_minutes": remaining_minutes}


def _workspace_progress_view_model(
    *,
    course: Course,
    nodes: list[CourseContentTree],
    progress_rows: list[LearningProgress],
    task: LearningTask | None,
    task_href: str | None,
    recent_session: tuple[StudySession, str | None] | None,
) -> dict:
    """Create the single learner-facing card model for a learning space.

    ``mastery_score`` intentionally does not participate in ``progress_percent``:
    mastery measures answer quality, while a card's progress must communicate
    how much of the course the learner has completed.  We can make that claim
    only for leaf, learnable content nodes that have a ``mastered`` progress
    record.
    """
    from services.learning_plans.action_links import build_resume_href

    node_by_id = {node.id: node for node in nodes}
    snapshot = course_progress_snapshot(nodes, progress_rows)
    progress_view = course_progress_view(snapshot)
    learnable_nodes = snapshot.learnable_nodes
    progress_by_node = snapshot.progress_by_node
    completed_count = progress_view["completed_learning_items"]
    total_count = progress_view["total_learning_items"]
    progress_percent = progress_view["progress_percent"]

    # The active LearningTask is a user-visible commitment, so it wins over a
    # historic session.  Its structured href remains the navigation source.
    if task is not None:
        task_node = node_by_id.get(task.content_node_id)
        current_title = task_node.title if task_node else task.title
        in_progress = task.status == LearningTaskStatus.IN_PROGRESS.value
        return {
            "id": str(course.id),
            "name": course.name,
            "description": course.description,
            "status": "IN_PROGRESS" if in_progress else "TASK_READY",
            "status_label": "正在学习" if in_progress else "下一步学习",
            "current_node_title": current_title,
            "completed_learning_items": completed_count,
            "total_learning_items": total_count,
            "progress_percent": progress_percent,
            "action_label": "继续学习" if in_progress else "开始学习",
            "target_route": task_href or f"/course/{course.id}",
            "review_count": 0,
        }

    if recent_session is not None:
        session, node_title = recent_session
        if session.content_node_id is not None and node_title:
            module = session.target_module or "CONTENT"
            return {
                "id": str(course.id),
                "name": course.name,
                "description": course.description,
                "status": "IN_PROGRESS",
                "status_label": "正在学习",
                "current_node_title": node_title,
                "completed_learning_items": completed_count,
                "total_learning_items": total_count,
                "progress_percent": progress_percent,
                "action_label": "继续学习",
                "target_route": build_resume_href(
                    course_id=course.id,
                    content_node_id=session.content_node_id,
                    node_exists=True,
                    target_module=module,
                ),
                "review_count": 0,
            }

    started = [
        item for item in progress_by_node.values()
        if item.status != "not_started" or item.last_studied_at is not None
    ]
    if total_count and completed_count == total_count:
        target = learnable_nodes[-1] if learnable_nodes else None
        return {
            "id": str(course.id),
            "name": course.name,
            "description": course.description,
            "status": "COMPLETED",
            "status_label": "本学习空间已完成",
            "current_node_title": None,
            "completed_learning_items": completed_count,
            "total_learning_items": total_count,
            "progress_percent": progress_percent,
            "action_label": "复习已学内容",
            "target_route": f"/course/{course.id}/review" if target else f"/course/{course.id}",
            "review_count": 0,
        }

    if started:
        latest = max(
            started,
            key=lambda item: item.last_studied_at or item.updated_at or item.created_at,
        )
        node = node_by_id.get(latest.content_node_id)
        if node is not None:
            return {
                "id": str(course.id),
                "name": course.name,
                "description": course.description,
                "status": "IN_PROGRESS",
                "status_label": "正在学习",
                "current_node_title": node.title,
                "completed_learning_items": completed_count,
                "total_learning_items": total_count,
                "progress_percent": progress_percent,
                "action_label": "继续学习",
                "target_route": f"/course/{course.id}/unit/{node.id}",
                "review_count": 0,
            }

    first_node = learnable_nodes[0] if learnable_nodes else None
    return {
        "id": str(course.id),
        "name": course.name,
        "description": course.description,
        "status": "NOT_STARTED",
        "status_label": "准备开始",
        "current_node_title": None,
        "completed_learning_items": 0,
        "total_learning_items": total_count,
        "progress_percent": 0 if total_count else None,
        "action_label": "开始学习",
        "target_route": f"/course/{course.id}/unit/{first_node.id}" if first_node else f"/course/{course.id}",
        "review_count": 0,
    }


@router.get("/", response_model=dict)
async def learning_plan_dashboard(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    plans = list((await db.execute(select(LearningPlan).where(LearningPlan.user_id == user.id).order_by(LearningPlan.updated_at.desc()))).scalars().all())
    drafts = [await _plan_summary(db, plan) for plan in plans if plan.status in {LearningPlanStatus.DRAFT.value, LearningPlanStatus.CHANGES_REQUESTED.value}]
    pending = [await _plan_summary(db, plan) for plan in plans if plan.status == LearningPlanStatus.PENDING_APPROVAL.value]
    active = [await _plan_summary(db, plan) for plan in plans if plan.status in {LearningPlanStatus.ACTIVE.value, LearningPlanStatus.PAUSED.value}]
    current_tasks = await _tasks_for_active_plans(db, user.id)
    return {
        "draft_plans": drafts,
        "pending_plans": pending,
        "active_plans": active,
        "today_tasks": [_task_response(task) for task in current_tasks],
        "current_task": _task_response(current_tasks[0]) if current_tasks else None,
        "next_task": _task_response(current_tasks[1]) if len(current_tasks) > 1 else None,
    }


@router.get("/overview", response_model=dict)
async def learning_home_overview(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Return every home-page fact from one authoritative server-side read model.

    This endpoint deliberately does not expose AgentTask approval state.  A
    learning-plan review is represented only by ``LearningPlan.PENDING_APPROVAL``.
    """
    courses = list((await db.execute(
        select(Course).where(Course.user_id == user.id, Course.status == "ACTIVE").order_by(Course.updated_at.desc())
    )).scalars().all())
    plans = list((await db.execute(
        select(LearningPlan).where(LearningPlan.user_id == user.id).order_by(LearningPlan.updated_at.desc())
    )).scalars().all())
    draft_plans = [await _plan_summary(db, plan) for plan in plans if plan.status in {LearningPlanStatus.DRAFT.value, LearningPlanStatus.CHANGES_REQUESTED.value}]
    pending_plans = [await _plan_summary(db, plan) for plan in plans if plan.status == LearningPlanStatus.PENDING_APPROVAL.value]
    active_tasks = await _tasks_for_active_plans(db, user.id)

    today = datetime.now(timezone.utc).date()
    # In-progress work remains visible even if it was originally scheduled on a
    # previous date.  Other tasks appear only when their effective date is due.
    today_tasks = [
        task for task in active_tasks
        if task.status == LearningTaskStatus.IN_PROGRESS.value
        or (_effective_task_date(task) is not None and _effective_task_date(task) <= today)
    ]
    # The home reminder is deliberately derived from the same LearningTask
    # rows as "today".  It is not a second calendar/recommendation system.
    upcoming_tasks = [
        task for task in active_tasks
        if _effective_task_date(task) is not None
        and today < _effective_task_date(task) <= date.fromordinal(today.toordinal() + 7)
    ][:6]
    current_task = next((task for task in active_tasks if task.status == LearningTaskStatus.IN_PROGRESS.value), None)
    next_task = current_task or (today_tasks[0] if today_tasks else (active_tasks[0] if active_tasks else None))
    existing_nodes = await _existing_node_ids(db, active_tasks)

    from services.learning_plans.action_links import cta_label_for_module, module_for_task_type

    if next_task:
        target_module = module_for_task_type(next_task.task_type)
        current_action: dict | None = {
            "course_id": str(next_task.course_id),
            "content_node_id": str(next_task.content_node_id) if next_task.content_node_id else None,
            "knowledge_point_id": next_task.knowledge_point_id,
            "learning_task_id": str(next_task.id),
            "plan_id": str(next_task.plan_id),
            "action_type": next_task.task_type,
            "target_module": target_module,
            "title": next_task.title,
            "instruction": next_task.instruction,
            "action_text": (
                "继续学习" if next_task.status == LearningTaskStatus.IN_PROGRESS.value
                else cta_label_for_module(target_module)
            ),
            "reason": next_task.instruction or "按学习计划完成当前任务。",
            "href": _task_href(next_task, existing_nodes),
        }
    else:
        # Preserve the existing server-owned recommendation for learners who do
        # not yet have an active LearningTask.
        from routers.goals import get_user_next_learning_action
        fallback = await get_user_next_learning_action(user=user, db=db)
        current_action = {
            "course_id": fallback.course_id,
            "content_node_id": fallback.content_node_id,
            "knowledge_point_id": None,
            "learning_task_id": None,
            "recommendation_id": fallback.recommendation_id,
            "action_type": fallback.action_type,
            "target_module": fallback.target_module,
            "title": fallback.title,
            "instruction": fallback.recommended_action,
            "action_text": fallback.primary_label,
            "reason": fallback.recommended_action,
            "href": fallback.href,
        }

    progress_rows = list((await db.execute(
        select(LearningProgress).where(LearningProgress.user_id == user.id)
    )).scalars().all())
    progress_by_course: dict[uuid.UUID, list[LearningProgress]] = {}
    for progress in progress_rows:
        progress_by_course.setdefault(progress.course_id, []).append(progress)
    course_ids = [course.id for course in courses]
    content_by_course: dict[uuid.UUID, list[CourseContentTree]] = {}
    if course_ids:
        all_content_nodes = list((await db.execute(
            select(CourseContentTree).where(CourseContentTree.course_id.in_(course_ids))
        )).scalars().all())
        for node in all_content_nodes:
            content_by_course.setdefault(node.course_id, []).append(node)

    # LastLearningContext is derived only from a real session on a teachable
    # node.  Course-home heartbeats, preloads and front matter cannot replace
    # a student's actual last learning position.
    recent_session_by_course: dict[uuid.UUID, tuple[StudySession, str | None]] = {}
    valid_sessions: list[StudySession] = []
    if course_ids:
        sessions = list((await db.execute(
            select(StudySession).where(
                StudySession.user_id == user.id,
                StudySession.course_id.in_(course_ids),
            )
        )).scalars().all())
        sessions_by_course: dict[uuid.UUID, list[StudySession]] = {}
        for session in sessions:
            sessions_by_course.setdefault(session.course_id, []).append(session)
        for course in courses:
            course_nodes = content_by_course.get(course.id, [])
            snapshot = course_progress_snapshot(course_nodes, progress_by_course.get(course.id, []))
            session = latest_valid_session(
                sessions_by_course.get(course.id, []),
                {node.id for node in snapshot.learnable_nodes},
            )
            if session is not None:
                title = next((node.title for node in course_nodes if node.id == session.content_node_id), None)
                if title is not None:
                    recent_session_by_course[course.id] = (session, title)
                    valid_sessions.append(session)

    course_tasks: dict[uuid.UUID, LearningTask] = {}
    for task in active_tasks:
        course_tasks.setdefault(task.course_id, task)
    all_node_ids = {node.id for nodes in content_by_course.values() for node in nodes}
    task_href_by_id = {task.id: _task_href(task, all_node_ids) for task in active_tasks}
    review_queue = await _review_queue(db, user.id, courses)
    review_count_by_course = {uuid.UUID(item["course_id"]): item["count"] for item in review_queue}

    learning_spaces: list[dict] = []
    today_task_count_by_course: dict[uuid.UUID, int] = {}
    for task in today_tasks:
        today_task_count_by_course[task.course_id] = today_task_count_by_course.get(task.course_id, 0) + 1
    for course in courses:
        task = course_tasks.get(course.id)
        card = _workspace_progress_view_model(
            course=course,
            nodes=content_by_course.get(course.id, []),
            progress_rows=progress_by_course.get(course.id, []),
            task=task,
            task_href=task_href_by_id.get(task.id) if task else None,
            recent_session=recent_session_by_course.get(course.id),
        )
        card["review_count"] = review_count_by_course.get(course.id, 0)
        card["today_task_count"] = today_task_count_by_course.get(course.id, 0)
        learning_spaces.append(card)

    upload_rows = list((await db.execute(
        select(IngestionJob, Course.name)
        .join(Course, Course.id == IngestionJob.course_id)
        .where(
            IngestionJob.user_id == user.id,
            IngestionJob.is_current_attempt.is_(True),
            IngestionJob.status.in_(PROCESSING_UPLOAD_STATUSES),
            # Homepage recovery belongs only to a learning space the learner
            # explicitly published. Unconfirmed SETUP attempts are temporary
            # creation data and must never become a persistent home alert.
            Course.status == "ACTIVE",
        )
        .order_by(IngestionJob.updated_at.desc())
    )).all())
    processing_uploads = [{
        "id": str(job.id),
        "name": job.original_filename or course_name or "学习资料",
        "course_id": str(job.course_id) if job.course_id else None,
        "status": job.status,
        "phase_label": job.phase_label or "正在处理学习资料",
        "progress_percent": job.progress_percent,
        "href": "/processing",
    } for job, course_name in upload_rows]

    # A single global resume card reuses the exact per-course contexts above.
    recent_session = max(
        valid_sessions,
        key=lambda item: item.last_activity_at or item.started_at,
        default=None,
    )
    recent_learning = None
    if recent_session is not None:
        course = next((item for item in courses if item.id == recent_session.course_id), None)
        recent_course_name = course.name if course else "学习空间"
        recent_content_title = next(
            (node.title for node in content_by_course.get(recent_session.course_id, []) if node.id == recent_session.content_node_id),
            None,
        )
        node_exists = recent_content_title is not None
        from services.learning_plans.action_links import build_resume_href
        recent_learning = {
            "course_id": str(recent_session.course_id),
            "course_name": recent_course_name,
            "content_node_id": str(recent_session.content_node_id) if node_exists else None,
            "content_title": recent_content_title if node_exists else None,
            "knowledge_point_id": None,
            "target_module": recent_session.target_module or "CONTENT",
            "at": (recent_session.last_activity_at or recent_session.started_at).isoformat(),
            "href": build_resume_href(
                course_id=recent_session.course_id,
                content_node_id=recent_session.content_node_id,
                node_exists=node_exists,
                target_module=recent_session.target_module,
            ),
        }

    # Without an active plan, the home recommendation is the same structured
    # LastLearningContext as the resume card.  Text, module and deep link are
    # built together here, so "继续巩固数轴" can never navigate to a different
    # (or metadata) node.
    if next_task is None and recent_learning is not None:
        title = recent_learning["content_title"]
        current_action = {
            "course_id": recent_learning["course_id"],
            "content_node_id": recent_learning["content_node_id"],
            "knowledge_point_id": recent_learning["knowledge_point_id"],
            "learning_task_id": None,
            "recommendation_id": f"resume:{recent_learning['course_id']}:{recent_learning['content_node_id']}",
            "action_type": "RESUME",
            "target_module": recent_learning["target_module"],
            "title": f"继续学习：{title}",
            "instruction": f"回到「{title}」，继续完成当前学习内容。",
            "action_text": "继续学习",
            "reason": f"上次学到「{title}」，从这里继续最连贯。",
            "href": recent_learning["href"],
        }
    elif next_task is None and current_action and current_action.get("course_id"):
        # Legacy recommendation records can still carry a title/link to a
        # parsed table of contents.  They remain readable history, but may not
        # become a student-facing next step.  Normalize once at this server
        # boundary to the first real learning unit.
        try:
            action_course_id = uuid.UUID(str(current_action["course_id"]))
        except (ValueError, TypeError):
            action_course_id = None
        if action_course_id is not None:
            snapshot = course_progress_snapshot(
                content_by_course.get(action_course_id, []),
                progress_by_course.get(action_course_id, []),
            )
            valid_ids = {node.id for node in snapshot.learnable_nodes}
            raw_node_id = current_action.get("content_node_id")
            try:
                action_node_id = uuid.UUID(str(raw_node_id)) if raw_node_id else None
            except (ValueError, TypeError):
                action_node_id = None
            if action_node_id not in valid_ids and snapshot.learnable_nodes:
                from services.learning_plans.action_links import build_resume_href
                node = snapshot.learnable_nodes[0]
                current_action = {
                    "course_id": str(action_course_id),
                    "content_node_id": str(node.id),
                    "knowledge_point_id": None,
                    "learning_task_id": None,
                    "recommendation_id": f"start:{action_course_id}:{node.id}",
                    "action_type": "START",
                    "target_module": "CONTENT",
                    "title": f"开始学习：{node.title}",
                    "instruction": f"从「{node.title}」开始本学习空间的第一步。",
                    "action_text": "开始学习",
                    "reason": f"这是当前学习空间中第一个可学习的内容。",
                    "href": build_resume_href(
                        course_id=action_course_id,
                        content_node_id=node.id,
                        node_exists=True,
                        target_module="CONTENT",
                    ),
                }

    week_start = today.fromordinal(today.toordinal() - today.weekday())
    completed_tasks_this_week = list((await db.execute(
        select(LearningTask).join(LearningPlan).where(
            LearningPlan.user_id == user.id,
            LearningTask.status == LearningTaskStatus.COMPLETED.value,
            LearningTask.completed_at.isnot(None),
        )
    )).scalars().all())
    completed_this_week = sum(
        1 for task in completed_tasks_this_week
        if task.completed_at is not None
        and task.completed_at.date() >= week_start
    )
    completed_today = sum(
        1 for task in completed_tasks_this_week
        if task.completed_at is not None and task.completed_at.date() == today
    )
    review_due_count = sum(item["count"] for item in review_queue)
    learning_summary_progress = aggregate_course_progress_views(learning_spaces)

    return {
        "current_learning_action": current_action,
        "draft_learning_plans": draft_plans,
        "pending_learning_plans": pending_plans,
        "today_tasks": [
            _task_response(task).model_dump(mode="json") | {"href": _task_href(task, existing_nodes)}
            for task in today_tasks
        ],
        "upcoming_tasks": [
            _task_response(task).model_dump(mode="json") | {"href": _task_href(task, existing_nodes)}
            for task in upcoming_tasks
        ],
        "today_summary": {
            "estimated_minutes": sum(task.estimated_minutes or 0 for task in today_tasks),
            "completed_count": completed_today,
            "total_count": completed_today + len(today_tasks),
        },
        "learning_spaces": learning_spaces,
        "processing_uploads": processing_uploads,
        "review_queue": review_queue,
        "recent_learning": recent_learning,
        "learning_summary": {
            "active_workspace_count": len(courses),
            "today_task_count": len(today_tasks),
            "completed_task_count_this_week": completed_this_week,
            "review_due_count": review_due_count,
            # Same per-space completion contract as the home cards and graph,
            # then centrally weighted by total learnable content.
            **learning_summary_progress,
        },
    }


@router.get("/course/{course_id}", response_model=dict)
async def course_learning_plan_dashboard(course_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    course = (await db.execute(select(Course).where(
        Course.id == course_id,
        Course.user_id == user.id,
        Course.status == "ACTIVE",
    ))).scalar_one_or_none()
    if course is None:
        from libs.exceptions import NotFoundError
        raise NotFoundError("Course", course_id)
    plans = list((await db.execute(select(LearningPlan).where(LearningPlan.user_id == user.id, LearningPlan.course_id == course_id).order_by(LearningPlan.updated_at.desc()))).scalars().all())
    draft = next((plan for plan in plans if plan.status in {LearningPlanStatus.DRAFT.value, LearningPlanStatus.CHANGES_REQUESTED.value}), None)
    pending = next((plan for plan in plans if plan.status == LearningPlanStatus.PENDING_APPROVAL.value), None)
    active = next((plan for plan in plans if plan.status in {LearningPlanStatus.ACTIVE.value, LearningPlanStatus.PAUSED.value}), None)
    tasks = await _tasks_for_active_plans(db, user.id, course_id)
    nodes = list((await db.execute(select(CourseContentTree).where(
        CourseContentTree.course_id == course_id,
    ))).scalars().all())
    progress_rows = list((await db.execute(select(LearningProgress).where(
        LearningProgress.user_id == user.id,
        LearningProgress.course_id == course_id,
    ))).scalars().all())
    snapshot = course_progress_snapshot(nodes, progress_rows)
    # This is the same authoritative task ordering used by the home page.
    # Expose the first task explicitly so course UI never infers its own
    # "next task" from a plan summary or stale browser state.
    return {
        "draft_plan": await _plan_summary(db, draft) if draft else None,
        "pending_plan": await _plan_summary(db, pending) if pending else None,
        "active_plan": await _plan_summary(db, active) if active else None,
        "current_task": _task_response(tasks[0]) if tasks else None,
        "today_tasks": [_task_response(task) for task in tasks],
        # Same view used by the home learning-space card. The graph consumes
        # this endpoint, so both screens share one progress contract.
        "workspace_progress": course_progress_view(snapshot),
    }
