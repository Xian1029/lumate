"""Request/response schemas for the authoritative plan domain."""

import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, Field

from models.learning_plan import LearningPlanSource
from models.learning_task import LearningTaskType


class CreateLearningPlanRequest(BaseModel):
    course_id: uuid.UUID
    title: str = Field(min_length=1, max_length=200)
    description: str | None = None
    goal_id: uuid.UUID | None = None
    source: LearningPlanSource = LearningPlanSource.USER
    start_date: date | None = None
    target_date: date | None = None
    available_minutes_per_day: int | None = Field(default=None, ge=1)
    study_days_of_week: list[int] | None = None
    total_estimated_minutes: int | None = Field(default=None, ge=1)
    generated_asset_batch_id: uuid.UUID | None = None
    draft_payload: dict[str, Any] | None = None
    supersedes_plan_id: uuid.UUID | None = None


class UpdateLearningPlanRequest(BaseModel):
    expected_version: int | None = Field(default=None, ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    start_date: date | None = None
    target_date: date | None = None
    available_minutes_per_day: int | None = Field(default=None, ge=1)
    study_days_of_week: list[int] | None = None
    total_estimated_minutes: int | None = Field(default=None, ge=1)
    draft_payload: dict[str, Any] | None = None


class PlanActionRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=2000)
    expected_version: int | None = Field(default=None, ge=1)


class CreateLearningTaskRequest(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    task_type: LearningTaskType
    sequence: int = Field(ge=1)
    content_node_id: uuid.UUID | None = None
    knowledge_point_id: str | None = Field(default=None, max_length=64)
    instruction: str | None = None
    action_href: str | None = Field(default=None, max_length=1000)
    scheduled_for: datetime | None = None
    estimated_minutes: int | None = Field(default=None, ge=1)
    required: bool = True
    planning_reason: str | None = None
    metadata_json: dict[str, Any] | None = None


class UpdateLearningTaskRequest(BaseModel):
    """Only unfinished tasks are editable; completed work is historical fact."""
    title: str | None = Field(default=None, min_length=1, max_length=300)
    task_type: LearningTaskType | None = None
    content_node_id: uuid.UUID | None = None
    knowledge_point_id: str | None = Field(default=None, max_length=64)
    instruction: str | None = None
    action_href: str | None = Field(default=None, max_length=1000)
    scheduled_for: datetime | None = None
    estimated_minutes: int | None = Field(default=None, ge=1)
    sequence: int | None = Field(default=None, ge=1)
    planning_reason: str | None = None


class PostponeLearningTaskRequest(BaseModel):
    postponed_to: datetime


class LearningPlanResponse(BaseModel):
    id: str; user_id: str; course_id: str; goal_id: str | None
    title: str; description: str | None; source: str; status: str; version: int
    start_date: date | None; target_date: date | None; available_minutes_per_day: int | None
    study_days_of_week: list[Any] | None; total_estimated_minutes: int | None
    generated_asset_batch_id: str | None; draft_payload: dict[str, Any] | None; supersedes_plan_id: str | None
    approved_at: datetime | None; activated_at: datetime | None; paused_at: datetime | None; completed_at: datetime | None; cancelled_at: datetime | None
    created_at: datetime | None; updated_at: datetime | None


class LearningTaskResponse(BaseModel):
    id: str; plan_id: str; course_id: str; content_node_id: str | None; knowledge_point_id: str | None
    task_type: str; title: str; instruction: str | None; action_href: str | None
    scheduled_for: datetime | None; estimated_minutes: int | None; sequence: int; required: bool; status: str
    completed_at: datetime | None; postponed_to: datetime | None; planning_reason: str | None; metadata_json: dict[str, Any] | None
    created_at: datetime | None; updated_at: datetime | None


class StartLearningPlanResponse(BaseModel):
    """The only payload a client needs to launch a plan task."""
    plan: LearningPlanResponse
    task: LearningTaskResponse
    href: str
    target_module: str
    relocated: bool = False
