"""Add effective study-time session tracking.

Revision ID: 0024_effective_study_time
Revises: 2870051cd576
Create Date: 2026-09-08
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0024_effective_study_time"
down_revision: Union[str, None] = "2870051cd576"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("study_sessions") as batch_op:
        batch_op.add_column(sa.Column("active_seconds", sa.Integer(), nullable=False, server_default="0"))
        batch_op.add_column(sa.Column("elapsed_seconds", sa.Integer(), nullable=False, server_default="0"))
        batch_op.add_column(sa.Column("last_activity_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("client_session_id", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("content_node_id", sa.String(length=36), nullable=True))
        batch_op.add_column(sa.Column("status", sa.String(length=20), nullable=False, server_default="active"))
        batch_op.add_column(sa.Column("activity_breakdown", sa.JSON(), nullable=True))
        batch_op.create_index("ix_study_sessions_client_session_id", ["client_session_id"], unique=False)
        batch_op.create_unique_constraint(
            "uq_study_sessions_user_course_client",
            ["user_id", "course_id", "client_session_id"],
        )
        batch_op.create_foreign_key(
            "fk_study_sessions_content_node_id",
            "course_content_tree",
            ["content_node_id"],
            ["id"],
            ondelete="SET NULL",
        )

    op.execute(
        "UPDATE study_sessions SET active_seconds = COALESCE(duration_minutes, 0) * 60 "
        "WHERE active_seconds = 0"
    )

    op.create_table(
        "study_session_heartbeats",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("session_id", sa.String(length=36), nullable=False),
        sa.Column("active_seconds", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("elapsed_seconds", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["study_sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_study_session_heartbeats_session_id", "study_session_heartbeats", ["session_id"])


def downgrade() -> None:
    op.drop_index("ix_study_session_heartbeats_session_id", table_name="study_session_heartbeats")
    op.drop_table("study_session_heartbeats")
    with op.batch_alter_table("study_sessions") as batch_op:
        batch_op.drop_constraint("fk_study_sessions_content_node_id", type_="foreignkey")
        batch_op.drop_constraint("uq_study_sessions_user_course_client", type_="unique")
        batch_op.drop_index("ix_study_sessions_client_session_id")
        batch_op.drop_column("activity_breakdown")
        batch_op.drop_column("status")
        batch_op.drop_column("content_node_id")
        batch_op.drop_column("client_session_id")
        batch_op.drop_column("last_activity_at")
        batch_op.drop_column("elapsed_seconds")
        batch_op.drop_column("active_seconds")
