"""Durable study-goal endpoints."""

import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from libs.exceptions import ConflictError, NotFoundError
from models.agent_task import AgentTask
from models.study_goal import StudyGoal
from models.course import Course
from models.ingestion import StudySession
from models.content import CourseContentTree
from models.user import User
from schemas.task import AgentTaskResponse
from services.activity.task_records import serialize_task
from services.agent.agenda import get_next_learning_action, queue_decision, resolve_next_action
from services.auth.dependency import get_current_user
from services.course_access import get_course_or_404
from utils.serializers import serialize_model

router = APIRouter()


def _is_legacy_plan_goal(goal: StudyGoal) -> bool:
    metadata = goal.metadata_json or {}
    return bool(metadata.get("plan_batch_id") or metadata.get("source") in {"assistant", "manual_plan"})


class StudyGoalResponse(BaseModel):
    id: str
    user_id: str
    course_id: str | None
    title: str
    objective: str
    success_metric: str | None
    current_milestone: str | None
    next_action: str | None
    status: str
    confidence: str | None
    target_date: str | None
    metadata_json: dict | None
    linked_task_count: int
    created_at: str | None
    updated_at: str | None
    completed_at: str | None


class CreateGoalRequest(BaseModel):
    title: str
    objective: str
    course_id: uuid.UUID | None = None
    success_metric: str | None = None
    current_milestone: str | None = None
    next_action: str | None = None
    status: str = "active"
    confidence: str | None = None
    target_date: datetime | None = None
    metadata_json: dict | None = None


class UpdateGoalRequest(BaseModel):
    title: str | None = None
    objective: str | None = None
    success_metric: str | None = None
    current_milestone: str | None = None
    next_action: str | None = None
    status: str | None = None
    confidence: str | None = None
    target_date: datetime | None = None
    metadata_json: dict | None = None


class NextActionResponse(BaseModel):
    course_id: str
    goal_id: str | None
    title: str
    reason: str
    source: str
    recommended_action: str
    suggested_task_type: str | None
    queue_label: str | None = None
    queue_ready: bool = True


class NextLearningActionResponse(BaseModel):
    """The one action the personal learning home should foreground."""

    course_id: str | None
    course_name: str | None
    title: str
    reason: str
    recommended_action: str
    action_type: str
    href: str
    primary_label: str
    content_node_id: str | None = None
    knowledge_point_id: str | None = None
    recommendation_id: str | None = None
    target_module: str = "CONTENT"
    recent_course_id: str | None = None
    recent_course_name: str | None = None
    recent_content_title: str | None = None
    recent_at: str | None = None


def _decision_to_next_action_response(
    decision,
    course_id: uuid.UUID,
) -> NextActionResponse:
    """Convert an AgendaDecision to the legacy NextActionResponse shape."""
    source_map = {
        "active_goal": "recent_goal",
        "deadline": "deadline",
        "failed_task": "task_failure",
        "forgetting_risk": "forgetting_risk",
        "weak_area": "forgetting_risk",
        "inactivity": "manual",
    }
    signal_type = decision.signal.signal_type if decision.signal else "manual"
    queue_label_map = {
        "submit": "Queue task",
        "resume": "Resume task",
        "retry": "Retry task",
        "noop": None,
    }
    return NextActionResponse(
        course_id=str(course_id),
        goal_id=str(decision.goal_id) if decision.goal_id else None,
        title=decision.task_title or "Set the next goal",
        reason=decision.reason,
        source=source_map.get(signal_type, "manual"),
        recommended_action=decision.task_summary or decision.reason,
        suggested_task_type=decision.task_type,
        queue_label=queue_label_map.get(decision.action, "Queue task"),
    )


def _learning_action_route(decision, course_id: uuid.UUID | None) -> tuple[str, str, str]:
    """Map a durable agenda decision to a learner-facing destination."""
    task_type = decision.task_type or "continue_learning"
    if course_id and task_type in {"review_session", "prerequisite_review", "wrong_answer_review"}:
        return task_type, f"/course/{course_id}/review", "开始复习"
    if course_id:
        return task_type, f"/course/{course_id}", "继续学习"
    return task_type, "/new", "开始学习"


