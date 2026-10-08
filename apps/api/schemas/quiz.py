"""Pydantic schemas for quiz endpoints."""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator

from services.practice.annotation import normalize_question_options


class ExtractRequest(BaseModel):
    course_id: uuid.UUID
    content_node_id: uuid.UUID | None = None
    # One learner-facing generation request is intentionally small enough for
    # focused practice.  The API enforces the same cap when callers omit this.
    count: int | None = Field(default=None, ge=1, le=15)
    mode: str | None = None  # learning mode: course_following, self_paced, exam_prep, maintenance
    difficulty: str | None = None  # easy | medium | hard
    language: str | None = Field(default=None, pattern="^(en|zh)$")
    avoid_existing: bool = False


class SubmitAnswerRequest(BaseModel):
    problem_id: uuid.UUID
    user_answer: str = Field(..., max_length=5000)
    answer_time_ms: int | None = None  # Time from question display to answer submission


class SaveGeneratedRequest(BaseModel):
    course_id: uuid.UUID
    raw_content: str = Field(..., max_length=50000)
    title: str | None = Field(default=None, max_length=500)
    replace_batch_id: uuid.UUID | None = None


class QuizNodeFailureResponse(BaseModel):
    node_id: str | None = None
    title: str
    reason: str
    discarded_count: int = 0
    errors: list[str] = Field(default_factory=list)


class ExtractResponse(BaseModel):
    status: str
    problems_created: int
    validated_count: int = 0
    repaired_count: int = 0
    discarded_count: int = 0
    node_failures: list[QuizNodeFailureResponse] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    problem_ids: list[str] = Field(default_factory=list)
    # A learner-visible exercise set.  The client uses it only to resume an
    # unfinished set; completion is still decided from server-side results.
    batch_id: str | None = None


class ProblemResponse(BaseModel):
    id: uuid.UUID
    question_type: str
    question: str
    options: dict[str, str] | None
    order_index: int
    content_node_id: uuid.UUID | None = None
    difficulty_layer: int | None = None
    problem_metadata: dict[str, Any] | None = None
    # Safe readiness flags let the UI exclude legacy questions that cannot show
    # feedback, without revealing the correct answer before submission.
    answer_ready: bool = False
    explanation_ready: bool = False
    # Filled only when the learner has already submitted this problem
    # (checked via PracticeResult existence in list_problems endpoint).
    correct_answer: str | None = None
    explanation: str | None = None
    # Server-authoritative completion state.  Do not infer this from cached
    # browser answers: a learner may resume on another device.
    is_answered: bool = False
    source_batch_id: str | None = None

    model_config = {"from_attributes": True}

    @field_validator("options", mode="before")
    @classmethod
    def normalize_options(cls, value: Any) -> dict[str, str] | None:
        return normalize_question_options(value)


class PrerequisiteGap(BaseModel):
    concept: str
    concept_id: str
    mastery: float
    gap_severity: float


class AnswerResponse(BaseModel):
    is_correct: bool
    correct_answer: str | None
    user_answer: str | None
    explanation: str | None
    prerequisite_gaps: list[PrerequisiteGap] | None = None
    warnings: list[str] = Field(default_factory=list)
    # Unified grading output (answer-grader-v2+). Optional so older clients
    # and the coding grader path remain valid.
    match_type: str | None = None
    score: float | None = None
    needs_review: bool = False
    per_blank_results: list[dict] | None = None
    grader_version: str | None = None
    feedback: str | None = None


class MasterySnapshotResponse(BaseModel):
    mastery_score: float
    gap_type: str | None
    content_node_id: str | None
    recorded_at: datetime


# ── CAT Pre-test ──

class PretestStartRequest(BaseModel):
    course_id: uuid.UUID


class PretestAnswerRequest(BaseModel):
    course_id: uuid.UUID
    concept_id: uuid.UUID
    correct: bool  # Frontend evaluates MC answer and sends boolean
