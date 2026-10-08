"""Add authoritative attempt/workflow state to ingestion jobs.

Revision ID: 0030_ingestion_attempt_state
Revises: 0029_study_session_target_module
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from models.compat import CompatUUID

revision: str = "0030_ingestion_attempt_state"
down_revision: Union[str, None] = "0029_study_session_target_module"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ingestion_jobs") as batch_op:
        batch_op.add_column(sa.Column("processing_attempt_id", CompatUUID(), nullable=True))
        batch_op.add_column(sa.Column("workflow_state", sa.String(length=50), nullable=False, server_default="UPLOADED"))
        batch_op.add_column(sa.Column("failure_code", sa.String(length=50), nullable=True))
        batch_op.add_column(sa.Column("is_current_attempt", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch_op.add_column(sa.Column("superseded_by_id", CompatUUID(), nullable=True))
    op.execute("UPDATE ingestion_jobs SET processing_attempt_id = id WHERE processing_attempt_id IS NULL")
    with op.batch_alter_table("ingestion_jobs") as batch_op:
        batch_op.alter_column("processing_attempt_id", nullable=False)
        batch_op.create_index("ix_ingestion_jobs_processing_attempt_id", ["processing_attempt_id"])
        batch_op.create_index("ix_ingestion_jobs_workflow_state", ["workflow_state"])
        batch_op.create_index("ix_ingestion_jobs_is_current_attempt", ["is_current_attempt"])


def downgrade() -> None:
    with op.batch_alter_table("ingestion_jobs") as batch_op:
        batch_op.drop_index("ix_ingestion_jobs_is_current_attempt")
        batch_op.drop_index("ix_ingestion_jobs_workflow_state")
        batch_op.drop_index("ix_ingestion_jobs_processing_attempt_id")
        batch_op.drop_column("superseded_by_id")
        batch_op.drop_column("is_current_attempt")
        batch_op.drop_column("failure_code")
        batch_op.drop_column("workflow_state")
        batch_op.drop_column("processing_attempt_id")
