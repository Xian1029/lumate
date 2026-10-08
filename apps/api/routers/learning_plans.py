"""Authoritative LearningPlan HTTP API. Legacy PlanView routes are untouched."""

import uuid
from datetime import date
from typing import TypeVar

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from libs.exceptions import ConflictError, NotFoundError
from models.course import Course
from models.content import CourseContentTree
from models.learning_plan import LearningPlan, LearningPlanSource, LearningPlanStatus
from models.learning_task import LearningTask, LearningTaskStatus
from models.user import User
from schemas.learning_plan import CreateLearningPlanRequest, CreateLearningTaskRequest, LearningPlanResponse, LearningTaskResponse, PlanActionRequest, StartLearningPlanResponse, UpdateLearningPlanRequest, UpdateLearningTaskRequest
from services.auth.dependency import get_current_user
from services.learning_plans import LearningPlanService, LearningPlanTransitionError, LearningTaskService
from services.legacy_plan_monitor import legacy_write_counts

router = APIRouter()


@router.get("/legacy-write-metrics", response_model=dict)
async def get_legacy_plan_write_metrics(user: User = Depends(get_current_user)):
    """Temporary Phase 4 observability; counters are process-local and read-only."""
    return {"legacy_write_counts": legacy_write_counts(), "scope": "process_lifetime"}


def _plan_response(plan: LearningPlan) -> LearningPlanResponse:
    return LearningPlanResponse(**{column.name: (str(getattr(plan, column.name)) if getattr(plan, column.name) is not None and (column.name == "id" or column.name.endswith("_id")) else getattr(plan, column.name)) for column in plan.__table__.columns})


def _task_response(task: LearningTask) -> LearningTaskResponse:
    payload = {
        column.name: (str(getattr(task, column.name)) if getattr(task, column.name) is not None and (column.name == "id" or column.name.endswith("_id")) else getattr(task, column.name))
        for column in task.__table__.columns
        if column.name != "metadata"
    }
    payload["metadata_json"] = task.metadata_json
    return LearningTaskResponse(**payload)


async def _owned_plan(db: AsyncSession, plan_id: uuid.UUID, user_id: uuid.UUID) -> LearningPlan:
    plan = (await db.execute(select(LearningPlan).where(LearningPlan.id == plan_id, LearningPlan.user_id == user_id))).scalar_one_or_none()
    if not plan:
        raise NotFoundError("LearningPlan", plan_id)
    return plan


