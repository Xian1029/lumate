"""Curriculum-grounded question-bank catalog.

The existing ``practice_problems`` table remains the operational source of
truth for learning sessions and answer records.  These tables add a durable,
textbook-first index around it without breaking existing course workflows.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from database import Base
from models.compat import CompatJSONB, CompatUUID


class CurriculumTextbook(Base):
    """One uploaded textbook, identified by publisher, grade and semester."""

    __tablename__ = "curriculum_textbooks"
    __table_args__ = (
        UniqueConstraint("course_id", "source_file", name="uq_catalog_textbook_course_file"),
        Index("ix_catalog_textbook_lookup", "publisher", "subject", "grade", "semester"),
    )

    id: Mapped[uuid.UUID] = mapped_column(CompatUUID, primary_key=True, default=uuid.uuid4)
    course_id: Mapped[uuid.UUID] = mapped_column(CompatUUID, ForeignKey("courses.id", ondelete="CASCADE"))
    publisher: Mapped[str] = mapped_column(String(100), default="未识别版本")
    edition: Mapped[str | None] = mapped_column(String(100), nullable=True)
    subject: Mapped[str | None] = mapped_column(String(80), nullable=True)
    grade: Mapped[str | None] = mapped_column(String(30), nullable=True)
    semester: Mapped[str | None] = mapped_column(String(30), nullable=True)
    title: Mapped[str] = mapped_column(String(500))
    source_file: Mapped[str] = mapped_column(String(500))
    copyright_notice: Mapped[str | None] = mapped_column(Text, nullable=True)
    license: Mapped[str | None] = mapped_column(String(200), nullable=True)
    metadata_: Mapped[dict | None] = mapped_column("metadata", CompatJSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CurriculumChapter(Base):
    """A chapter or section mapped one-to-one to the uploaded content tree."""

    __tablename__ = "curriculum_chapters"
    __table_args__ = (
        UniqueConstraint("textbook_id", "code", name="uq_catalog_chapter_textbook_code"),
        Index("ix_catalog_chapter_textbook_order", "textbook_id", "sort_order"),
    )

    id: Mapped[uuid.UUID] = mapped_column(CompatUUID, primary_key=True, default=uuid.uuid4)
    textbook_id: Mapped[uuid.UUID] = mapped_column(CompatUUID, ForeignKey("curriculum_textbooks.id", ondelete="CASCADE"))
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        CompatUUID, ForeignKey("curriculum_chapters.id", ondelete="CASCADE"), nullable=True
    )
    content_node_id: Mapped[uuid.UUID | None] = mapped_column(
        CompatUUID, ForeignKey("course_content_tree.id", ondelete="SET NULL"), nullable=True, unique=True
    )
    code: Mapped[str] = mapped_column(String(120))
    title: Mapped[str] = mapped_column(String(500))
    level: Mapped[int] = mapped_column(Integer, default=0)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CurriculumKnowledgePoint(Base):
    """A textbook-scoped knowledge point, optionally linked to the course graph."""

    __tablename__ = "curriculum_knowledge_points"
    __table_args__ = (
        UniqueConstraint("textbook_id", "name", name="uq_catalog_knowledge_textbook_name"),
        Index("ix_catalog_knowledge_chapter", "chapter_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(CompatUUID, primary_key=True, default=uuid.uuid4)
    textbook_id: Mapped[uuid.UUID] = mapped_column(CompatUUID, ForeignKey("curriculum_textbooks.id", ondelete="CASCADE"))
    chapter_id: Mapped[uuid.UUID | None] = mapped_column(
        CompatUUID, ForeignKey("curriculum_chapters.id", ondelete="SET NULL"), nullable=True
    )
    knowledge_node_id: Mapped[uuid.UUID | None] = mapped_column(
        CompatUUID, ForeignKey("knowledge_nodes.id", ondelete="SET NULL"), nullable=True
    )
    code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    name: Mapped[str] = mapped_column(String(300))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AbilityTag(Base):
    """Reusable ability label, such as recall, modelling or proof."""

    __tablename__ = "ability_tags"

    id: Mapped[uuid.UUID] = mapped_column(CompatUUID, primary_key=True, default=uuid.uuid4)
    code: Mapped[str] = mapped_column(String(120), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    category: Mapped[str | None] = mapped_column(String(80), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class QuestionCatalogEntry(Base):
    """Catalog profile for one operational practice problem."""

    __tablename__ = "question_catalog_entries"
    __table_args__ = (
        Index("ix_catalog_entry_scope", "textbook_id", "chapter_id", "difficulty"),
        Index("ix_catalog_entry_type_difficulty", "question_type", "difficulty"),
    )

    id: Mapped[uuid.UUID] = mapped_column(CompatUUID, primary_key=True, default=uuid.uuid4)
    problem_id: Mapped[uuid.UUID] = mapped_column(
        CompatUUID, ForeignKey("practice_problems.id", ondelete="CASCADE"), unique=True
    )
    textbook_id: Mapped[uuid.UUID | None] = mapped_column(
        CompatUUID, ForeignKey("curriculum_textbooks.id", ondelete="SET NULL"), nullable=True
    )
    chapter_id: Mapped[uuid.UUID | None] = mapped_column(
        CompatUUID, ForeignKey("curriculum_chapters.id", ondelete="SET NULL"), nullable=True
    )
    question_type: Mapped[str] = mapped_column(String(30))
    difficulty: Mapped[int] = mapped_column(Integer, default=2)
    source_type: Mapped[str] = mapped_column(String(50), default="ai_generated")
    source_reference: Mapped[str | None] = mapped_column(String(500), nullable=True)
    copyright_notice: Mapped[str | None] = mapped_column(Text, nullable=True)
    license: Mapped[str | None] = mapped_column(String(200), nullable=True)
    common_mistake: Mapped[str | None] = mapped_column(Text, nullable=True)
    solution_method: Mapped[str | None] = mapped_column(Text, nullable=True)
    answer_spec: Mapped[dict | None] = mapped_column(CompatJSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class QuestionKnowledgePointLink(Base):
    __tablename__ = "question_knowledge_point_links"
    __table_args__ = (UniqueConstraint("question_entry_id", "knowledge_point_id", name="uq_question_knowledge_link"),)

    id: Mapped[uuid.UUID] = mapped_column(CompatUUID, primary_key=True, default=uuid.uuid4)
    question_entry_id: Mapped[uuid.UUID] = mapped_column(
        CompatUUID, ForeignKey("question_catalog_entries.id", ondelete="CASCADE")
    )
    knowledge_point_id: Mapped[uuid.UUID] = mapped_column(
        CompatUUID, ForeignKey("curriculum_knowledge_points.id", ondelete="CASCADE")
    )


class QuestionAbilityTagLink(Base):
    __tablename__ = "question_ability_tag_links"
    __table_args__ = (UniqueConstraint("question_entry_id", "ability_tag_id", name="uq_question_ability_link"),)

    id: Mapped[uuid.UUID] = mapped_column(CompatUUID, primary_key=True, default=uuid.uuid4)
    question_entry_id: Mapped[uuid.UUID] = mapped_column(
        CompatUUID, ForeignKey("question_catalog_entries.id", ondelete="CASCADE")
    )
    ability_tag_id: Mapped[uuid.UUID] = mapped_column(
        CompatUUID, ForeignKey("ability_tags.id", ondelete="CASCADE")
    )
