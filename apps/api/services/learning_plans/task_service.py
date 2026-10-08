"""State machine for server-authoritative LearningTask completion."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from models.learning_task import LearningTask, LearningTaskStatus
from models.learning_plan import LearningPlan, LearningPlanStatus


class LearningTaskTransitionError(ValueError):
    """Raised when a task mutation violates its lifecycle."""


class LearningTaskService:
    @staticmethod
    async def _require_active_plan(db: AsyncSession, task: LearningTask) -> LearningPlan:
        """Terminal plans are immutable learning history, not task queues."""
        plan = await db.get(LearningPlan, task.plan_id)
        if not plan or plan.status != LearningPlanStatus.ACTIVE.value:
            raise LearningTaskTransitionError("Tasks can only change while their learning plan is active.")
        return plan

    @staticmethod
    async def create_task(db: AsyncSession, *, plan_id: uuid.UUID, course_id: uuid.UUID, title: str, task_type: str, sequence: int, **values: Any) -> LearningTask:
        task = LearningTask(plan_id=plan_id, course_id=course_id, title=title, task_type=task_type, sequence=sequence, **values)
        db.add(task)
        await db.flush()
        return task

    @staticmethod
    async def start_task(db: AsyncSession, task: LearningTask) -> LearningTask:
        await LearningTaskService._require_active_plan(db, task)
        # Starting an already started task is deliberately idempotent.  This
        # protects a double click / a navigation retry without weakening other
        # task transitions.
        if task.status == LearningTaskStatus.IN_PROGRESS.value:
            return task
        return await LearningTaskService._transition(db, task, {LearningTaskStatus.PENDING.value, LearningTaskStatus.READY.value}, LearningTaskStatus.IN_PROGRESS.value)

    @staticmethod
    async def complete_task(db: AsyncSession, task: LearningTask) -> LearningTask:
        plan = await LearningTaskService._require_active_plan(db, task)
        result = await LearningTaskService._transition(db, task, {LearningTaskStatus.PENDING.value, LearningTaskStatus.READY.value, LearningTaskStatus.IN_PROGRESS.value, LearningTaskStatus.POSTPONED.value, LearningTaskStatus.MISSED.value}, LearningTaskStatus.COMPLETED.value, completed_at=datetime.now(timezone.utc))
        from services.learning_plans.plan_service import LearningPlanService
        await LearningPlanService.complete_if_required_tasks_finished(db, plan)
        return result

    @staticmethod
    async def postpone_task(db: AsyncSession, task: LearningTask, postponed_to: datetime) -> LearningTask:
        await LearningTaskService._require_active_plan(db, task)
        return await LearningTaskService._transition(db, task, {LearningTaskStatus.PENDING.value, LearningTaskStatus.READY.value, LearningTaskStatus.IN_PROGRESS.value, LearningTaskStatus.MISSED.value}, LearningTaskStatus.POSTPONED.value, postponed_to=postponed_to)

    @staticmethod
    async def mark_missed(db: AsyncSession, task: LearningTask) -> LearningTask:
        return await LearningTaskService._transition(db, task, {LearningTaskStatus.PENDING.value, LearningTaskStatus.READY.value, LearningTaskStatus.IN_PROGRESS.value}, LearningTaskStatus.MISSED.value)

    @staticmethod
    async def skip_task(db: AsyncSession, task: LearningTask) -> LearningTask:
        await LearningTaskService._require_active_plan(db, task)
        if task.required:
            raise LearningTaskTransitionError("Required tasks cannot be skipped. Postpone or complete the task instead.")
        return await LearningTaskService._transition(db, task, {LearningTaskStatus.PENDING.value, LearningTaskStatus.READY.value, LearningTaskStatus.IN_PROGRESS.value, LearningTaskStatus.POSTPONED.value, LearningTaskStatus.MISSED.value}, LearningTaskStatus.SKIPPED.value)

    @staticmethod
    async def reopen_task(db: AsyncSession, task: LearningTask) -> LearningTask:
        await LearningTaskService._require_active_plan(db, task)
        return await LearningTaskService._transition(db, task, {LearningTaskStatus.COMPLETED.value, LearningTaskStatus.POSTPONED.value, LearningTaskStatus.MISSED.value, LearningTaskStatus.SKIPPED.value}, LearningTaskStatus.READY.value, completed_at=None, postponed_to=None)

    @staticmethod
    async def _transition(db: AsyncSession, task: LearningTask, allowed: set[str], target: str, **fields: Any) -> LearningTask:
        if task.status == target:
            return task
        if task.status not in allowed:
            raise LearningTaskTransitionError(f"Cannot transition task from {task.status} to {target}.")
        task.status = target
        for key, value in fields.items():
            setattr(task, key, value)
        await db.flush()
        return task