@router.post("/", response_model=LearningPlanResponse, status_code=201)
async def create_learning_plan(body: CreateLearningPlanRequest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    course = (await db.execute(select(Course.id).where(Course.id == body.course_id, Course.user_id == user.id))).scalar_one_or_none()
    if not course:
        raise NotFoundError("Course", body.course_id)
    values = body.model_dump()
    if body.source == LearningPlanSource.AI:
        payload = body.draft_payload or {}
        raw_selected_ids = payload.get("selected_content_node_ids") or []
        try:
            selected_ids = {uuid.UUID(str(value)) for value in raw_selected_ids}
        except (TypeError, ValueError, AttributeError) as exc:
            raise ConflictError("请选择当前学习空间中的有效章节。") from exc
        if not selected_ids:
            raise ConflictError("AI 学习计划必须先选择要学习的章节内容。")
        owned_ids = set((await db.execute(
            select(CourseContentTree.id).where(
                CourseContentTree.course_id == body.course_id,
                CourseContentTree.id.in_(selected_ids),
            )
        )).scalars().all())
        if owned_ids != selected_ids:
            raise ConflictError("所选章节不属于当前学习空间，请刷新目录后重新选择。")
        # The server repeats the form defaults so API callers and the browser
        # share exactly the same planning contract.
        values["target_date"] = body.target_date or date.today()
        values["available_minutes_per_day"] = body.available_minutes_per_day or 30
        if values["target_date"] < date.today():
            raise ConflictError("完成日期不能早于今天。")
    plan = await LearningPlanService.create_draft(db, user_id=user.id, **values)
    await db.commit(); await db.refresh(plan)
    return _plan_response(plan)


@router.get("/", response_model=list[LearningPlanResponse])
async def list_learning_plans(course_id: uuid.UUID | None = None, status: str | None = None, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    query = select(LearningPlan).where(LearningPlan.user_id == user.id)
    if course_id: query = query.where(LearningPlan.course_id == course_id)
    if status: query = query.where(LearningPlan.status == status)
    plans = (await db.execute(query.order_by(LearningPlan.updated_at.desc()))).scalars().all()
    return [_plan_response(plan) for plan in plans]


@router.get("/{plan_id}", response_model=LearningPlanResponse)
async def get_learning_plan(plan_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return _plan_response(await _owned_plan(db, plan_id, user.id))


@router.delete("/{plan_id}", status_code=204)
async def delete_terminal_learning_plan(plan_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Physically delete only terminal plans and their task records."""
    plan = await _owned_plan(db, plan_id, user.id)
    if plan.status not in {LearningPlanStatus.COMPLETED.value, LearningPlanStatus.CANCELLED.value}:
        raise ConflictError("Only completed or cancelled learning plans can be permanently deleted.")
    # Do this explicitly instead of relying on SQLite foreign-key pragma state.
    await db.execute(LearningTask.__table__.delete().where(LearningTask.plan_id == plan.id))
    await db.delete(plan)
    await db.commit()
    return Response(status_code=204)


@router.patch("/{plan_id}", response_model=LearningPlanResponse)
async def update_learning_plan(plan_id: uuid.UUID, body: UpdateLearningPlanRequest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    plan = await _owned_plan(db, plan_id, user.id)
    if body.expected_version is not None and body.expected_version != plan.version:
        raise ConflictError("Plan changed on another screen; fetch the latest plan before applying this edit.")
    if plan.status not in {LearningPlanStatus.DRAFT.value, LearningPlanStatus.CHANGES_REQUESTED.value, LearningPlanStatus.ACTIVE.value, LearningPlanStatus.PAUSED.value}:
        raise ConflictError("Only draft, active, or paused plans can be edited.")
    for key, value in body.model_dump(exclude_unset=True, exclude={"expected_version"}).items(): setattr(plan, key, value)
    if plan.status == LearningPlanStatus.CHANGES_REQUESTED.value:
        await LearningPlanService.revise_to_draft(db, plan, user.id, "Plan edited after changes were requested")
    plan.version += 1
    await db.commit(); await db.refresh(plan)
    return _plan_response(plan)


@router.get("/{plan_id}/tasks", response_model=list[LearningTaskResponse])
async def list_learning_plan_tasks(plan_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _owned_plan(db, plan_id, user.id)
    tasks = (await db.execute(select(LearningTask).where(LearningTask.plan_id == plan_id).order_by(LearningTask.sequence))).scalars().all()
    return [_task_response(task) for task in tasks]


@router.post("/{plan_id}/start", response_model=StartLearningPlanResponse)
async def start_learning_plan(plan_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Atomically resume/activate a plan and resolve its one executable task.

    This replaces the old browser choreography of independently mutating a
    plan, task and recommendation.  The query is re-run for every click, and
    an existing in-progress task wins, making retries and double-clicks safe.
    """
    plan = await _owned_plan(db, plan_id, user.id)
    try:
        if plan.status == LearningPlanStatus.PENDING_APPROVAL.value:
            await LearningPlanService.approve(db, plan, user.id, "Started from learning entry")
        elif plan.status == LearningPlanStatus.PAUSED.value:
            await LearningPlanService.resume(db, plan, user.id, "Started from learning entry")
        elif plan.status != LearningPlanStatus.ACTIVE.value:
            raise LearningPlanTransitionError("Only pending, active, or paused plans can be started.")

        tasks = list((await db.execute(
            select(LearningTask).where(
                LearningTask.plan_id == plan.id,
                LearningTask.status.in_((
                    LearningTaskStatus.IN_PROGRESS.value, LearningTaskStatus.READY.value,
                    LearningTaskStatus.PENDING.value,
                )),
            ).order_by(
                # Existing work always wins; then use the plan's explicit sequence.
                (LearningTask.status == LearningTaskStatus.IN_PROGRESS.value).desc(),
                LearningTask.sequence,
            )
        )).scalars().all())
        if not tasks:
            raise LearningPlanTransitionError("This plan has no executable unfinished task.")
        task = tasks[0]
        await LearningTaskService.start_task(db, task)
    except LearningPlanTransitionError as exc:
        await db.rollback()
        raise ConflictError(str(exc)) from exc

    node_exists = False
    if task.content_node_id:
        node_exists = (await db.execute(select(CourseContentTree.id).where(CourseContentTree.id == task.content_node_id))).scalar_one_or_none() is not None
    from services.learning_plans.action_links import build_action_href, module_for_task_type
    href = build_action_href(task_type=task.task_type, course_id=task.course_id, content_node_id=task.content_node_id, node_exists=node_exists)
    # Structured data is authoritative.  A legacy href is only used for old
    # node-less tasks where it remains a valid course-owned route.
    if not task.content_node_id and task.action_href:
        href = task.action_href
    await db.commit()
    await db.refresh(plan); await db.refresh(task)
    return StartLearningPlanResponse(plan=_plan_response(plan), task=_task_response(task), href=href, target_module=module_for_task_type(task.task_type), relocated=bool(task.content_node_id and not node_exists))


@router.post("/{plan_id}/tasks", response_model=LearningTaskResponse, status_code=201)
async def create_learning_task(plan_id: uuid.UUID, body: CreateLearningTaskRequest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    plan = await _owned_plan(db, plan_id, user.id)
    if plan.status in {LearningPlanStatus.COMPLETED.value, LearningPlanStatus.CANCELLED.value}:
        raise ConflictError("Cannot add tasks to a terminal plan.")
    if body.content_node_id:
        node = (await db.execute(select(CourseContentTree.id).where(CourseContentTree.id == body.content_node_id, CourseContentTree.course_id == plan.course_id))).scalar_one_or_none()
        if not node:
            raise ConflictError("The selected chapter does not belong to this learning space.")
    values = body.model_dump()
    # Tasks added to an active plan are immediately eligible for the calendar;
    # paused plans retain their edits but never start work until resume.
    if plan.status == LearningPlanStatus.ACTIVE.value:
        values["status"] = "READY"
    task = await LearningTaskService.create_task(db, plan_id=plan.id, course_id=plan.course_id, **values)
    plan.version += 1
    await db.commit(); await db.refresh(task)
    return _task_response(task)


@router.patch("/{plan_id}/tasks/{task_id}", response_model=LearningTaskResponse)
async def update_learning_task(plan_id: uuid.UUID, task_id: uuid.UUID, body: UpdateLearningTaskRequest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    plan = await _owned_plan(db, plan_id, user.id)
    if plan.status not in {LearningPlanStatus.DRAFT.value, LearningPlanStatus.CHANGES_REQUESTED.value, LearningPlanStatus.ACTIVE.value, LearningPlanStatus.PAUSED.value}:
        raise ConflictError("Tasks cannot be edited on a completed or cancelled plan.")
    task = (await db.execute(select(LearningTask).where(LearningTask.id == task_id, LearningTask.plan_id == plan.id))).scalar_one_or_none()
    if not task:
        raise NotFoundError("LearningTask", task_id)
    if task.status == "COMPLETED":
        raise ConflictError("Completed tasks are preserved as learning history and cannot be edited.")
    if body.content_node_id:
        node = (await db.execute(select(CourseContentTree.id).where(CourseContentTree.id == body.content_node_id, CourseContentTree.course_id == plan.course_id))).scalar_one_or_none()
        if not node:
            raise ConflictError("The selected chapter does not belong to this learning space.")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(task, key, value)
    plan.version += 1
    await db.commit(); await db.refresh(task)
    return _task_response(task)


async def _plan_action(plan_id: uuid.UUID, body: PlanActionRequest, user: User, db: AsyncSession, action: str):
    plan = await _owned_plan(db, plan_id, user.id)
    # The idempotency check in the state machine is intentionally evaluated
    # before version validation: a lost response for a successful action is
    # safe to retry with the old version.
    target_by_action = {"submit_for_approval": "PENDING_APPROVAL", "approve": "ACTIVE", "pause": "PAUSED", "resume": "ACTIVE", "cancel": "CANCELLED", "complete": "COMPLETED"}
    if body.expected_version is not None and body.expected_version != plan.version and plan.status != target_by_action.get(action):
        raise ConflictError("Plan changed on another screen; fetch the latest plan before retrying this action.")
    try:
        method = getattr(LearningPlanService, action)
        result = await method(db, plan, user.id, body.reason)
    except LearningPlanTransitionError as exc:
        raise ConflictError(str(exc)) from exc
    await db.commit(); await db.refresh(result)
    return _plan_response(result)


@router.post("/{plan_id}/regenerate", response_model=list[LearningTaskResponse])
async def regenerate_learning_plan_tasks(plan_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Rebuild a draft/pending plan's task schedule from the course content tree.

    This is the deterministic "重新生成" path: it uses the plan's own pacing
    parameters and the current content tree, so it works even if the original
    AI-generated tasks were removed or the course content changed.
    """
    from services.learning_plans.plan_regenerator import PlanRegenerationError, regenerate_plan_tasks
    plan = await _owned_plan(db, plan_id, user.id)
    try:
        tasks = await regenerate_plan_tasks(db, plan, user.id)
    except PlanRegenerationError as exc:
        raise ConflictError(str(exc)) from exc
    await db.commit()
    return [_task_response(task) for task in tasks]


@router.post("/{plan_id}/submit", response_model=LearningPlanResponse)
async def submit_learning_plan(plan_id: uuid.UUID, body: PlanActionRequest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)): return await _plan_action(plan_id, body, user, db, "submit_for_approval")
@router.post("/{plan_id}/approve", response_model=LearningPlanResponse)
async def approve_learning_plan(plan_id: uuid.UUID, body: PlanActionRequest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)): return await _plan_action(plan_id, body, user, db, "approve")
@router.post("/{plan_id}/request-changes", response_model=LearningPlanResponse)
async def request_plan_changes(plan_id: uuid.UUID, body: PlanActionRequest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)): return await _plan_action(plan_id, body, user, db, "request_changes")
@router.post("/{plan_id}/cancel", response_model=LearningPlanResponse)
async def cancel_learning_plan(plan_id: uuid.UUID, body: PlanActionRequest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)): return await _plan_action(plan_id, body, user, db, "cancel")
@router.post("/{plan_id}/pause", response_model=LearningPlanResponse)
async def pause_learning_plan(plan_id: uuid.UUID, body: PlanActionRequest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)): return await _plan_action(plan_id, body, user, db, "pause")
@router.post("/{plan_id}/resume", response_model=LearningPlanResponse)
async def resume_learning_plan(plan_id: uuid.UUID, body: PlanActionRequest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)): return await _plan_action(plan_id, body, user, db, "resume")
@router.post("/{plan_id}/complete", response_model=LearningPlanResponse)
async def complete_learning_plan(plan_id: uuid.UUID, body: PlanActionRequest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)): return await _plan_action(plan_id, body, user, db, "complete")
