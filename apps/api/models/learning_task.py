"""Execution tasks owned by an authoritative :class:`LearningPlan`."""

import enum
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from database import Base
from models.compat import CompatJSONB, CompatUUID


class LearningTaskType(str, enum.Enum):
    LEARN = "LEARN"
    PRACTICE = "PRACTICE"
    FLASHCARD = "FLASHCARD"
    REVIEW = "REVIEW"
    REFLECTION = "REFLECTION"
    ASSESSMENT = "ASSESSMENT"
    NOTE = "NOTE"


class LearningTaskStatus(str, enum.Enum):
    PENDING = "PENDING"
    READY = "READY"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    POSTPONED = "POSTPONED"
    MISSED = "MISSED"
    SKIPPED = "SKIPPED"


class LearningTask(Base):
    """A server-authoritative learning action; browser state is never its truth."""

    __tablename__ = "learning_tasks"

    id: Mapped[uuid.UUID] = mapped_column(CompatUUID, primary_key=True, default=uuid.uuid4)
    plan_id: Mapped[uuid.UUID] = mapped_column(CompatUUID, ForeignKey("learning_plans.id", ondelete="CASCADE"), nullable=False)
    course_id: Mapped[uuid.UUID] = mapped_column(CompatUUID, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False)
    content_node_id: Mapped[Optional[uuid.UUID]] = mapped_column(CompatUUID, ForeignKey("course_content_tree.id", ondelete="SET NULL"), nullable=True)
    # Knowledge graph/catalog identities are not a shared FK yet; retain a nullable compatible reference.
    knowledge_point_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    task_type: Mapped[str] = mapped_column(String(16), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    instruction: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    action_href: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    scheduled_for: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    estimated_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=LearningTaskStatus.PENDING.value)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    postponed_to: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    planning_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    metadata_json: Mapped[Optional[dict]] = mapped_column("metadata", CompatJSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        CheckConstraint("task_type IN ('LEARN','PRACTICE','FLASHCARD','REVIEW','REFLECTION','ASSESSMENT','NOTE')", name="ck_learning_tasks_type"),
        CheckConstraint("status IN ('PENDING','READY','IN_PROGRESS','COMPLETED','POSTPONED','MISSED','SKIPPED')", name="ck_learning_tasks_status"),
        CheckConstraint("sequence >= 1", name="ck_learning_tasks_sequence"),
        UniqueConstraint("plan_id", "sequence", name="uq_learning_tasks_plan_sequence"),
        Index("ix_learning_tasks_plan_status_sequence", "plan_id", "status", "sequence"),
        Index("ix_learning_tasks_course_status_scheduled", "course_id", "status", "scheduled_for"),
    )