def _module_for_route(href: str) -> str:
    """Infer the workspace module from a route's *shape* (never from text)."""
    if "/notes" in href:
        return "NOTE"
    if "/practice" in href:
        return "FLASHCARD" if "tab=flashcards" in href else "PRACTICE"
    if "/review" in href:
        return "REVIEW"
    return "CONTENT"


def _enrich_route_with_node(href: str, course_id: uuid.UUID, node_id: uuid.UUID) -> str:
    """Push a verified content node into a module route when its shape allows."""
    if "node=" in href:
        return href
    if href.endswith("/notes"):
        return f"{href}?node={node_id}"
    if "/practice" in href:
        sep = "&" if "?" in href else "?"
        return f"{href}{sep}node={node_id}"
    if href == f"/course/{course_id}":
        return f"/course/{course_id}/unit/{node_id}"
    return href


_NODE_UUID = r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
_NODE_UNIT_RE = re.compile(rf"^/course/[^/]+/unit/{_NODE_UUID}$")
_NODE_PARAM_RE = re.compile(rf"[?&]node={_NODE_UUID}(?:&|$)")


def _extract_node_from_href(href: str) -> uuid.UUID | None:
    """Pull a content-node id out of a structured href.

    Legacy goals predate the separate ``content_node_id`` metadata field —
    for them the node reference only exists inside ``action_href`` itself.
    """
    match = _NODE_UNIT_RE.match(href) or _NODE_PARAM_RE.search(href)
    if not match:
        return None
    try:
        return uuid.UUID(match.group(1))
    except (ValueError, TypeError):
        return None


def _strip_node_from_href(href: str, course_id: uuid.UUID) -> str:
    """Degrade a node-level href to its module-level route (never a 404)."""
    if _NODE_UNIT_RE.match(href):
        return f"/course/{course_id}"
    base, sep, query = href.partition("?")
    if not sep:
        return href
    params = [p for p in query.split("&") if p and not p.startswith("node=")]
    return f"{base}?{'&'.join(params)}" if params else base


