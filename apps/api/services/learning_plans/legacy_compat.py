"""The only adapter from legacy Markdown plans to the authoritative domain.

Legacy endpoints may retain historical links, but they must never create a
``StudyGoal`` or ``StudyPlan``.  This module is the one allowed bridge and
creates an explicit LearningPlan review candidate instead.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from models.learning_plan import LearningPlan, LearningPlanSource
from services.learning_plans.plan_service import LearningPlanService
from services.learning_plans.task_service import LearningTaskService
from services.legacy_plan_monitor import record_legacy_write


def extract_legacy_markdown_tasks(markdown: str) -> list[tuple[int, str, str | None]]:
    """Parse historic checklist text into data for LearningTask creation only."""
    tasks: list[tuple[int, str, str | None]] = []
    current_day = 1
    for raw_line in markdown.splitlines():
        line = raw_line.strip()
        day_match = re.search(r"第\s*(\d+)\s*天|Day\s*(\d+)", line, re.IGNORECASE)
        if day_match:
            current_day = int(day_match.group(1) or day_match.group(2))
            continue
        task_match = re.match(r"[-*]\s*\[[ xX]\]\s*(.+)", line)
        if not task_match:
            continue
        raw_task = task_match.group(1).strip()
        href_match = re.search(r"\[[^\]]+\]\((/course/[^)]+)\)", raw_task)
        href = href_match.group(1) if href_match else None
        title = re.sub(r"\[([^\]]+)\]\(/course/[^)]+\)", r"\1", raw_task)
        title = re.sub(r"[*_`]", "", title).strip()
        if title:
            tasks.append((current_day, title[:300], href))
    return tasks


def _task_type(title: str) -> str:
    lowered = title.lower()
    if "闪卡" in title or "flashcard" in lowered:
        return "FLASHCARD"
    if any(token in title for token in ("测验", "小测", "检测")) or "quiz" in lowered:
        return "ASSESSMENT"
    if any(token in title for token in ("复习", "错题")) or "review" in lowered:
        return "REVIEW"
    if any(token in title for token in ("笔记", "整理")) or "note" in lowered:
        return "NOTE"
    if any(token in title for token in ("练习", "习题")) or "practice" in lowered:
        return "PRACTICE"
    return "LEARN"


async def create_plan_from_legacy_markdown(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    course_id: uuid.UUID,
    title: str,
    markdown: str,
    source: str = LearningPlanSource.AI.value,
    content_node_id: uuid.UUID | None = None,
    generated_asset_batch_id: uuid.UUID | None = None,
    submit_for_review: bool,
) -> LearningPlan:
    """Create a formal plan from a legacy payload without legacy task writes.

    ``submit_for_review`` is true only after an explicit user action at a
    legacy compatibility endpoint. AI generation alone creates a DRAFT.
    """
    record_legacy_write("legacy_markdown_adapter", course_id=str(course_id), submit_for_review=submit_for_review)
    source = source if source in {item.value for item in LearningPlanSource} else LearningPlanSource.AI.value
    plan = await LearningPlanService.create_draft(
        db,
        user_id=user_id,
        course_id=course_id,
        title=title.strip()[:200] or "学习计划",
        source=source,
        generated_asset_batch_id=generated_asset_batch_id,
        draft_payload={"legacy_markdown": markdown, "compatibility_source": "legacy_markdown_adapter"},
    )
    today = datetime.now(timezone.utc)
    parsed = extract_legacy_markdown_tasks(markdown)
    for sequence, (day, task_title, href) in enumerate(parsed, start=1):
        await LearningTaskService.create_task(
            db,
            plan_id=plan.id,
            course_id=course_id,
            content_node_id=content_node_id,
            task_type=_task_type(task_title),
            title=task_title,
            instruction=task_title,
            action_href=href,
            scheduled_for=today + timedelta(days=max(0, day - 1)),
            sequence=sequence,
            metadata_json={"compatibility_source": "legacy_markdown_adapter", "plan_day": day},
        )
    if submit_for_review:
        await LearningPlanService.submit_for_approval(
            db, plan, user_id, "Created through deprecated Markdown compatibility endpoint"
        )
    return plan
