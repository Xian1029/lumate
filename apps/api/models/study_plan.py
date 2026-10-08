"""Study plan model — persists AI-generated learning plans."""

import uuid
from typing import Optional
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, Text, event, func
from models.compat import CompatUUID, CompatJSONB
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


class StudyPlan(Base):
    """Legacy read-only compatibility record.

    New business plans must use ``LearningPlan`` and ``LearningTask``. This
    model stays available only for historical data and legacy API reads.
    """
    __tablename__ = "study_plans"

    id: Mapped[uuid.UUID] = mapped_column(CompatUUID, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(CompatUUID, ForeignKey("users.id"))
    course_id: Mapped[uuid.UUID] = mapped_column(CompatUUID, ForeignKey("courses.id"))

    name: Mapped[str] = mapped_column(String(200))
    scene_id: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)

    # Plan content as structured JSON
    tasks: Mapped[dict] = mapped_column(CompatJSONB, nullable=False)
    # e.g. {"days": [{"date": "2026-03-01", "tasks": [...]}], "total_hours": 12}

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


@event.listens_for(StudyPlan, "before_insert")
@event.listens_for(StudyPlan, "before_update")
def _warn_legacy_study_plan_write(_mapper, _connection, target: StudyPlan) -> None:
    """StudyPlan is read-only after Phase 4; retain an observable guardrail."""
    from services.legacy_plan_monitor import record_legacy_write
    record_legacy_write("study_plan_write_attempt", course_id=str(target.course_id))
