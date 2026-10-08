"""Wrong answer management API — v3 error review system.

Endpoints for listing wrong answers, retrying, and generating derived questions.
"""

import logging
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models.ingestion import WrongAnswer
from models.practice import PracticeProblem
from models.user import User
from schemas.wrong_answer import (
    DeriveResponse,
    DiagnoseResponse,
    RetryRequest,
    RetryResponse,
    WrongAnswerResponse,
    WrongAnswerStatsResponse,
)
from services.auth.dependency import get_current_user
from services.course_access import get_course_or_404
from services.diagnosis.derive import derive_diagnostic
from libs.exceptions import NotFoundError

logger = logging.getLogger(__name__)

router = APIRouter()


def _friendly_diagnosis_message(diagnosis: str, *, is_zh: bool) -> str:
    if is_zh:
        return {
            "fundamental_gap": "这个知识点还需要再练一练。先看看例子，再试一道更基础的题。",
            "trap_vulnerability": "你已经懂基本方法了，下次读题时圈出关键词，就更不容易被绕住。",
            "carelessness": "方法基本会了，可能是步骤看得太快。写完后检查一次符号和数字吧。",
            "mastered": "太棒了！你已经能用正确的方法解决这类题了。",
        }.get(diagnosis, "我们已经找到下一步要练习的地方，一点一点来就好。")
    return {
        "fundamental_gap": "This idea needs a little more practice. Review one example, then try a basic question.",
        "trap_vulnerability": "You know the method. Circle key words next time so the wording does not distract you.",
        "carelessness": "You know the method. Check signs and numbers once before submitting.",
        "mastered": "Great work! You can now solve this kind of question correctly.",
    }.get(diagnosis, "We found what to practice next. Take it one step at a time.")


# ── Endpoints ──