@router.get("/next-learning-action", response_model=NextLearningActionResponse)
async def get_user_next_learning_action(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Resolve one cross-course next action for the authenticated learner."""
    decision = await get_next_learning_action(user.id, db)
    course_id = decision.signal.course_id if decision.signal else None

    # If no study signal exists yet, resume the most recently touched course.
    # This fallback remains server-owned so the homepage does not invent a
    # separate next-step rule.
    course: Course | None = None
    if course_id:
        course = await db.get(Course, course_id)
        if course is None or course.user_id != user.id or course.status != "ACTIVE":
            course = None
            course_id = None
    if course is None:
        result = await db.execute(
            select(Course)
            .where(Course.user_id == user.id, Course.status == "ACTIVE")
            .order_by(Course.updated_at.desc())
            .limit(1)
        )
        course = result.scalar_one_or_none()
        course_id = course.id if course else None

    action_type, href, primary_label = _learning_action_route(decision, course_id)

    # Prefer the structured execution target captured when the plan task was
    # written (StudyGoal.metadata.action_href / content_node_id).  The node is
    # re-validated so a deleted unit degrades to the module route, never a 404.
    target_module = _module_for_route(href)
    content_node_id_str: str | None = None
    input_json = decision.input_json or {}
    structured_href = input_json.get("action_href")
    if structured_href and course_id:
        node_uuid: uuid.UUID | None = None
        raw_node = input_json.get("content_node_id")
        if raw_node:
            try:
                node_uuid = uuid.UUID(str(raw_node))
            except (ValueError, TypeError):
                node_uuid = None
        if node_uuid is None:
            # Legacy goals predate the structured content_node_id field; the
            # node reference only exists inside the href itself.
            node_uuid = _extract_node_from_href(structured_href)
        if node_uuid:
            node_exists = (await db.execute(
                select(CourseContentTree.id).where(CourseContentTree.id == node_uuid)
            )).scalar_one_or_none()
            if node_exists:
                content_node_id_str = str(node_uuid)
                structured_href = _enrich_route_with_node(structured_href, course_id, node_uuid)
            else:
                # The referenced unit was deleted (e.g. the material was
                # re-ingested): degrade to the module route, never a 404.
                structured_href = _strip_node_from_href(structured_href, course_id)
        else:
            # Older generated goals stored a module route but omitted the
            # structured node id. Resolve the named curriculum concept once at
            # the server boundary, then return one coherent Recommendation
            # object (text + target + href). This is course-data driven and is
            # not tied to any particular subject or chapter.
            from services.knowledge.content_linking import select_best_content_node

            nodes = list((await db.execute(
                select(CourseContentTree).where(CourseContentTree.course_id == course_id)
            )).scalars().all())
            phrases = re.findall(r"[“\"]([^”\"]{2,80})[”\"]", decision.task_summary or "")
            phrases.extend([decision.task_title or "", decision.signal.title if decision.signal else ""])
            for phrase in phrases:
                matched = select_best_content_node(phrase, nodes)
                if matched is not None:
                    node_uuid = matched.id
                    content_node_id_str = str(matched.id)
                    structured_href = _enrich_route_with_node(structured_href, course_id, matched.id)
                    break
        href = structured_href
        target_module = _module_for_route(href)
    if decision.action == "noop":
        title = "继续上次学习" if course else "开始你的第一门课程"
        recommended_action = "回到最近的学习空间，继续完成一个小步骤。" if course else "创建学习空间并添加学习资料。"
        reason = "为你准备了最容易开始的一步。"
    else:
        title = decision.task_title or "继续学习"
        recommended_action = decision.task_summary or decision.reason
        reason = decision.reason

    recent_result = await db.execute(
        select(StudySession, Course.name, CourseContentTree.title)
        .join(Course, Course.id == StudySession.course_id)
        .outerjoin(CourseContentTree, CourseContentTree.id == StudySession.content_node_id)
        .where(StudySession.user_id == user.id)
        .order_by(
            # Node-level sessions always win over course-level heartbeats;
            # recency only breaks ties within the same tier (same contract
            # as the home overview's recent_learning read model).
            case((StudySession.content_node_id.isnot(None), 0), else_=1),
            func.coalesce(StudySession.last_activity_at, StudySession.started_at).desc(),
        )
        .limit(1)
    )
    recent = recent_result.first()
    recent_session = recent[0] if recent else None

    return NextLearningActionResponse(
        course_id=str(course_id) if course_id else None,
        course_name=course.name if course else None,
        title=title,
        reason=reason,
        recommended_action=recommended_action,
        action_type=action_type,
        href=href,
        primary_label=primary_label,
        content_node_id=content_node_id_str,
        knowledge_point_id=None,
        recommendation_id=str(decision.goal_id) if decision.goal_id else decision.dedup_key,
        target_module=target_module,
        recent_course_id=str(recent_session.course_id) if recent_session else None,
        recent_course_name=recent[1] if recent else None,
        recent_content_title=recent[2] if recent else None,
        recent_at=(recent_session.last_activity_at or recent_session.started_at).isoformat() if recent_session else None,
    )


@router.get("/{course_id}/next-action", response_model=NextActionResponse)
async def get_next_action(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_course_or_404(db, course_id, user_id=user.id)
    decision = await resolve_next_action(user.id, course_id, db)
    return _decision_to_next_action_response(decision, course_id)


@router.post("/{course_id}/next-action/queue", response_model=AgentTaskResponse)
async def queue_next_action(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_course_or_404(db, course_id, user_id=user.id)
    decision = await resolve_next_action(user.id, course_id, db)
    task = await queue_decision(decision, user_id=user.id, course_id=course_id, db=db)

    if not task:
        raise NotFoundError("Task", decision.existing_task_id or "next_action")

    return AgentTaskResponse(**serialize_task(task))


@router.get("/", response_model=list[StudyGoalResponse])
async def list_goals(
    course_id: uuid.UUID | None = Query(None),
    status: str | None = Query(None),
    include_legacy: bool = Query(False, description="Deprecated plan-task history; excluded from normal learning UI."),
    limit: int = Query(20, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = select(StudyGoal).where(StudyGoal.user_id == user.id)
    if course_id:
        query = query.where(StudyGoal.course_id == course_id)
    if status:
        query = query.where(StudyGoal.status == status)
    query = query.order_by(StudyGoal.created_at.desc()).limit(limit)
    result = await db.execute(query)
    goals = result.scalars().all()
    if not include_legacy:
        # StudyGoal is a long-term goal/milestone model. Markdown-derived daily
        # checklist rows belong to legacy history and must not leak into new
        # calendar, timeline or LearningPlan UI.
        goals = [goal for goal in goals if not _is_legacy_plan_goal(goal)]
    if not goals:
        return []

    goal_ids = [goal.id for goal in goals]
    count_result = await db.execute(
        select(AgentTask.goal_id, func.count(AgentTask.id))
        .where(AgentTask.goal_id.in_(goal_ids))
        .group_by(AgentTask.goal_id)
    )
    counts = {row[0]: row[1] for row in count_result.all()}
    return [
        StudyGoalResponse(**serialize_model(goal, extra={"linked_task_count": int(counts.get(goal.id, 0))}))
        for goal in goals
    ]


@router.post("/", response_model=StudyGoalResponse, status_code=201)
async def create_goal(
    body: CreateGoalRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.course_id:
        await get_course_or_404(db, body.course_id, user_id=user.id)
    metadata = body.metadata_json or {}
    if metadata.get("plan_batch_id") or metadata.get("source") in {"assistant", "manual_plan"}:
        from services.legacy_plan_monitor import record_legacy_write
        record_legacy_write("plan_type_study_goal_api_rejected", course_id=str(body.course_id) if body.course_id else None)
        raise ConflictError("Daily plan tasks must be created as LearningTask, not StudyGoal.")
    goal = StudyGoal(
        user_id=user.id,
        course_id=body.course_id,
        title=body.title.strip(),
        objective=body.objective.strip(),
        success_metric=(body.success_metric or None),
        current_milestone=(body.current_milestone or None),
        next_action=(body.next_action or None),
        status=body.status or "active",
        confidence=body.confidence,
        target_date=body.target_date,
        metadata_json=metadata or None,
        completed_at=datetime.now(timezone.utc) if body.status == "completed" else None,
    )
    db.add(goal)
    await db.commit()
    await db.refresh(goal)
    return StudyGoalResponse(**serialize_model(goal, extra={"linked_task_count": 0}))


@router.patch("/{goal_id}", response_model=StudyGoalResponse)
async def update_goal(
    goal_id: uuid.UUID,
    body: UpdateGoalRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(StudyGoal).where(StudyGoal.id == goal_id, StudyGoal.user_id == user.id))
    goal = result.scalar_one_or_none()
    if not goal:
        raise NotFoundError("Goal", goal_id)

    payload = body.model_dump(exclude_unset=True)
    if "title" in payload and payload["title"] is not None:
        goal.title = payload["title"].strip()
    if "objective" in payload and payload["objective"] is not None:
        goal.objective = payload["objective"].strip()
    for field in ("success_metric", "current_milestone", "next_action", "confidence", "target_date", "metadata_json"):
        if field in payload:
            setattr(goal, field, payload[field])
    if "status" in payload and payload["status"] is not None:
        goal.status = payload["status"]
        goal.completed_at = datetime.now(timezone.utc) if payload["status"] == "completed" else None

    await db.commit()
    await db.refresh(goal)

    count_result = await db.execute(select(func.count(AgentTask.id)).where(AgentTask.goal_id == goal.id))
    linked_task_count = int(count_result.scalar() or 0)
    return StudyGoalResponse(**serialize_model(goal, extra={"linked_task_count": linked_task_count}))
