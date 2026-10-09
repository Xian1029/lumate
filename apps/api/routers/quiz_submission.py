"""Quiz submission endpoints: submit answers, list problems, mastery history."""

import logging
import re
import unicodedata
import uuid

logger = logging.getLogger(__name__)

from fastapi import APIRouter, BackgroundTasks, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import async_session, get_db
from models.course import Course
from models.practice import PracticeProblem, PracticeResult
from models.user import User
from schemas.quiz import (
    AnswerResponse,
    MasterySnapshotResponse,
    ProblemResponse,
    SubmitAnswerRequest,
)
from services.auth.dependency import get_current_user
from services.course_access import get_course_or_404
from sqlalchemy.exc import SQLAlchemyError

from libs.exceptions import NotFoundError

router = APIRouter()

# ── Grading helpers ─────────────────────────────────────────────

_TRUE_SYNONYMS = frozenset([
    # English
    "true", "t", "yes", "y", "correct", "right", "affirmative", "1",
    # Chinese
    "正确", "对", "是的", "是", "没错", "对等", "对的", "真的", "真",
])

_FALSE_SYNONYMS = frozenset([
    # English
    "false", "f", "no", "n", "wrong", "incorrect", "negative", "0",
    # Chinese
    "错误", "不对", "错", "否", "不是", "错的", "假的", "假", "荒谬",
])


