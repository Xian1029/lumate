"""Progress knowledge endpoints — knowledge graph, LOOM, learning path, review, velocity."""

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from libs.exceptions import KnowledgeGraphUnavailableError
from models.ingestion import WrongAnswer
from models.progress import LearningProgress
from models.practice import PracticeProblem
from models.user import User
from services.auth.dependency import get_current_user
from services.knowledge.graph import build_knowledge_graph

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Forgetting Forecast ──


@router.get("/courses/{course_id}/forgetting-forecast", summary="Get forgetting forecast", description="Predict when each knowledge point will be forgotten using FSRS retrievability.")
async def get_forgetting_forecast(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Predict when each knowledge point will be forgotten (FSRS retrievability)."""
    from services.spaced_repetition.forgetting_forecast import predict_forgetting

    return await predict_forgetting(db, user.id, course_id)


# ── Knowledge Graph ──


@router.get("/courses/{course_id}/knowledge-graph", summary="Get knowledge graph", description="Return the knowledge graph for a course in D3-compatible format.")
async def get_knowledge_graph(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get knowledge graph for a course (D3-compatible format)."""
    try:
        return await build_knowledge_graph(db, course_id, user.id)
    except KnowledgeGraphUnavailableError:
        raise
    except (SQLAlchemyError, KeyError, ValueError, TypeError, RuntimeError) as exc:
        logger.exception("Knowledge graph build failed for course %s user %s", course_id, user.id)
        raise KnowledgeGraphUnavailableError() from exc


# ── Learning Path ──


@router.get("/courses/{course_id}/learning-path", summary="Get learning path", description="Return prerequisite-respecting study order for unmastered concepts.")
async def get_learning_path(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get prerequisite-respecting study order for unmastered concepts (Kahn's algorithm)."""
    if not settings.enable_experimental_loom:
        raise HTTPException(404, "LOOM knowledge graph is experimental. Set ENABLE_EXPERIMENTAL_LOOM=true to enable.")
    from services.loom_graph import generate_learning_path

    path = await generate_learning_path(db, course_id, user.id)
    return {"course_id": str(course_id), "path": path, "count": len(path)}


# ── Misconceptions ──


@router.get("/courses/{course_id}/misconceptions", summary="Get misconception dashboard", description="Return misconceptions grouped by concept with error analysis and priority scores.")
async def get_misconception_dashboard(
    course_id: uuid.UUID,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get misconception dashboard: things you think you understand but don't."""
    wrong_result = await db.execute(
        select(WrongAnswer, PracticeProblem)
        .join(PracticeProblem, WrongAnswer.problem_id == PracticeProblem.id)
        .where(
            WrongAnswer.course_id == course_id,
            WrongAnswer.user_id == user.id,
        )
        .order_by(WrongAnswer.created_at.desc())
        .limit(500)  # Cap to prevent unbounded data load
    )
    wrong_rows = wrong_result.all()

    progress_result = await db.execute(
        select(LearningProgress).where(
            LearningProgress.user_id == user.id,
            LearningProgress.course_id == course_id,
            LearningProgress.gap_type.isnot(None),
            LearningProgress.gap_type != "mastered",
        )
    )
    gap_rows = progress_result.scalars().all()

    concept_map: dict[str, dict] = {}
    for wa, prob in wrong_rows:
        # Older practice rows may contain null or legacy scalar JSON values.
        # Never let one malformed diagnostic record take down the whole
        # dashboard; the learner should still see every usable blind spot.
        metadata = prob.problem_metadata if isinstance(prob.problem_metadata, dict) else {}
        concept = metadata.get("core_concept") or metadata.get("topic")
        knowledge_points = wa.knowledge_points
        if isinstance(knowledge_points, str):
            knowledge_points = [knowledge_points]
        elif not isinstance(knowledge_points, (list, tuple)):
            knowledge_points = []
        if (
            not isinstance(concept, str)
            or not concept.strip()
            or concept.strip().casefold() in {"unknown", "none", "null"}
        ) and knowledge_points:
            concept = next((point for point in knowledge_points if isinstance(point, str) and point.strip()), None)
        if not isinstance(concept, str) or not concept.strip() or concept.strip().casefold() in {"unknown", "none", "null"}:
            # Do not present missing metadata as a real learning blind spot.
            continue
        concept = concept.strip()
        key = concept.lower().strip()

        if key not in concept_map:
            concept_map[key] = {
                "concept": concept,
                "total_errors": 0,
                "mastered_errors": 0,
                "error_categories": {},
                "diagnoses": {},
                "latest_error_at": None,
                "sample_questions": [],
                "question_map": {},
                "misconception_types": [],
            }

        entry = concept_map[key]
        entry["total_errors"] += 1
        if wa.mastered:
            entry["mastered_errors"] += 1

        cat = wa.error_category or "uncategorized"
        entry["error_categories"][cat] = entry["error_categories"].get(cat, 0) + 1

        if wa.diagnosis:
            entry["diagnoses"][wa.diagnosis] = entry["diagnoses"].get(wa.diagnosis, 0) + 1

        if wa.created_at:
            if entry["latest_error_at"] is None or wa.created_at > entry["latest_error_at"]:
                entry["latest_error_at"] = wa.created_at

        # One logical question is shown once. Repeated attempts are folded
        # into the same sample so the dashboard remains readable while still
        # exposing how often the learner met the same trap.
        question_key = (prob.question or f"problem:{prob.id}").strip().casefold()
        question_map = entry["question_map"]
        sample = question_map.get(question_key)
        if sample is None:
            sample = {
                "question": prob.question[:200] if prob.question else "",
                "user_answer": wa.user_answer[:100] if wa.user_answer else "",
                "correct_answer": wa.correct_answer[:100] if wa.correct_answer else "",
                "error_category": wa.error_category,
                "diagnosis": wa.diagnosis,
                "attempt_count": 0,
                "resolved_attempt_count": 0,
                "resolved": False,
                "review_count": 0,
                "last_reviewed_at": None,
            }
            question_map[question_key] = sample
        sample["attempt_count"] += 1
        if wa.mastered:
            sample["resolved_attempt_count"] += 1
        # Rows are ordered newest-first. A question is considered resolved
        # as soon as its latest review is mastered; older failed attempts are
        # retained only as history and must not keep the question active.
        if sample["attempt_count"] == 1:
            sample["resolved"] = bool(wa.mastered)
        sample["review_count"] = max(sample["review_count"], wa.review_count or 0)
        if wa.last_reviewed_at and (
            sample["last_reviewed_at"] is None or wa.last_reviewed_at > sample["last_reviewed_at"]
        ):
            sample["last_reviewed_at"] = wa.last_reviewed_at.isoformat()

        detail = wa.error_detail if isinstance(wa.error_detail, dict) else {}
        if detail.get("misconception_type"):
            entry["misconception_types"].append(detail["misconception_type"])

    for prog in gap_rows:
        meta = prog.metadata_json if isinstance(prog.metadata_json, dict) else {}
        probes = meta.get("comprehension_probes") or []
        if not isinstance(probes, list):
            continue
        for probe in probes:
            if not isinstance(probe, dict):
                continue
            probe_concept = probe.get("concept")
            if not probe.get("understood") and isinstance(probe_concept, str) and probe_concept.strip():
                key = probe_concept.lower().strip()
                if key not in concept_map:
                    concept_map[key] = {
                        "concept": probe_concept.strip(),
                        "total_errors": 0,
                        "mastered_errors": 0,
                        "error_categories": {},
                        "diagnoses": {},
                        "latest_error_at": None,
                        "sample_questions": [],
                        "question_map": {},
                        "misconception_types": [],
                    }
                mt = probe.get("misconception_type")
                if mt:
                    concept_map[key]["misconception_types"].append(mt)

    now = datetime.now(timezone.utc)
    misconceptions = []
    for key, entry in concept_map.items():
        # Progress is question-based, not attempt-based. Repeated attempts
        # for one question are history and must not inflate the denominator.
        question_samples = list(entry["question_map"].values())
        question_total = len(question_samples)
        question_mastered = sum(1 for sample in question_samples if sample.get("resolved"))
        active_errors = question_total - question_mastered
        # Keep resolved concepts visible so the dashboard is linked to review
        # history; resolved is a state, not a reason to erase learning history.

        recency_days = 999
        if entry["latest_error_at"]:
            try:
                delta = now - entry["latest_error_at"]
                recency_days = max(delta.days, 0)
            except TypeError as exc:
                logger.debug("Failed to compute recency for concept '%s': %s", key, exc)
        recency_boost = max(0, 30 - recency_days) / 30

        diagnoses = entry["diagnoses"]
        dominant_diagnosis = max(diagnoses, key=diagnoses.get) if diagnoses else None

        mt_list = entry["misconception_types"]
        dominant_misconception = max(set(mt_list), key=mt_list.count) if mt_list else None

        priority_score = round(active_errors * 0.6 + recency_boost * 0.4, 2)

        samples = list(entry["question_map"].values())[:3]
        misconceptions.append({
            "concept": entry["concept"],
            "active_errors": active_errors,
            "total_errors": question_total,
            "mastered_errors": question_mastered,
            "resolution_rate": round(
                entry["mastered_errors"] / max(entry["total_errors"], 1) * 100, 1
            ),
            "dominant_diagnosis": dominant_diagnosis,
            "dominant_misconception_type": dominant_misconception,
            "error_categories": entry["error_categories"],
            "priority_score": priority_score,
            "sample_questions": samples,
            "status": "resolved" if active_errors == 0 else "active",
            "question_count": len(entry["question_map"]),
        })

    misconceptions.sort(key=lambda x: x["priority_score"], reverse=True)

    total_active = sum(m["active_errors"] for m in misconceptions)
    total_resolved = sum(m["mastered_errors"] for m in misconceptions)

    diagnosis_summary: dict[str, int] = {}
    for m in misconceptions:
        if m["dominant_diagnosis"]:
            d = m["dominant_diagnosis"]
            diagnosis_summary[d] = diagnosis_summary.get(d, 0) + 1

    total_count = len(misconceptions)
    page = misconceptions[offset : offset + limit]

    return {
        "course_id": str(course_id),
        "misconceptions": page,
        "total": total_count,
        "limit": limit,
        "offset": offset,
        "summary": {
            "total_concepts_with_issues": total_count,
            "total_active_errors": total_active,
            "total_resolved": total_resolved,
            "resolution_rate": round(
                total_resolved / max(total_active + total_resolved, 1) * 100, 1
            ),
            "diagnosis_breakdown": diagnosis_summary,
        },
    }


# ── Review Session ──


@router.get("/courses/{course_id}/review-session", summary="Get smart review session", description="Return a LECTOR-ordered review session with semantically clustered concepts.")
async def get_review_session(
    course_id: uuid.UUID,
    max_items: int = 10,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get LECTOR smart review session — semantically clustered concepts to review."""
    from services.lector import get_smart_review_session, ReviewItem

    items = await get_smart_review_session(db, user.id, course_id, max_items=max_items)
    return {
        "course_id": str(course_id),
        "items": [_format_review_item(i) for i in items],
        "count": len(items),
    }


def _priority_to_urgency(priority: float) -> str:
    if priority > 0.7:
        return "overdue"
    if priority > 0.4:
        return "urgent"
    if priority > 0.2:
        return "warning"
    return "scheduled"


def _format_review_item(item: "ReviewItem") -> dict:
    """Map internal ReviewItem fields to the frontend-expected schema."""
    return {
        "concept_id": item.concept_id,
        "concept_name": item.concept_name,
        "concept_label": item.concept_name,
        "mastery": item.mastery,
        "priority": item.priority,
        "urgency": _priority_to_urgency(item.priority),
        "reason": item.reason,
        "review_type": item.review_type,
        "related_concepts": item.related_concepts,
        "stability_days": item.stability_days,
        "retrievability": item.retrievability,
        "last_reviewed": item.last_practiced_at,
        "content_node_id": item.content_node_id,
        "cluster": item.related_concepts[0] if item.related_concepts else None,
    }


class ReviewRatingRequest(BaseModel):
    concept_id: uuid.UUID
    rating: str = "good"


@router.post("/courses/{course_id}/review-session/rate", summary="Rate a reviewed concept", description="Submit a rating for a reviewed concept and update mastery scheduling.")
async def submit_review_rating(
    course_id: uuid.UUID,
    body: ReviewRatingRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Submit a rating for a reviewed concept (again/hard/good/easy).

    Uses FSRS review_card() for scheduling (consistent with LOOM mastery updates).
    """
    from models.knowledge_graph import ConceptMastery
    from services.spaced_repetition.fsrs import FSRSCard, review_card as fsrs_review

    RATING_MAP = {"again": 1, "hard": 2, "good": 3, "easy": 4}
    if body.rating not in RATING_MAP:
        raise HTTPException(status_code=400, detail=f"Invalid rating '{body.rating}'. Must be one of: again, hard, good, easy")

    fsrs_rating = RATING_MAP[body.rating]
    concept_uuid = body.concept_id
    now = datetime.now(timezone.utc)

    result = await db.execute(
        select(ConceptMastery).where(
            ConceptMastery.user_id == user.id,
            ConceptMastery.knowledge_node_id == concept_uuid,
        )
    )
    mastery = result.scalar_one_or_none()

    if not mastery:
        mastery = ConceptMastery(
            user_id=user.id,
            knowledge_node_id=concept_uuid,
            mastery_score=0.3,
            practice_count=0,
            correct_count=0,
            wrong_count=0,
            stability_days=1.0,
        )
        db.add(mastery)

    # Build FSRSCard from current mastery state
    fsrs_card = FSRSCard(
        difficulty=5.0,
        stability=mastery.stability_days if mastery.stability_days > 0 else 1.0,
        reps=mastery.practice_count,
        lapses=mastery.wrong_count,
        last_review=mastery.last_practiced_at,
        state="review" if mastery.practice_count > 0 else "new",
    )
    updated_card, _log = fsrs_review(fsrs_card, fsrs_rating, now)

    # Update mastery with FSRS results
    mastery.stability_days = updated_card.stability
    mastery.next_review_at = updated_card.due
    mastery.last_practiced_at = now
    mastery.practice_count += 1

    if fsrs_rating >= 2:  # hard, good, easy = correct
        mastery.correct_count += 1
        gain = 0.1 * (1.0 - mastery.mastery_score) * (fsrs_rating - 1) / 3
        mastery.mastery_score = min(1.0, mastery.mastery_score + gain)
    else:  # again = incorrect
        mastery.wrong_count += 1
        mastery.mastery_score = max(0.0, mastery.mastery_score - 0.1)

    await db.commit()

    return {
        "concept_id": str(concept_uuid),
        "rating": body.rating,
        "new_mastery": round(mastery.mastery_score, 3),
        "new_stability_days": round(mastery.stability_days, 1),
        "next_review_at": mastery.next_review_at.isoformat() if mastery.next_review_at else None,
    }


# ── LOOM ──


@router.get("/courses/{course_id}/loom", summary="Get LOOM mastery graph", description="Return LOOM concept mastery graph with nodes, edges, and recommendations.")
async def get_loom_graph(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get LOOM concept mastery graph with nodes, edges, and recommendations."""
    if not settings.enable_experimental_loom:
        raise HTTPException(404, "LOOM knowledge graph is experimental. Set ENABLE_EXPERIMENTAL_LOOM=true to enable.")
    from services.loom_graph import get_mastery_graph

    graph = await get_mastery_graph(db, user.id, course_id)
    return {"course_id": str(course_id), **graph}


# ── Velocity & Forecast ──


@router.get("/courses/{course_id}/velocity", summary="Get learning velocity", description="Return learning velocity statistics for a course over a time window.")
async def get_learning_velocity(
    course_id: uuid.UUID,
    window_days: int = 7,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get learning velocity stats for a course."""
    from services.learning_science.velocity_tracker import compute_velocity

    return await compute_velocity(db, course_id, window_days=window_days)


@router.get("/courses/{course_id}/forecast", summary="Get completion forecast", description="Forecast course completion date based on current learning velocity.")
async def get_completion_forecast(
    course_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Forecast course completion date based on learning velocity."""
    from services.learning_science.completion_forecaster import forecast_completion

    return await forecast_completion(db, course_id)


@router.get("/transfer-opportunities", summary="Get transfer opportunities", description="Detect cross-course transfer learning opportunities.")
async def get_transfer_opportunities(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Detect cross-course transfer learning opportunities."""
    from services.learning_science.transfer_detector import detect_transfer_opportunities

    return await detect_transfer_opportunities(db, user.id)
