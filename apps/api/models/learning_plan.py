"""Authoritative learning-plan domain models.

`StudyPlan` remains a legacy read-only compatibility record. New business plans
and their execution tasks belong to this module.
"""

import enum
import uuid
from datetime import date, datetime
from typing import Optional

from sqlalchemy import CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from database import Base
from models.compat import CompatJSONB, CompatUUID


class LearningPlanSource(str, enum.Enum):
    USER = "USER"
    AI = "AI"
    TEMPLATE = "TEMPLATE"
    MIGRATION = "MIGRATION"


class LearningPlanStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    CHANGES_REQUESTED = "CHANGES_REQUESTED"
    ACTIVE = "ACTIVE"
    PAUSED = "PAUSED"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class LearningPlan(Base):
    """The single business source of truth for a student's learning plan."""

    __tablename__ = "learning_plans"

    id: Mapped[uuid.UUID] = mapped_column(CompatUUID, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(CompatUUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    course_id: Mapped[uuid.UUID] = mapped_column(CompatUUID, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False)
    goal_id: Mapped[Optional[uuid.UUID]] = mapped_column(CompatUUID, ForeignKey("study_goals.id", ondelete="SET NULL"), nullable=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(String(16), nullable=False, default=LearningPlanSource.USER.value)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default=LearningPlanStatus.DRAFT.value)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    start_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    target_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    available_minutes_per_day: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    study_days_of_week: Mapped[Optional[list]] = mapped_column(CompatJSONB, nullable=True)
    total_estimated_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # GeneratedAsset.batch_id is not unique, so this is an indexed compatibility reference, not an FK.
    generated_asset_batch_id: Mapped[Optional[uuid.UUID]] = mapped_column(CompatUUID, nullable=True)
    draft_payload: Mapped[Optional[dict]] = mapped_column(CompatJSONB, nullable=True)
    supersedes_plan_id: Mapped[Optional[uuid.UUID]] = mapped_column(CompatUUID, ForeignKey("learning_plans.id", ondelete="SET NULL"), nullable=True)
    approved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    activated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    paused_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        CheckConstraint("source IN ('USER','AI','TEMPLATE','MIGRATION')", name="ck_learning_plans_source"),
        CheckConstraint("status IN ('DRAFT','PENDING_APPROVAL','CHANGES_REQUESTED','ACTIVE','PAUSED','COMPLETED','CANCELLED')", name="ck_learning_plans_status"),
        CheckConstraint("version >= 1", name="ck_learning_plans_version"),
        Index("ix_learning_plans_user_course_status", "user_id", "course_id", "status"),
        Index("ix_learning_plans_course_status_target", "course_id", "status", "target_date"),
        Index("ix_learning_plans_goal_status", "goal_id", "status"),
        Index("ix_learning_plans_generated_batch", "generated_asset_batch_id"),
    )