def _normalize_whitespace(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _strip_punctuation(text):
    """Remove common CJK + ASCII punctuation."""
    import unicodedata as _u
    s = _u.normalize("NFKC", str(text or "")).strip()
    punc = r"""["'`()（）\[\]【】{}<>《》,，.。!！?？;:：；、|/\\\-_=+~@#$%^&*·…]"""
    s = re.sub("^" + punc + "+", "", s)
    s = re.sub(punc + "+$", "", s)
    s = re.sub(punc + "+", " ", s)
    return _normalize_whitespace(s)


def _normalize_bool_answer(value):
    """Return canonical True/False for boolean-like synonyms (EN/ZH)."""
    raw = _normalize_whitespace(value)
    if not raw:
        return None
    cand = raw.lower()
    if cand in _TRUE_SYNONYMS:
        return "True"
    if cand in _FALSE_SYNONYMS:
        return "False"
    stripped_no_space = re.sub(r"\s+", "", _strip_punctuation(cand))
    if stripped_no_space:
        if stripped_no_space in _TRUE_SYNONYMS:
            return "True"
        if stripped_no_space in _FALSE_SYNONYMS:
            return "False"
    return None


def _text_equal_forgiving(user, reference):
    def _canonical(value):
        text = unicodedata.normalize("NFKC", str(value or "")).casefold()
        # Formatting is never part of the learner's knowledge: discard all
        # Unicode punctuation and whitespace before comparing content.
        return "".join(
            char for char in text
            if not char.isspace() and not unicodedata.category(char).startswith("P")
        )

    user_raw = unicodedata.normalize("NFKC", str(user or "")).casefold()
    reference_raw = unicodedata.normalize("NFKC", str(reference or "")).casefold()
    u = _canonical(user_raw)
    r = _canonical(reference_raw)
    if not u or not r:
        return False
    if u == r:
        return True
    for raw_alt in re.split(r"[;；/|]", str(reference or "")):
        alt = _canonical(raw_alt)
        if alt and u == alt:
            return True
    # A short reference answer may appear inside a fuller learner explanation.
    # Preserve negation polarity so e.g. “不是正数” cannot match “是正数”.
    def _has_negation(value, raw_value):
        return (
            any(token in value for token in ("不", "没", "无", "非"))
            or bool(re.search(r"\b(?:not|never|no)\b", raw_value))
        )

    if len(r) >= 2 and r in u:
        user_negative = _has_negation(u, user_raw)
        ref_negative = _has_negation(r, reference_raw)
        if user_negative == ref_negative:
            return True
    return False


def _option_answer_text(correct_answer, options):
    """Resolve a stored option label (A/B/...) to its learner-facing text."""
    answer = _normalize_whitespace(correct_answer)
    if not answer or not isinstance(options, dict):
        return answer
    for key, value in options.items():
        if answer.casefold() == str(key).strip().casefold():
            return _normalize_whitespace(value)
    return answer


def _grade_text_answer(question_type, user_answer, correct_answer, options=None):
    qt = (question_type or "").lower()
    # Keep line breaks for multi-blank answers. They are meaningful separators
    # even though surrounding whitespace is ignored elsewhere.
    u_structured = str(user_answer or "").strip()
    r_structured = str(correct_answer or "").strip()
    u_raw = _normalize_whitespace(user_answer)
    r_raw = _normalize_whitespace(correct_answer)
    r_text = _option_answer_text(correct_answer, options)
    if not u_raw or not r_raw:
        return False

    if qt in ("mc", "select_all", "matching"):
        def _nk(s):
            parts = [p.strip().upper() for p in re.split(r"[,\s，、;；]+", s) if p.strip()]
            return ",".join(sorted(parts))
        if _nk(u_raw) == _nk(r_raw):
            return True
        # Legacy questions can be rendered as text inputs even though their
        # answer was stored as an option label. Accept the visible option text.
        return r_text != r_raw and _text_equal_forgiving(u_raw, r_text)

    if qt in ("tf", "true_false", "boolean", "bool"):
        u_bool = _normalize_bool_answer(u_raw)
        r_bool = _normalize_bool_answer(r_text)
        if u_bool and r_bool:
            return u_bool == r_bool
        if u_bool or r_bool:
            return u_raw.casefold() == r_text.casefold()
        return _text_equal_forgiving(u_raw, r_text)

    if qt in ("short_answer", "fill_blank", "free_response"):
        from services.practice.answer_grading import (
            algebraic_expressions_equivalent,
            arithmetic_work_equivalent,
            named_quantities_with_classification_equivalent,
            numeric_answers_equivalent,
            signed_opposite_relation_equivalent,
            signed_quantities_equivalent,
            structured_blanks_equivalent,
        )
        structured_reference = r_text if r_text != r_raw else r_structured
        if numeric_answers_equivalent(u_structured, structured_reference):
            return True
        if algebraic_expressions_equivalent(u_structured, structured_reference):
            return True
        if structured_blanks_equivalent(u_structured, structured_reference):
            return True
        if arithmetic_work_equivalent(u_structured, structured_reference):
            return True
        if signed_quantities_equivalent(u_structured, structured_reference):
            return True
        if named_quantities_with_classification_equivalent(u_structured, structured_reference):
            return True
        if signed_opposite_relation_equivalent(u_structured, structured_reference):
            return True
        if u_raw.casefold() == r_text.casefold():
            return True
        return _text_equal_forgiving(u_raw, r_text)

    return u_raw.casefold() == r_text.casefold()



@router.get("/{course_id}", response_model=list[ProblemResponse], summary="List practice problems", description="Return paginated practice problems for a course, excluding diagnostics.")
async def list_problems(
    course_id: uuid.UUID,
    content_node_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List user-facing practice problems for a course."""
    await get_course_or_404(db, course_id, user_id=user.id)

    query = (
        select(PracticeProblem)
        .where(PracticeProblem.course_id == course_id)
        .where(PracticeProblem.is_diagnostic == False)
        .where(PracticeProblem.is_archived == False)
    )
    if content_node_id:
        query = query.where(PracticeProblem.content_node_id == content_node_id)
    query = query.order_by(PracticeProblem.order_index).offset(offset).limit(limit)
    result = await db.execute(query)
    problems = list(result.scalars().all())
    problem_ids = [p.id for p in problems]
    answered_ids: set = set()
    if problem_ids:
        pr_result = await db.execute(
            select(PracticeResult.problem_id)
            .where(PracticeResult.problem_id.in_(problem_ids))
            .where(PracticeResult.user_id == user.id)
        )
        answered_ids = {row[0] for row in pr_result.all()}
    return [
        ProblemResponse(
            id=problem.id,
            question_type=problem.question_type,
            question=problem.question,
            options=problem.options,
            order_index=problem.order_index,
            content_node_id=problem.content_node_id,
            difficulty_layer=problem.difficulty_layer,
            problem_metadata=problem.problem_metadata,
            answer_ready=bool((problem.correct_answer or "").strip()),
            explanation_ready=bool((problem.explanation or "").strip()),
            correct_answer=(
                _option_answer_text(problem.correct_answer, problem.options)
                if problem.id in answered_ids else None
            ),
            explanation=(
                problem.explanation if problem.id in answered_ids else None
            ),
            is_answered=problem.id in answered_ids,
            source_batch_id=str(problem.source_batch_id) if problem.source_batch_id else None,
        )
        for problem in problems
    ]


async def _auto_derive_diagnostic(wrong_answer_id: uuid.UUID, user_id: uuid.UUID) -> None:
    """Background task: auto-generate a diagnostic pair for a wrong answer."""
    try:
        async with async_session() as db:
            from models.ingestion import WrongAnswer
            from models.practice import PracticeProblem as PP
            result = await db.execute(
                select(WrongAnswer, PP)
                .join(PP, WrongAnswer.problem_id == PP.id)
                .where(WrongAnswer.id == wrong_answer_id, WrongAnswer.user_id == user_id)
            )
            row = result.one_or_none()
            if not row:
                return
            wa, problem = row
            # Skip if diagnostic pair already exists
            existing = await db.execute(
                select(PP.id).where(PP.parent_problem_id == problem.id, PP.is_diagnostic == True)
            )
            if existing.scalar_one_or_none():
                return
            if problem.is_diagnostic or (problem.difficulty_layer and problem.difficulty_layer < 2):
                return

            from services.diagnosis.derive import derive_diagnostic
            await derive_diagnostic(db, wa, problem)
            await db.commit()
            logger.info("Auto-generated diagnostic pair for wrong answer %s", wrong_answer_id)
    except (SQLAlchemyError, ValueError, KeyError, TypeError):
        logger.exception("Auto-derive diagnostic failed (best-effort)")


async def _check_effective_review(
    problem_id: uuid.UUID, course_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    """Background: if user previously got this problem wrong, record effective_review signal."""
    try:
        async with async_session() as db:
            prev_wrong = await db.execute(
                select(PracticeResult.id).where(
                    PracticeResult.problem_id == problem_id,
                    PracticeResult.user_id == user_id,
                    PracticeResult.is_correct == False,  # noqa: E712
                ).limit(1)
            )
            if prev_wrong.scalar_one_or_none() is None:
                return  # No prior wrong answer — not an improvement
            from services.block_decision.preference import record_block_event
            await record_block_event(db, user_id, course_id, "review", "effective_review")
            await db.commit()
            logger.info("Recorded effective_review signal for problem %s", problem_id)
    except (SQLAlchemyError, ValueError, ImportError):
        logger.exception("Effective review check failed (best-effort)")


async def _auto_detect_confusion(course_id: uuid.UUID, user_id: uuid.UUID) -> None:
    """Background task: detect confusion pairs from accumulated wrong answers."""
    try:
        async with async_session() as db:
            from services.loom_confusion import detect_confusion_pairs
            await detect_confusion_pairs(db, course_id, user_id, min_occurrences=1)
            await db.commit()
    except (SQLAlchemyError, ValueError, KeyError):
        logger.exception("Auto confusion detection failed (best-effort)")


@router.post("/submit", response_model=AnswerResponse, summary="Submit a quiz answer", description="Grade a practice answer, classify errors, and update mastery tracking.")
async def submit_answer(
    body: SubmitAnswerRequest,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Submit an answer to a practice problem."""
    result = await db.execute(
        select(PracticeProblem)
        .join(Course, PracticeProblem.course_id == Course.id)
        .where(
            PracticeProblem.id == body.problem_id,
            Course.user_id == user.id,
        )
    )
    problem = result.scalar_one_or_none()
    if not problem:
        raise NotFoundError("Problem", body.problem_id)

    warnings: list[str] = []
    display_correct_answer = _option_answer_text(problem.correct_answer, problem.options)

    is_correct = False
    grading_result = None  # Unified GradingResult when answer-grader-v2 ran.
    # Only a final, explicit INCORRECT enters the negative learning profile
    # (WrongAnswer, mastery penalty, weakness). NORMALIZED_EXACT,
    # NUMERIC_EQUIVALENT and SEMANTIC_EQUIVALENT are correct; NEEDS_REVIEW is
    # neither correct nor punished.
    negative_outcome = False
    needs_review = False
    if problem.question_type == "coding":
        try:
            from services.diagnosis.coding_grader import grade_coding_answer
            coding_grading = await grade_coding_answer(
                question=problem.question,
                reference_answer=problem.correct_answer or "",
                user_code=body.user_answer,
            )
            is_correct = coding_grading.get("is_correct", False)
        except (ValueError, KeyError, TypeError, OSError):
            logger.exception("Coding grading failed (best-effort)")
            warnings.append("coding_grading_failed")
        negative_outcome = not is_correct
    elif problem.correct_answer:
        from services.practice.grading_service import GRADER_VERSION, MatchType, grade_answer
        answer_config = None
        if isinstance(problem.problem_metadata, dict):
            answer_config = (
                problem.problem_metadata.get("answerConfig")
                or problem.problem_metadata.get("answer_config")
            )
        _raw_kp = problem.knowledge_points
        first_kp = (
            str(_raw_kp[0]) if isinstance(_raw_kp, list) and _raw_kp
            else str(_raw_kp) if isinstance(_raw_kp, str) and _raw_kp.strip()
            else None
        )
        try:
            grading_result = await grade_answer(
                question_type=problem.question_type or "",
                student_answer=body.user_answer,
                expected_answer=problem.correct_answer,
                options=problem.options,
                answer_config=answer_config,
                question_context={"question": problem.question, "knowledge_point": first_kp},
            )
        except Exception:  # noqa: BLE001 - grading must never 500 a submission
            logger.exception("Unified grading failed; falling back to legacy grader")
            warnings.append("grading_fallback")
            is_correct = _grade_text_answer(
                problem.question_type or "",
                body.user_answer,
                problem.correct_answer,
                problem.options,
            )
            negative_outcome = not is_correct
        else:
            is_correct = grading_result.is_correct
            needs_review = grading_result.match_type == MatchType.NEEDS_REVIEW
            negative_outcome = grading_result.match_type == MatchType.INCORRECT

    pr = PracticeResult(
        problem_id=problem.id,
        user_id=user.id,
        user_answer=body.user_answer,
        is_correct=is_correct,
        ai_explanation=problem.explanation,
        difficulty_layer=problem.difficulty_layer,
        answer_time_ms=body.answer_time_ms,
    )
    if grading_result is not None:
        pr.grading_meta = {
            "match_type": grading_result.match_type.value,
            "score": grading_result.score,
            "confidence": round(grading_result.confidence, 4),
            "reason": grading_result.reason,
            "grader_version": GRADER_VERSION,
            "semantic_grading_used": grading_result.semantic_grading_used,
            "per_blank_results": grading_result.per_blank_results,
        }

    error_category = None
    classification = None
    if negative_outcome and problem.correct_answer:
        try:
            from services.diagnosis.classifier import classify_error
            classification = await classify_error(
                question=problem.question,
                correct_answer=problem.correct_answer,
                user_answer=body.user_answer,
                problem_metadata=problem.problem_metadata,
            )
            error_category = classification["category"]
            pr.error_category = error_category
        except (ValueError, KeyError, TypeError, OSError):
            logger.exception("Error classification failed (best-effort)")
            warnings.append("error_classification_failed")

    db.add(pr)

    wa = None
    if negative_outcome:
        from models.ingestion import WrongAnswer
        existing = (await db.execute(
            select(WrongAnswer)
            .where(WrongAnswer.user_id == user.id, WrongAnswer.problem_id == problem.id)
            .order_by(WrongAnswer.created_at.desc())
            .limit(1)
        )).scalar_one_or_none()
        if existing:
            # Same question, same learner: preserve one review card and retain
            # the latest evidence plus a truthful number of wrong attempts.
            wa = existing
            wa.user_answer = body.user_answer
            wa.correct_answer = problem.correct_answer
            wa.explanation = problem.explanation
            wa.error_category = error_category
            wa.error_detail = classification if error_category else None
            wa.knowledge_points = problem.knowledge_points
            wa.wrong_attempt_count = max(int(wa.wrong_attempt_count or 1), 1) + 1
            wa.mastered = False
        else:
            wa = WrongAnswer(
                user_id=user.id,
                problem_id=problem.id,
                course_id=problem.course_id,
                user_answer=body.user_answer,
                correct_answer=problem.correct_answer,
                explanation=problem.explanation,
                error_category=error_category,
                error_detail=classification if error_category else None,
                knowledge_points=problem.knowledge_points,
                wrong_attempt_count=1,
            )
            db.add(wa)
    elif is_correct:
        # A correct normal-practice retry is as meaningful as answering from
        # the dedicated wrong-answer page. Close every historic duplicate for
        # this learner/problem pair so it cannot remain in active review.
        from models.ingestion import WrongAnswer
        prior_records = list((await db.execute(
            select(WrongAnswer).where(
                WrongAnswer.user_id == user.id,
                WrongAnswer.problem_id == problem.id,
                WrongAnswer.mastered == False,  # noqa: E712
            )
        )).scalars().all())
        for prior in prior_records:
            prior.mastered = True
            prior.last_reviewed_at = func.now()

    # NEEDS_REVIEW and PARTIALLY_CORRECT are not confirmed wrong and must not
    # move progress/mastery in either direction.
    profile_update_allowed = grading_result is None or grading_result.match_type not in (
        MatchType.NEEDS_REVIEW,
        MatchType.PARTIALLY_CORRECT,
    )
    if profile_update_allowed:
        try:
            from services.progress.tracker import update_quiz_result
            await update_quiz_result(
                db, user.id, problem.course_id, problem.content_node_id,
                is_correct=is_correct,
                error_category=error_category,
            )
        except (SQLAlchemyError, ValueError, TypeError):
            logger.exception("Progress update failed (best-effort)")
            warnings.append("progress_update_failed")

    # Normalize knowledge_points to list[str] for consistent handling
    _kp = problem.knowledge_points
    kp_list: list[str] = (
        [str(x) for x in _kp] if isinstance(_kp, list)
        else [_kp] if isinstance(_kp, str)
        else []
    )

    # Update LOOM concept mastery for each knowledge point (skipped for
    # NEEDS_REVIEW — an ungradeable answer must not move mastery).
    if kp_list and profile_update_allowed:
        from services.loom_mastery import update_concept_mastery
        for kp in kp_list:
            try:
                await update_concept_mastery(
                    db, user.id, str(kp), problem.course_id,
                    correct=is_correct, question_type=problem.question_type,
                    content_node_id=problem.content_node_id,
                )
            except (SQLAlchemyError, ValueError, KeyError):
                logger.exception("Concept mastery update failed for '%s'", kp)
                warnings.append("concept_mastery_update_failed")

    # Emit analytics event before committing — single transaction for atomicity
    try:
        from services.analytics.events import emit_quiz_answered
        await emit_quiz_answered(
            db,
            user_id=user.id,
            course_id=problem.course_id,
            quiz_id=str(problem.id),
            score=grading_result.score if grading_result is not None else (1.0 if is_correct else 0.0),
            correct=is_correct,
            agent_name="quiz_router",
            answers={"user_answer": body.user_answer, "error_category": error_category},
        )
    except (SQLAlchemyError, ValueError, TypeError):
        logger.exception("Learning event emission failed (best-effort)")
        warnings.append("analytics_event_failed")

    await db.commit()

    if negative_outcome and wa:
        background_tasks.add_task(_auto_derive_diagnostic, wa.id, user.id)
        # Auto-detect confusion pairs from accumulated wrong answers
        background_tasks.add_task(_auto_detect_confusion, problem.course_id, user.id)

    # Detect improvement: correct answer on a previously-wrong problem → effective_review signal
    if is_correct:
        background_tasks.add_task(
            _check_effective_review, problem.id, problem.course_id, user.id
        )

    # Check prerequisite gaps on wrong answers
    prerequisite_gaps = None
    if negative_outcome and kp_list:
        try:
            from services.loom_graph import check_prerequisite_gaps
            gaps = await check_prerequisite_gaps(
                db, user.id, problem.course_id,
                failed_concept_names=kp_list,
            )
            if gaps:
                prerequisite_gaps = gaps[:3]
        except (SQLAlchemyError, ValueError, KeyError):
            logger.exception("Prerequisite gap check failed (best-effort)")
            warnings.append("prerequisite_gap_check_failed")

    feedback = None
    if grading_result is not None and grading_result.match_type not in (MatchType.EXACT,):
        # Surface the human-readable grading reason, e.g. semantic-equivalent
        # answers get "理解正确，更通用的表达是…"-style feedback.
        feedback = grading_result.reason or None

    return AnswerResponse(
        is_correct=is_correct,
        correct_answer=display_correct_answer,
        user_answer=body.user_answer,
        explanation=problem.explanation,
        prerequisite_gaps=prerequisite_gaps,
        warnings=warnings,
        match_type=grading_result.match_type.value if grading_result is not None else None,
        score=grading_result.score if grading_result is not None else None,
        needs_review=needs_review,
        per_blank_results=grading_result.per_blank_results if grading_result is not None else None,
        grader_version=GRADER_VERSION if grading_result is not None else None,
        feedback=feedback,
    )


# -- Mastery history time-series endpoint --


@router.get("/{course_id}/mastery-history", response_model=list[MasterySnapshotResponse], summary="Get mastery history", description="Return mastery score time-series for analytics charts.")
async def mastery_history(
    course_id: uuid.UUID,
    content_node_id: uuid.UUID | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return mastery score time-series for analytics charts."""
    from models.mastery_snapshot import MasterySnapshot

    await get_course_or_404(db, course_id, user_id=user.id)

    query = (
        select(MasterySnapshot)
        .where(
            MasterySnapshot.user_id == user.id,
            MasterySnapshot.course_id == course_id,
        )
        .order_by(MasterySnapshot.recorded_at.desc())
        .limit(limit)
    )
    if content_node_id:
        query = query.where(MasterySnapshot.content_node_id == content_node_id)

    result = await db.execute(query)
    snapshots = result.scalars().all()

    return [
        MasterySnapshotResponse(
            mastery_score=s.mastery_score,
            gap_type=s.gap_type,
            content_node_id=str(s.content_node_id) if s.content_node_id else None,
            recorded_at=s.recorded_at,
        )
        for s in reversed(snapshots)
    ]
