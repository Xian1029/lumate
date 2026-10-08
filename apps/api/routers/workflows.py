"""Compatibility workflow endpoints used by existing frontend clients.

These endpoints keep legacy `/api/workflows/*` paths functional while the
durable task-based architecture is used under the hood.
"""

from __future__ import annotations

import uuid
from collections import Counter
import logging
import re

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models.content import CourseContentTree
from models.ingestion import WrongAnswer
from models.practice import PracticeProblem
from models.study_plan import StudyPlan
from models.generated_asset import GeneratedAsset
from models.user import User
from services.auth.dependency import get_current_user
from schemas.study_plan import StudyPlanResponse
from services.course_access import get_course_or_404
from services.generated_assets import list_generated_asset_batches, save_generated_asset
from services.learning_plans.legacy_compat import create_plan_from_legacy_markdown

router = APIRouter()
logger = logging.getLogger(__name__)


class ExamPrepRequest(BaseModel):
    course_id: uuid.UUID
    exam_topic: str | None = None
    days_until_exam: int = Field(default=7, ge=1, le=60)
    language: str = "zh"
    content_node_id: uuid.UUID | None = None

    @field_validator("content_node_id", mode="before")
    @classmethod
    def _empty_uuid_to_none(cls, value: object) -> object:
        # Frontend callers may send "" (empty string) for an unselected node;
        # normalize it to None so a normal request never 422s on UUID parsing.
        if value == "" or value is None:
            return None
        return value

    @field_validator("exam_topic", mode="before")
    @classmethod
    def _empty_topic_to_none(cls, value: object) -> object:
        if value == "":
            return None
        return value


class ExamPrepResponse(BaseModel):
    course: str
    topics_count: int
    readiness: dict[str, float]
    days_until_exam: int
    plan: str


class SaveStudyPlanRequest(BaseModel):
    course_id: uuid.UUID
    markdown: str
    title: str | None = None
    replace_batch_id: uuid.UUID | None = None
    source: str = "assistant"
    content_node_id: uuid.UUID | None = None


class WrongAnswerReviewResponse(BaseModel):
    review: str
    wrong_answer_count: int
    wrong_answer_ids: list[str]


async def _sync_plan_tasks_to_calendar(
    db: AsyncSession,
    *, user_id: uuid.UUID,
    course_id: uuid.UUID,
    batch_id: str,
    markdown: str,
    source: str,
    content_node_id: uuid.UUID | None,
    replace_batch_id: uuid.UUID | None,
) -> object:
    """Deprecated compatibility adapter; it no longer writes StudyGoal.

    Keep the function name for old callers, but route all writes to the formal
    LearningPlan/LearningTask domain and make the plan await Plan Review.
    """
    logger.warning("deprecated_legacy_markdown_plan_sync", extra={"course_id": str(course_id)})
    return await create_plan_from_legacy_markdown(
        db,
        user_id=user_id,
        course_id=course_id,
        title="学习计划",
        markdown=markdown,
        source="USER" if source == "manual" else "AI",
        content_node_id=content_node_id,
        generated_asset_batch_id=uuid.UUID(str(batch_id)) if batch_id else None,
        submit_for_review=True,
    )


