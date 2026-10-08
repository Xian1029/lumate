"""State machine for the authoritative LearningPlan domain."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import func, select

from models.audit_log import AuditLog
from models.learning_plan import LearningPlan, LearningPlanSource, LearningPlanStatus


class LearningPlanTransitionError(ValueError):
    """Raised when a plan state change is not part of the domain state machine."""


class LearningPlanService:
    """All LearningPlan status mutations live here, never in routers or React."""

    @staticmethod
    async def create_draft(db: AsyncSession, *, user_id: uuid.UUID, course_id: uuid.UUID, title: str, **values: Any) -> LearningPlan:
        source = values.pop("source", LearningPlanSource.USER.value)
        source = source.value if isinstance(source, LearningPlanSource) else source
        plan = LearningPlan(user_id=user_id, course_id=course_id, title=title, source=source, status=LearningPlanStatus.DRAFT.value, **values)
        db.add(plan)
        await db.flush()
        await LearningPlanService._audit(db, plan, user_id, None, plan.status, "create", None)
        return plan

    @staticmethod
    async def submit_for_approval(db: AsyncSession, plan: LearningPlan, actor_user_id: uuid.UUID, reason: str | None = None) -> LearningPlan:
        return await LearningPlanService._transition(db, plan, actor_user_id, {LearningPlanStatus.DRAFT.value}, LearningPlanStatus.PENDING_APPROVAL.value, "submit_for_approval", reason)

    @staticmethod
    async def approve(db: AsyncSession, plan: LearningPlan, actor_user_id: uuid.UUID, reason: str | None = None) -> LearningPlan:
        now = datetime.now(timezone.utc)
        return await LearningPlanService._transition(db, plan, actor_user_id, {LearningPlanStatus.PENDING_APPROVAL.value}, LearningPlanStatus.ACTIVE.value, "approve", reason, approved_at=now, activated_at=now)

    @staticmethod
    async def request_changes(db: AsyncSession, plan: LearningPlan, actor_user_id: uuid.UUID, reason: str | None = None) -> LearningPlan:
        return await LearningPlanService._transition(db, plan, actor_user_id, {LearningPlanStatus.PENDING_APPROVAL.value}, LearningPlanStatus.CHANGES_REQUESTED.value, "request_changes", reason)

    @staticmethod
    async def revise_to_draft(db: AsyncSession, plan: LearningPlan, actor_user_id: uuid.UUID, reason: str | None = None) -> LearningPlan:
        """Return a requested-for-change plan to an editable draft before resubmission."""
        return await LearningPlanService._transition(db, plan, actor_user_id, {LearningPlanStatus.CHANGES_REQUESTED.value}, LearningPlanStatus.DRAFT.value, "revise_to_draft", reason)

    @staticmethod
    async def activate(db: AsyncSession, plan: LearningPlan, actor_user_id: uuid.UUID, reason: str | None = None) -> LearningPlan:
        return await LearningPlanService._transition(db, plan, actor_user_id, {LearningPlanStatus.PAUSED.value}, LearningPlanStatus.ACTIVE.value, "activate", reason, activated_at=datetime.now(timezone.utc))

    @staticmethod
    async def pause(db: AsyncSession, plan: LearningPlan, actor_user_id: uuid.UUID, reason: str | None = None) -> LearningPlan:
        return await LearningPlanService._transition(db, plan, actor_user_id, {LearningPlanStatus.ACTIVE.value}, LearningPlanStatus.PAUSED.value, "pause", reason, paused_at=datetime.now(timezone.utc))

    @staticmethod
    async def resume(db: AsyncSession, plan: LearningPlan, actor_user_id: uuid.UUID, reason: str | None = None) -> LearningPlan:
        return await LearningPlanService.activate(db, plan, actor_user_id, reason)

    @staticmethod
    async def cancel(db: AsyncSession, plan: LearningPlan, actor_user_id: uuid.UUID, reason: str | None = None) -> LearningPlan:
        allowed = {LearningPlanStatus.DRAFT.value, LearningPlanStatus.PENDING_APPROVAL.value, LearningPlanStatus.CHANGES_REQUESTED.value, LearningPlanStatus.ACTIVE.value, LearningPlanStatus.PAUSED.value}
        return await LearningPlanService._transition(db, plan, actor_user_id, allowed, LearningPlanStatus.CANCELLED.value, "cancel", reason, cancelled_at=datetime.now(timezone.utc))

    @staticmethod
    async def complete(db: AsyncSession, plan: LearningPlan, actor_user_id: uuid.UUID, reason: str | None = None) -> LearningPlan:
        return await LearningPlanService._transition(db, plan, actor_user_id, {LearningPlanStatus.ACTIVE.value}, LearningPlanStatus.COMPLETED.value, "complete", reason, completed_at=datetime.now(timezone.utc))

    @staticmethod
    async def complete_if_required_tasks_finished(db: AsyncSession, plan: LearningPlan) -> bool:
        """Server-side completion rule; UI must never infer this from rendered cards."""
        if plan.status != LearningPlanStatus.ACTIVE.value:
            return False
        from models.learning_task import LearningTask, LearningTaskStatus
        required_count = await db.scalar(select(func.count(LearningTask.id)).where(LearningTask.plan_id == plan.id, LearningTask.required.is_(True)))
        unfinished_count = await db.scalar(select(func.count(LearningTask.id)).where(LearningTask.plan_id == plan.id, LearningTask.required.is_(True), LearningTask.status != LearningTaskStatus.COMPLETED.value))
        if not required_count or unfinished_count:
            return False
        await LearningPlanService.complete(db, plan, plan.user_id, "All required learning tasks were completed")
        return True

    @staticmethod
    async def _transition(db: AsyncSession, plan: LearningPlan, actor_user_id: uuid.UUID, allowed: set[str], target: str, action: str, reason: str | None, **timestamps: Any) -> LearningPlan:
        # HTTP retries and two UI entry points may legitimately deliver the
        # same command twice.  A command which has already reached its target
        # is successful; it must not be reported as an optimistic-lock error.
        if plan.status == target:
            return plan
        if plan.status not in allowed:
            expected = ", ".join(sorted(allowed))
            raise LearningPlanTransitionError(f"Cannot {action} a plan in {plan.status}; expected: {expected}.")
        old_status = plan.status
        plan.status = target
        plan.version += 1
        for key, value in timestamps.items():
            setattr(plan, key, value)
        await db.flush()
        await LearningPlanService._audit(db, plan, actor_user_id, old_status, target, action, reason)
        return plan

    @staticmethod
    async def _audit(db: AsyncSession, plan: LearningPlan, actor_user_id: uuid.UUID, old_status: str | None, new_status: str, action: str, reason: str | None) -> None:
        db.add(AuditLog(actor_user_id=actor_user_id, action_kind="learning_plan.status_transition", approval_status=new_status, outcome="success", details_json={"plan_id": str(plan.id), "old_status": old_status, "new_status": new_status, "actor_user_id": str(actor_user_id), "action": action, "reason": reason}))
        await db.flush()
