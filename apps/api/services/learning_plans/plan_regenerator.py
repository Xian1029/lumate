"""Deterministic regeneration of a LearningPlan's task schedule.

"重新生成" must not require an LLM round-trip: the plan's own parameters
(target date, minutes per day, study days of week) plus the course content
tree already define a reasonable schedule.  This module rebuilds the task
list from those inputs so a student always gets an executable plan even
when the original AI-generated tasks were removed or never existed.

Ordering rules (先学后学):
- Content nodes are taken in tree order (order_index within the course),
  restricted to learnable leaf knowledge (level >= 1, non-info categories).
- Every few learn tasks a PRACTICE task is inserted; a REVIEW task is
  appended at the end of each study week so revision is part of the loop.

Scheduling rules:
- Tasks are packed day-by-day starting today, honouring
  ``study_days_of_week`` (0=Sunday .. 6=Saturday) and
  ``available_minutes_per_day``; a day is "full" once its estimated minutes
  reach the daily budget.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.content import CourseContentTree, INFO_CATEGORIES
from models.learning_plan import LearningPlan, LearningPlanStatus
from models.learning_task import LearningTask, LearningTaskStatus
from services.learning_plans.action_links import build_action_href
from services.learning_plans.task_service import LearningTaskService

# States in which the task list may be rebuilt.
REGENERATABLE_STATES = {
    LearningPlanStatus.DRAFT.value,
    LearningPlanStatus.PENDING_APPROVAL.value,
    LearningPlanStatus.CHANGES_REQUESTED.value,
}

LEARN_MINUTES = 20
PRACTICE_MINUTES = 15
REVIEW_MINUTES = 15
DEFAULT_DAILY_MINUTES = 30
PRACTICE_EVERY_N_LEARNS = 3
MAX_TASKS = 120


class PlanRegenerationError(ValueError):
    """Raised when a plan cannot be regenerated in its current state."""


def _next_study_days(start: datetime, weekdays: list[int] | None, count: int) -> list[datetime]:
    """Return the next ``count`` calendar days allowed by ``weekdays``.

    ``weekdays`` uses 0=Sunday .. 6=Saturday (matching the frontend form).
    ``None`` or empty means every day is a study day.
    """
    allowed = set(weekdays) if weekdays else set(range(7))
    days: list[datetime] = []
    cursor = start
    # python weekday(): Monday=0..Sunday=6 → convert to Sunday=0..Saturday=6
    while len(days) < count:
        sunday_first = (cursor.weekday() + 1) % 7
        if sunday_first in allowed:
            days.append(cursor)
        cursor += timedelta(days=1)
    return days


def _study_days_through_deadline(
    start: datetime,
    deadline: date | None,
    weekdays: list[int] | None,
) -> list[datetime]:
    """Return valid study days without scheduling beyond the requested date.

    A same-day plan intentionally returns today even when a weekday filter from
    an older form would otherwise exclude it: the explicit target date is the
    learner's latest instruction.
    """
    if deadline is None:
        return []
    last = max(start.date(), deadline)
    allowed = set(weekdays) if weekdays else set(range(7))
    days: list[datetime] = []
    cursor = start
    while cursor.date() <= last:
        sunday_first = (cursor.weekday() + 1) % 7
        if sunday_first in allowed:
            days.append(cursor)
        cursor += timedelta(days=1)
    if not days:
        days.append(start)
    return days


async def regenerate_plan_tasks(
    db: AsyncSession,
    plan: LearningPlan,
    actor_user_id: uuid.UUID,
) -> list[LearningTask]:
    """Delete pending tasks of ``plan`` and rebuild them from the content tree."""
    if plan.status not in REGENERATABLE_STATES:
        raise PlanRegenerationError(
            f"Cannot regenerate a plan in {plan.status}; only draft or pending plans can be regenerated."
        )

    # Keep history of finished work; remove everything not yet completed.
    await db.execute(
        delete(LearningTask).where(
            LearningTask.plan_id == plan.id,
            LearningTask.status != LearningTaskStatus.COMPLETED.value,
        )
    )
    await db.flush()

    # Learnable leaf nodes in tree order (chapters/sections, not logistics).
    nodes = (
        await db.execute(
            select(CourseContentTree)
            .where(CourseContentTree.course_id == plan.course_id)
            .order_by(CourseContentTree.order_index, CourseContentTree.created_at)
        )
    ).scalars().all()
    parent_ids = {n.parent_id for n in nodes if n.parent_id is not None}
    learnable = [
        n for n in nodes
        if n.level >= 1
        and n.id not in parent_ids
        and (n.content_category or "") not in INFO_CATEGORIES
        and n.title.strip()
    ][:MAX_TASKS]
    # AI plans are explicitly scoped by the learner's chapter selection. A
    # selected chapter includes its descendants, but never unrelated nodes.
    selected_ids = {str(value) for value in ((plan.draft_payload or {}).get("selected_content_node_ids") or [])}
    if selected_ids:
        allowed_ids = set(selected_ids)
        changed = True
        while changed:
            changed = False
            for node in nodes:
                if node.parent_id and str(node.parent_id) in allowed_ids and str(node.id) not in allowed_ids:
                    allowed_ids.add(str(node.id))
                    changed = True
        learnable = [node for node in learnable if str(node.id) in allowed_ids]
    if not learnable:
        raise PlanRegenerationError("所选章节没有可学习内容，请重新选择教材章节。")

    daily_budget = plan.available_minutes_per_day or DEFAULT_DAILY_MINUTES
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    # Build the ordered (type, node, minutes) stream: learn ×N → practice → … → review per week.
    stream: list[tuple[str, CourseContentTree | None, int, str]] = []
    learn_since_practice = 0
    for index, node in enumerate(learnable):
        stream.append(("LEARN", node, LEARN_MINUTES, f"学习「{node.title}」的核心内容"))
        learn_since_practice += 1
        if learn_since_practice >= PRACTICE_EVERY_N_LEARNS:
            stream.append(("PRACTICE", node, PRACTICE_MINUTES, f"完成「{node.title}」相关练习，巩固刚学的内容"))
            learn_since_practice = 0
        if (index + 1) % (PRACTICE_EVERY_N_LEARNS * 2) == 0:
            stream.append(("REVIEW", None, REVIEW_MINUTES, "回顾本周学过的内容，检查掌握情况"))
    # Always end the schedule with a review so the loop closes.
    if not any(kind == "REVIEW" for kind, _, _, _ in stream):
        stream.append(("REVIEW", None, REVIEW_MINUTES, "回顾本阶段学过的内容，检查掌握情况"))

    # Pack into study days.
    day_count_estimate = max(1, sum(m for _, _, m, _ in stream) // daily_budget + 1)
    deadline_days = _study_days_through_deadline(today, plan.target_date, plan.study_days_of_week)
    study_days = deadline_days or _next_study_days(today, plan.study_days_of_week, day_count_estimate + 7)

    tasks: list[LearningTask] = []
    day_index = 0
    day_minutes = 0
    sequence = 0
    completed_max_seq = await db.scalar(
        select(LearningTask.sequence)
        .where(LearningTask.plan_id == plan.id)
        .order_by(LearningTask.sequence.desc())
        .limit(1)
    ) or 0

    for task_type, node, minutes, instruction in stream:
        if day_minutes + minutes > daily_budget and day_minutes > 0 and day_index < len(study_days) - 1:
            day_index += 1
            day_minutes = 0
        scheduled = study_days[min(day_index, len(study_days) - 1)]
        node_id = node.id if node else None
        sequence = completed_max_seq + len(tasks) + 1
        task = await LearningTaskService.create_task(
            db,
            plan_id=plan.id,
            course_id=plan.course_id,
            content_node_id=node_id,
            task_type=task_type,
            title=instruction[:300],
            instruction=instruction,
            action_href=build_action_href(
                task_type=task_type,
                course_id=plan.course_id,
                content_node_id=node_id,
                node_exists=node is not None,
            ),
            scheduled_for=scheduled,
            estimated_minutes=minutes,
            sequence=sequence,
            planning_reason="由「重新生成」按课程结构自动编排",
            metadata_json={"regenerated": True, "regenerated_by": str(actor_user_id)},
        )
        tasks.append(task)
        day_minutes += minutes

    plan.total_estimated_minutes = sum(task.estimated_minutes or 0 for task in tasks)
    await db.flush()
    return tasks