def _build_exam_prep_markdown(
    *,
    course_id: uuid.UUID,
    content_node_id: uuid.UUID | None,
    course_name: str,
    days_until_exam: int,
    exam_topic: str | None,
    topics: list[str],
    language: str = "zh",
) -> str:
    heading = exam_topic.strip() if exam_topic else course_name
    if language.lower().startswith("zh"):
        node_query = f"&node={content_node_id}" if content_node_id else ""
        quiz_href = f"/course/{course_id}/practice?tab=quiz{node_query}"
        flashcard_href = f"/course/{course_id}/practice?tab=flashcards{node_query}"
        lines = [
            f"# {heading} · {days_until_exam} 天学习计划",
            "",
            "每一天都有明确产出：弄清概念、完成练习、订正问题。可以按自己的基础适当增减题量，但不要跳过订正。",
            "",
        ]
        if not topics:
            topics = ["课本里的重点", "容易弄错的地方", "基础练习"]

        for day in range(1, days_until_exam + 1):
            idx = (day - 1) % len(topics)
            focus = topics[idx]
            secondary = topics[(idx + 1) % len(topics)] if len(topics) > 1 else None
            stage = ("理解与建构" if day % 3 == 1 else "检索与辨析" if day % 3 == 2 else "练习与迁移")
            lines.append(f"## 第 {day} 天 · {stage}")
            lines.append(f"- [ ] **梳理关键点：**[打开学习笔记]({quiz_href.replace('practice?tab=quiz', 'notes')})，围绕“{focus}”写下 3 个关键词、关键条件或公式，并用自己的话解释其中 1 个。")
            if secondary and secondary != focus:
                lines.append(f"- [ ] **主动回忆：**[使用对应闪卡]({flashcard_href})，不看答案说出“{secondary}”的定义、步骤或易混点；答不出时补充到笔记。")
            else:
                lines.append(f"- [ ] **主动回忆：**[使用对应闪卡]({flashcard_href})，先独立作答，再核对并标记不确定的卡片。")
            lines.append(f"- [ ] **针对练习：**[完成本小节测验]({quiz_href})，独立完成 6～10 题；每道错题标注是概念、审题、步骤还是计算问题。")
            lines.append("- [ ] **订正与复盘：**选 1 道错题重新完整作答，写下“错因 → 正确规则 → 下次检查点”。")
            lines.append("- 建议用时：30～45 分钟；完成核心任务后可挑战一道综合题。")
            lines.append("")

        lines.append("## 阶段检查 · 用结果确认掌握")
        lines.append(f"- [ ] [复习未掌握的闪卡]({flashcard_href})和错题，确保每张卡都能独立解释。")
        lines.append(f"- [ ] [完成一组限时小测]({quiz_href})，按实际考试或作业要求书写关键步骤。")
        lines.append("- [ ] **形成清单：**整理本阶段仍不稳的 3 个点，并为每个点写一个下一次复习动作。")
        lines.append("- [ ] **调整节奏：**如果正确率或完成感不理想，优先回到错因最多的知识点，不盲目加题。")
        return "\n".join(lines).strip()

    lines = [
        f"# {days_until_exam}-Day Exam Prep Plan",
        "",
        f"Target: **{heading}**",
        "",
    ]
    if not topics:
        topics = ["Core concepts", "Common pitfalls", "Timed practice"]

    for day in range(1, days_until_exam + 1):
        idx = (day - 1) % len(topics)
        focus = topics[idx]
        secondary = topics[(idx + 1) % len(topics)] if len(topics) > 1 else None
        lines.append(f"## Day {day}")
        lines.append(f"- Primary focus: {focus}")
        if secondary and secondary != focus:
            lines.append(f"- Secondary focus: {secondary}")
        lines.append("- Practice: 30-45 minutes of mixed questions")
        lines.append("- Reflection: record 2 mistakes and 1 correction rule")
        lines.append("")

    lines.append("## Final 24 Hours")
    lines.append("- Run one timed mock set")
    lines.append("- Review your error log and formula/definition sheet")
    lines.append("- Keep answers concise and show reasoning steps")
    return "\n".join(lines).strip()


