"""Create authoritative LearningPlan and LearningTask domain tables.

Revision ID: 0025_learning_plan_domain
Revises: 0024_effective_study_time
"""

from alembic import op
import sqlalchemy as sa

revision = "0025_learning_plan_domain"
down_revision = "0024_effective_study_time"
branch_labels = None
depends_on = None


def _ensure_audit_logs() -> None:
    """Map the generic audit infrastructure on SQLite installs that skipped old migrations."""
    if "audit_logs" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "audit_logs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("actor_user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("task_id", sa.String(36), sa.ForeignKey("agent_tasks.id", ondelete="SET NULL"), nullable=True),
        sa.Column("tool_name", sa.String(80), nullable=True),
        sa.Column("action_kind", sa.String(80), nullable=False),
        sa.Column("approval_status", sa.String(24), nullable=True),
        sa.Column("outcome", sa.String(40), nullable=False),
        sa.Column("details_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_audit_logs_actor_created", "audit_logs", ["actor_user_id", "created_at"])
    op.create_index("ix_audit_logs_task_created", "audit_logs", ["task_id", "created_at"])
    op.create_index("ix_audit_logs_action_created", "audit_logs", ["action_kind", "created_at"])


def upgrade() -> None:
    _ensure_audit_logs()
    op.create_table(
        "learning_plans",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("course_id", sa.String(36), sa.ForeignKey("courses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("goal_id", sa.String(36), sa.ForeignKey("study_goals.id", ondelete="SET NULL"), nullable=True),
        sa.Column("title", sa.String(200), nullable=False), sa.Column("description", sa.Text(), nullable=True),
        sa.Column("source", sa.String(16), nullable=False, server_default="USER"),
        sa.Column("status", sa.String(24), nullable=False, server_default="DRAFT"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("start_date", sa.Date(), nullable=True), sa.Column("target_date", sa.Date(), nullable=True),
        sa.Column("available_minutes_per_day", sa.Integer(), nullable=True), sa.Column("study_days_of_week", sa.JSON(), nullable=True),
        sa.Column("total_estimated_minutes", sa.Integer(), nullable=True), sa.Column("generated_asset_batch_id", sa.String(36), nullable=True),
        sa.Column("draft_payload", sa.JSON(), nullable=True), sa.Column("supersedes_plan_id", sa.String(36), sa.ForeignKey("learning_plans.id", ondelete="SET NULL"), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True), sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("paused_at", sa.DateTime(timezone=True), nullable=True), sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True), sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False), sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("source IN ('USER','AI','TEMPLATE','MIGRATION')", name="ck_learning_plans_source"),
        sa.CheckConstraint("status IN ('DRAFT','PENDING_APPROVAL','CHANGES_REQUESTED','ACTIVE','PAUSED','COMPLETED','CANCELLED')", name="ck_learning_plans_status"),
        sa.CheckConstraint("version >= 1", name="ck_learning_plans_version"),
    )
    op.create_index("ix_learning_plans_user_course_status", "learning_plans", ["user_id", "course_id", "status"])
    op.create_index("ix_learning_plans_course_status_target", "learning_plans", ["course_id", "status", "target_date"])
    op.create_index("ix_learning_plans_goal_status", "learning_plans", ["goal_id", "status"])
    op.create_index("ix_learning_plans_generated_batch", "learning_plans", ["generated_asset_batch_id"])
    op.create_table(
        "learning_tasks",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("plan_id", sa.String(36), sa.ForeignKey("learning_plans.id", ondelete="CASCADE"), nullable=False),
        sa.Column("course_id", sa.String(36), sa.ForeignKey("courses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("content_node_id", sa.String(36), sa.ForeignKey("course_content_tree.id", ondelete="SET NULL"), nullable=True),
        sa.Column("knowledge_point_id", sa.String(64), nullable=True), sa.Column("task_type", sa.String(16), nullable=False),
        sa.Column("title", sa.String(300), nullable=False), sa.Column("instruction", sa.Text(), nullable=True), sa.Column("action_href", sa.String(1000), nullable=True),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=True), sa.Column("estimated_minutes", sa.Integer(), nullable=True),
        sa.Column("sequence", sa.Integer(), nullable=False, server_default="1"), sa.Column("required", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"), sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("postponed_to", sa.DateTime(timezone=True), nullable=True), sa.Column("planning_reason", sa.Text(), nullable=True), sa.Column("metadata", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False), sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("task_type IN ('LEARN','PRACTICE','FLASHCARD','REVIEW','REFLECTION','ASSESSMENT','NOTE')", name="ck_learning_tasks_type"),
        sa.CheckConstraint("status IN ('PENDING','READY','IN_PROGRESS','COMPLETED','POSTPONED','MISSED','SKIPPED')", name="ck_learning_tasks_status"), sa.CheckConstraint("sequence >= 1", name="ck_learning_tasks_sequence"),
        sa.UniqueConstraint("plan_id", "sequence", name="uq_learning_tasks_plan_sequence"),
    )
    op.create_index("ix_learning_tasks_plan_status_sequence", "learning_tasks", ["plan_id", "status", "sequence"])
    op.create_index("ix_learning_tasks_course_status_scheduled", "learning_tasks", ["course_id", "status", "scheduled_for"])


def downgrade() -> None:
    op.drop_index("ix_learning_tasks_course_status_scheduled", table_name="learning_tasks")
    op.drop_index("ix_learning_tasks_plan_status_sequence", table_name="learning_tasks")
    op.drop_table("learning_tasks")
    op.drop_index("ix_learning_plans_generated_batch", table_name="learning_plans")
    op.drop_index("ix_learning_plans_goal_status", table_name="learning_plans")
    op.drop_index("ix_learning_plans_course_status_target", table_name="learning_plans")
    op.drop_index("ix_learning_plans_user_course_status", table_name="learning_plans")
    op.drop_table("learning_plans")
    # audit_logs is shared infrastructure: never delete it from this migration's downgrade.
