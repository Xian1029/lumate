"""Focused domain tests for the authoritative LearningPlan lifecycle."""

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from database import Base
from models.audit_log import AuditLog
from models.course import Course
from models.learning_plan import LearningPlanStatus
from models.learning_task import LearningTaskStatus
from models.user import User
from routers.learning_plans import _owned_plan
from routers.learning_tasks import _owned_task
from services.learning_plans import (
    LearningPlanService,
    LearningPlanTransitionError,
    LearningTaskService,
    LearningTaskTransitionError,
)


@pytest_asyncio.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        user = User(name="Plan owner")
        db.add(user)
        await db.flush()
        course = Course(user_id=user.id, name="Math")
        db.add(course)
        await db.commit()
        yield db, user, course
    await engine.dispose()


@pytest.mark.asyncio
async def test_plan_lifecycle_and_audit(session):
    db, user, course = session
    plan = await LearningPlanService.create_draft(db, user_id=user.id, course_id=course.id, title="Week one")
    assert plan.status == LearningPlanStatus.DRAFT.value
    await LearningPlanService.submit_for_approval(db, plan, user.id)
    assert plan.status == LearningPlanStatus.PENDING_APPROVAL.value
    await LearningPlanService.approve(db, plan, user.id)
    assert plan.status == LearningPlanStatus.ACTIVE.value
    await LearningPlanService.pause(db, plan, user.id)
    assert plan.status == LearningPlanStatus.PAUSED.value
    await LearningPlanService.resume(db, plan, user.id)
    await LearningPlanService.complete(db, plan, user.id)
    assert plan.status == LearningPlanStatus.COMPLETED.value
    transitions = (await db.execute(select(AuditLog).where(AuditLog.action_kind == "learning_plan.status_transition"))).scalars().all()
    assert len(transitions) == 6
    assert transitions[-1].details_json["new_status"] == "COMPLETED"


@pytest.mark.asyncio
async def test_changes_requested_and_illegal_transition(session):
    db, user, course = session
    plan = await LearningPlanService.create_draft(db, user_id=user.id, course_id=course.id, title="Draft")
    await LearningPlanService.submit_for_approval(db, plan, user.id)
    await LearningPlanService.request_changes(db, plan, user.id, "Please add practice")
    assert plan.status == LearningPlanStatus.CHANGES_REQUESTED.value
    await LearningPlanService.revise_to_draft(db, plan, user.id)
    assert plan.status == LearningPlanStatus.DRAFT.value
    with pytest.raises(LearningPlanTransitionError):
        await LearningPlanService.complete(db, plan, user.id)


@pytest.mark.asyncio
async def test_task_lifecycle_and_non_browser_completion(session):
    db, user, course = session
    plan = await LearningPlanService.create_draft(db, user_id=user.id, course_id=course.id, title="Tasks")
    task = await LearningTaskService.create_task(db, plan_id=plan.id, course_id=course.id, title="Read", task_type="LEARN", sequence=1)
    with pytest.raises(LearningTaskTransitionError):
        await LearningTaskService.start_task(db, task)
    await LearningPlanService.submit_for_approval(db, plan, user.id)
    await LearningPlanService.approve(db, plan, user.id)
    await LearningTaskService.start_task(db, task)
    assert task.status == LearningTaskStatus.IN_PROGRESS.value
    # A lost client response or double click is a successful no-op, not a 409.
    await LearningTaskService.start_task(db, task)
    await LearningTaskService.complete_task(db, task)
    assert task.status == LearningTaskStatus.COMPLETED.value
    assert task.completed_at is not None
    # Completing the only required task completes the plan.  Historical task
    # records must not be reopened into an already completed plan.
    assert plan.status == LearningPlanStatus.COMPLETED.value
    with pytest.raises(LearningTaskTransitionError):
        await LearningTaskService.reopen_task(db, task)
    with pytest.raises(LearningTaskTransitionError):
        await LearningTaskService.postpone_task(db, task, task.created_at)
    with pytest.raises(LearningTaskTransitionError):
        await LearningTaskService.skip_task(db, task)
    optional_task = await LearningTaskService.create_task(db, plan_id=plan.id, course_id=course.id, title="Optional", task_type="NOTE", sequence=2, required=False)
    with pytest.raises(LearningTaskTransitionError):
        await LearningTaskService.skip_task(db, optional_task)


@pytest.mark.asyncio
async def test_active_plan_completes_when_its_last_required_task_completes(session):
    db, user, course = session
    plan = await LearningPlanService.create_draft(db, user_id=user.id, course_id=course.id, title="Auto complete")
    await LearningPlanService.submit_for_approval(db, plan, user.id)
    await LearningPlanService.approve(db, plan, user.id)
    task = await LearningTaskService.create_task(db, plan_id=plan.id, course_id=course.id, title="Required", task_type="LEARN", sequence=1)
    await LearningTaskService.complete_task(db, task)
    assert plan.status == LearningPlanStatus.COMPLETED.value


@pytest.mark.asyncio
async def test_cross_user_plan_and_task_access_is_rejected(session):
    db, owner, course = session
    plan = await LearningPlanService.create_draft(db, user_id=owner.id, course_id=course.id, title="Private")
    task = await LearningTaskService.create_task(db, plan_id=plan.id, course_id=course.id, title="Private task", task_type="LEARN", sequence=1)
    stranger = User(name="Other learner")
    db.add(stranger)
    await db.flush()
    from libs.exceptions import NotFoundError
    with pytest.raises(NotFoundError):
        await _owned_plan(db, plan.id, stranger.id)
    with pytest.raises(NotFoundError):
        await _owned_task(db, task.id, stranger.id)