@router.post("/exam-prep", response_model=ExamPrepResponse)
async def exam_prep_plan(
    body: ExamPrepRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    course = await get_course_or_404(db, body.course_id, user_id=user.id)

    note_result = await db.execute(
        select(GeneratedAsset).where(
            GeneratedAsset.user_id == user.id,
            GeneratedAsset.course_id == body.course_id,
            GeneratedAsset.asset_type == "notes",
            GeneratedAsset.is_archived == False,  # noqa: E712
        ).order_by(GeneratedAsset.updated_at.desc())
    )
    notes = note_result.scalars().all()
    if body.content_node_id:
        notes = [note for note in notes if str((note.metadata_ or {}).get("source_node_id") or "") == str(body.content_node_id)]
    raw_titles: list[str] = []
    ignored = re.compile(
        r"前言|目录|封面|出版|编者|教材|课本|\.pdf|学习目标|我们学什么|本章小结|"
        r"contents?|preface|copyright|learning objectives?",
        re.IGNORECASE,
    )
    for note in notes:
        markdown = str((note.content or {}).get("markdown") or "")
        note_headings: list[str] = []
        for heading in re.findall(r"^#{1,4}\s+(.+)$", markdown, re.MULTILINE):
            title = re.sub(r"[*_`]", "", heading).strip()
            if title and not ignored.search(title):
                raw_titles.append(title)
                note_headings.append(title)
        # The saved note title is often just the uploaded PDF filename. Use it
        # only when the note has no meaningful internal headings.
        if not note_headings and note.title and not ignored.search(note.title):
            raw_titles.append(note.title.strip())
    if not raw_titles:
        from libs.exceptions import ValidationError
        raise ValidationError("当前小节还没有可用的学习笔记，请先选择小节并生成笔记。")
    seen: set[str] = set()
    topics: list[str] = []
    for title in raw_titles:
        normalized = title.lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        topics.append(title)
        if len(topics) >= 24:
            break

    days = int(body.days_until_exam)
    coverage = min(1.0, len(topics) / max(days * 2, 1))
    readiness = {
        "coverage": round(coverage, 2),
        "consistency": round(min(1.0, days / 14), 2),
        "confidence": round(max(0.2, min(0.9, 0.45 + coverage * 0.4)), 2),
    }
    plan = _build_exam_prep_markdown(
        course_id=body.course_id,
        content_node_id=body.content_node_id,
        course_name=course.name,
        days_until_exam=days,
        exam_topic=body.exam_topic,
        topics=topics,
        language=body.language,
    )
    return ExamPrepResponse(
        course=course.name,
        topics_count=len(topics),
        readiness=readiness,
        days_until_exam=days,
        plan=plan,
    )


@router.post("/study-plans/save")
async def save_study_plan(
    body: SaveStudyPlanRequest,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Deprecated write endpoint kept only for legacy clients.

    It stores an optional Markdown snapshot and creates a PENDING_APPROVAL
    LearningPlan through the central compatibility adapter. It never creates
    StudyGoal or StudyPlan rows.
    """
    response.headers["Deprecation"] = "true"
    response.headers["Link"] = '</api/learning-plans>; rel="successor-version"'
    logger.warning("deprecated_study_plan_save_endpoint", extra={"course_id": str(body.course_id)})
    await get_course_or_404(db, body.course_id, user_id=user.id)
    result = await save_generated_asset(
        db,
        user_id=user.id,
        course_id=body.course_id,
        asset_type="study_plan",
        title=body.title or "Study Plan",
        content={"markdown": body.markdown},
        metadata={
            "source": body.source,
            "content_node_id": str(body.content_node_id) if body.content_node_id else None,
        },
        replace_batch_id=body.replace_batch_id,
    )
    plan = await _sync_plan_tasks_to_calendar(
        db,
        user_id=user.id,
        course_id=body.course_id,
        batch_id=result["batch_id"],
        markdown=body.markdown,
        source=body.source,
        content_node_id=body.content_node_id,
        replace_batch_id=body.replace_batch_id,
    )
    await db.commit()
    return {**result, "learning_plan_id": str(plan.id), "plan_status": plan.status}


@router.get("/study-plans/{course_id}")
async def list_study_plans(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Deprecated read-only history API. This endpoint has no write effects."""
    await get_course_or_404(db, course_id, user_id=user.id)
    return await list_generated_asset_batches(
        db,
        user_id=user.id,
        course_id=course_id,
        asset_type="study_plan",
    )


@router.get("/courses/{course_id}/study-plans", response_model=list[StudyPlanResponse])
async def list_persisted_study_plans(
    course_id: uuid.UUID,
    limit: int = Query(default=5, ge=1, le=20),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Deprecated, read-only StudyPlan history. New plans use LearningPlan."""
    await get_course_or_404(db, course_id, user_id=user.id)
    result = await db.execute(
        select(StudyPlan)
        .where(StudyPlan.course_id == course_id, StudyPlan.user_id == user.id)
        .order_by(StudyPlan.created_at.desc())
        .limit(limit)
    )
    return result.scalars().all()


@router.get("/wrong-answer-review", response_model=WrongAnswerReviewResponse)
async def wrong_answer_review(
    course_id: uuid.UUID,
    language: str = Query(default="en", min_length=2, max_length=16),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_course_or_404(db, course_id, user_id=user.id)
    result = await db.execute(
        select(WrongAnswer, PracticeProblem)
        .join(PracticeProblem, WrongAnswer.problem_id == PracticeProblem.id)
        .where(
            WrongAnswer.user_id == user.id,
            WrongAnswer.course_id == course_id,
        )
        .order_by(WrongAnswer.created_at.desc())
    )
    grouped: dict[uuid.UUID, tuple[WrongAnswer, PracticeProblem, int]] = {}
    for item, problem in result.all():
        existing = grouped.get(item.problem_id)
        count = max(int(item.wrong_attempt_count or 1), 1)
        if existing is None:
            grouped[item.problem_id] = (item, problem, count)
        else:
            grouped[item.problem_id] = (existing[0], existing[1], existing[2] + count)
    rows = [item for item in grouped.values() if not item[0].mastered][:20]
    is_zh = language.lower().startswith("zh")

    category_zh = {
        "conceptual": "概念理解",
        "reading": "审题理解",
        "careless": "粗心失误",
        "carelessness": "粗心失误",
        "procedural": "解题步骤",
        "calculation": "计算错误",
        "knowledge_gap": "知识点缺口",
        "fundamental_gap": "基础理解不足",
        "transfer_gap": "知识迁移不足",
        "trap_vulnerability": "容易受到题目干扰",
        "uncategorized": "暂未分类",
    }

    def display_category(category: str) -> str:
        normalized = category.strip().lower().replace(" ", "_")
        if is_zh:
            return category_zh.get(normalized, category.replace("_", " "))
        return category.replace("_", " ").title()

    wrong_ids = [str(item.id) for item, _, _ in rows]
    if not rows:
        return WrongAnswerReviewResponse(
            review=(
                "# 错题复盘\n\n当前没有未掌握的错题，继续保持！"
                if is_zh
                else "# Wrong Answer Review\n\nNo unmastered items. Great work."
            ),
            wrong_answer_count=0,
            wrong_answer_ids=[],
        )

    categories = Counter((item.error_category or "uncategorized") for item, _, _ in rows)
    lines = (
        [
            "# 🕵️ 错题小侦探",
            "",
            f"今天找到 **{len(rows)} 道**值得再看一眼的题。错题不是扣分记录，而是告诉我们下一步练哪里。",
            "",
            "## 🔍 我最容易卡在哪里？",
        ]
        if is_zh
        else [
            "# Wrong Answer Review",
            "",
            f"- Unmastered items: **{len(rows)}**",
            "",
            "## Top Error Patterns",
        ]
    )
    for category, count in categories.most_common():
        lines.append(f"- {display_category(category)}：{count}" if is_zh else f"- {display_category(category)}: {count}")

    lines.append("")
    lines.append("## 🌱 先看这几道题" if is_zh else "## Priority Questions")
    for idx, (item, problem, wrong_attempt_count) in enumerate(rows[:5], start=1):
        lines.append(f"### 第 {idx} 题：{problem.question}" if is_zh else f"### {idx}. {problem.question}")
        if wrong_attempt_count > 1:
            lines.append(f"   - 这道题累计答错 {wrong_attempt_count} 次" if is_zh else f"   - Incorrect attempts: {wrong_attempt_count}")
        if item.user_answer:
            label = "我当时写的是" if is_zh else "Your answer"
            lines.append(f"   - {label}：`{item.user_answer}`" if is_zh else f"   - {label}: `{item.user_answer}`")
        if item.correct_answer:
            label = "可以这样回答" if is_zh else "Correct answer"
            lines.append(f"   - {label}：`{item.correct_answer}`" if is_zh else f"   - {label}: `{item.correct_answer}`")
        if item.explanation:
            label = "关键想法" if is_zh else "Why"
            lines.append(f"   - {label}：{item.explanation}" if is_zh else f"   - {label}: {item.explanation}")
        lines.append("")

    if is_zh:
        lines.append("## 🚀 接下来怎么做？")
        lines.append("1. 先挑最前面的 1 道题，看懂“关键想法”。")
        lines.append("2. 点击“换一道简单题试试”，确认自己真的理解了。")
        lines.append("3. 答完后，用一句自己的话说说为什么这样做。")
    else:
        lines.append("## Next Action")
        lines.append("- Retry top 3 questions and explain your reasoning in one sentence each.")

    return WrongAnswerReviewResponse(
        review="\n".join(lines).strip(),
        wrong_answer_count=len(rows),
        wrong_answer_ids=wrong_ids,
    )