@router.get("/{course_id}", response_model=list[WrongAnswerResponse])
async def list_wrong_answers(
    course_id: uuid.UUID,
    mastered: bool | None = None,
    error_category: str | None = None,
    content_node_id: uuid.UUID | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List wrong answers for a course, optionally filtered."""
    await get_course_or_404(db, course_id, user_id=user.id)
    query = (
        select(WrongAnswer, PracticeProblem)
        .join(PracticeProblem, WrongAnswer.problem_id == PracticeProblem.id)
        .where(
            WrongAnswer.course_id == course_id,
            WrongAnswer.user_id == user.id,
        )
        .order_by(WrongAnswer.created_at.desc())
    )

    if error_category:
        query = query.where(WrongAnswer.error_category == error_category)
    if content_node_id is not None:
        query = query.where(PracticeProblem.content_node_id == content_node_id)

    result = await db.execute(query)
    # Legacy rows may already contain repeated attempts. Present one logical
    # item per problem, using the latest state and adding their error counts.
    grouped: dict[uuid.UUID, tuple[WrongAnswer, PracticeProblem, int]] = {}
    for wa, prob in result.all():
        existing = grouped.get(wa.problem_id)
        count = max(int(wa.wrong_attempt_count or 1), 1)
        if existing is None:
            grouped[wa.problem_id] = (wa, prob, count)
        else:
            grouped[wa.problem_id] = (existing[0], existing[1], existing[2] + count)
    rows = [row for row in grouped.values() if mastered is None or row[0].mastered == mastered]
    rows = rows[offset: offset + limit]

    return [
        WrongAnswerResponse(
            id=wa.id,
            problem_id=wa.problem_id,
            content_node_id=prob.content_node_id,
            question=prob.question,
            question_type=prob.question_type,
            options=prob.options,
            user_answer=wa.user_answer,
            correct_answer=wa.correct_answer,
            explanation=wa.explanation,
            error_category=wa.error_category,
            diagnosis=wa.diagnosis,
            error_detail=wa.error_detail,
            knowledge_points=wa.knowledge_points,
            wrong_attempt_count=wrong_attempt_count,
            review_count=wa.review_count,
            mastered=wa.mastered,
            created_at=wa.created_at,
        )
        for wa, prob, wrong_attempt_count in rows
    ]


@router.post("/{wrong_answer_id}/retry", response_model=RetryResponse)
async def retry_wrong_answer(
    wrong_answer_id: uuid.UUID,
    body: RetryRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Retry a wrong answer. Updates review count and mastery status."""
    result = await db.execute(
        select(WrongAnswer, PracticeProblem).join(
            PracticeProblem, WrongAnswer.problem_id == PracticeProblem.id
        ).where(
            WrongAnswer.id == wrong_answer_id,
            WrongAnswer.user_id == user.id,
        )
    )
    row = result.one_or_none()
    if not row:
        raise NotFoundError("Wrong answer")
    wa, problem = row

    is_correct = False
    if wa.correct_answer:
        # Unified grader: same layered pipeline as quiz submission, so a
        # retry is judged by the same rules as the original attempt.
        from services.practice.grading_service import grade_answer
        answer_config = None
        if isinstance(problem.problem_metadata, dict):
            answer_config = (
                problem.problem_metadata.get("answerConfig")
                or problem.problem_metadata.get("answer_config")
            )
        grading = await grade_answer(
            question_type=problem.question_type or "",
            student_answer=body.user_answer,
            expected_answer=wa.correct_answer,
            options=problem.options,
            answer_config=answer_config,
            question_context={"question": problem.question},
        )
        is_correct = grading.is_correct

    wa.review_count += 1
    wa.last_reviewed_at = func.now()
    if is_correct:
        wa.mastered = True

    await db.commit()

    return RetryResponse(
        is_correct=is_correct,
        correct_answer=wa.correct_answer,
        explanation=wa.explanation,
    )


@router.post("/{wrong_answer_id}/derive", response_model=DeriveResponse)
async def derive_question(
    wrong_answer_id: uuid.UUID,
    force_new: bool = False,
    as_practice: bool = False,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate a diagnostic pair: a simplified "clean" version of the wrong question."""
    result = await db.execute(
        select(WrongAnswer, PracticeProblem)
        .join(PracticeProblem, WrongAnswer.problem_id == PracticeProblem.id)
        .where(
            WrongAnswer.id == wrong_answer_id,
            WrongAnswer.user_id == user.id,
        )
    )
    row = result.one_or_none()
    if not row:
        raise NotFoundError("Wrong answer")

    wa, problem = row

    # Ordinary review reuses its existing diagnostic. A reinforcement request
    # deliberately creates a fresh variant with the same learning objective.
    if not force_new:
        existing_diag_result = await db.execute(
            select(PracticeProblem)
            .where(
                PracticeProblem.parent_problem_id == problem.id,
                PracticeProblem.is_diagnostic == True,
            )
            .order_by(PracticeProblem.created_at.desc())
        )
        for existing in existing_diag_result.scalars().all():
            metadata = existing.problem_metadata or {}
            if metadata.get("wrong_answer_id") == str(wa.id):
                return {
                    "problem_id": str(existing.id),
                    "original_problem_id": str(problem.id),
                    "question": existing.question,
                    "question_type": existing.question_type,
                    "options": existing.options,
                    "is_diagnostic": True,
                    "simplifications_made": metadata.get("simplifications_made", []),
                    "core_concept_preserved": metadata.get("core_concept_preserved", ""),
                }

    new_problem = await derive_diagnostic(db, wa, problem)
    if as_practice:
        new_problem.is_diagnostic = False
        new_problem.problem_metadata = {
            **(new_problem.problem_metadata or {}),
            "reinforcement_practice": True,
        }
    await db.commit()
    await db.refresh(new_problem)

    return {
        "problem_id": str(new_problem.id),
        "original_problem_id": str(problem.id),
        "question": new_problem.question,
        "question_type": new_problem.question_type,
        "options": new_problem.options,
        "correct_answer": new_problem.correct_answer,
        "explanation": new_problem.explanation,
        "is_diagnostic": not as_practice,
        "simplifications_made": (new_problem.problem_metadata or {}).get("simplifications_made", []),
        "core_concept_preserved": (new_problem.problem_metadata or {}).get("core_concept_preserved", ""),
    }


@router.post("/{wrong_answer_id}/diagnose", response_model=DiagnoseResponse)
async def diagnose_from_pair(
    wrong_answer_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Diagnose error type from a completed diagnostic pair.

    VCE contrastive diagnosis matrix:
    - Both wrong → fundamental_gap
    - Clean right, original wrong → trap_vulnerability
    - Clean wrong, original right → carelessness
    - Both right → mastered
    """
    wa_result = await db.execute(
        select(WrongAnswer).where(
            WrongAnswer.id == wrong_answer_id,
            WrongAnswer.user_id == user.id,
        )
    )
    wa = wa_result.scalar_one_or_none()
    if not wa:
        raise NotFoundError("Wrong answer")

    if wa.diagnosis:
        is_zh = any(
            "\u4e00" <= char <= "\u9fff"
            for char in f"{wa.user_answer or ''}{wa.explanation or ''}"
        )
        return {
            "diagnosis": wa.diagnosis,
            "original_correct": wa.mastered,
            "clean_correct": None,
            "interpretation": _friendly_diagnosis_message(wa.diagnosis, is_zh=is_zh),
        }

    diag_result = await db.execute(
        select(PracticeProblem).where(
            PracticeProblem.parent_problem_id == wa.problem_id,
            PracticeProblem.is_diagnostic == True,
        )
    )
    diag_problem = diag_result.scalar_one_or_none()
    if not diag_problem:
        raise NotFoundError("Diagnostic pair")

    from models.practice import PracticeResult

    original_correct = wa.mastered

    clean_result = await db.execute(
        select(PracticeResult).where(
            PracticeResult.problem_id == diag_problem.id,
            PracticeResult.user_id == user.id,
        ).order_by(PracticeResult.answered_at.desc()).limit(1)
    )
    clean_attempt = clean_result.scalar_one_or_none()
    if not clean_attempt:
        return {
            "status": "pending",
            "message": "Student has not attempted the diagnostic (clean) version yet.",
            "diagnostic_problem_id": str(diag_problem.id),
        }

    clean_correct = clean_attempt.is_correct
    is_zh = any("\u4e00" <= char <= "\u9fff" for char in diag_problem.question)

    if not clean_correct and not original_correct:
        diagnosis = "fundamental_gap"
    elif clean_correct and not original_correct:
        diagnosis = "trap_vulnerability"
    elif not clean_correct and original_correct:
        diagnosis = "carelessness"
    else:
        diagnosis = "mastered"

    wa.diagnosis = diagnosis
    wa.error_detail = {
        **(wa.error_detail or {}),
        "diagnosis": diagnosis,
        "original_correct": original_correct,
        "clean_correct": clean_correct,
        "diagnostic_problem_id": str(diag_problem.id),
    }
    await db.commit()

    return {
        "diagnosis": diagnosis,
        "original_correct": original_correct,
        "clean_correct": clean_correct,
        "interpretation": _friendly_diagnosis_message(diagnosis, is_zh=is_zh),
    }


@router.get("/{course_id}/stats", response_model=WrongAnswerStatsResponse)
async def wrong_answer_stats(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get wrong answer statistics for a course."""
    await get_course_or_404(db, course_id, user_id=user.id)
    rows = list((await db.execute(
        select(WrongAnswer)
        .where(WrongAnswer.course_id == course_id, WrongAnswer.user_id == user.id)
        .order_by(WrongAnswer.created_at.desc())
    )).scalars().all())
    # Mirror list/review semantics: a question is one learner-facing item even
    # when historical versions wrote multiple rows for repeated submissions.
    latest_by_problem: dict[uuid.UUID, WrongAnswer] = {}
    for row in rows:
        latest_by_problem.setdefault(row.problem_id, row)
    logical_items = list(latest_by_problem.values())
    total = len(logical_items)
    mastered = sum(1 for row in logical_items if row.mastered)
    by_category: dict[str, int] = {}
    by_diagnosis: dict[str, int] = {}
    for row in logical_items:
        category = row.error_category or "uncategorized"
        by_category[category] = by_category.get(category, 0) + 1
        if row.diagnosis:
            by_diagnosis[row.diagnosis] = by_diagnosis.get(row.diagnosis, 0) + 1

    return {
        "total": total,
        "mastered": mastered,
        "unmastered": total - mastered,
        "by_category": by_category,
        "by_diagnosis": by_diagnosis,
    }
