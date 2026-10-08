"""Store comprehension probe metadata on LearningProgress.

Revision ID: 0032_learning_progress_metadata
Revises: 0031_wrong_answer_attempt_count
"""

from alembic import op
import sqlalchemy as sa


revision = "0032_learning_progress_metadata"
down_revision = "0031_wrong_answer_attempt_count"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("learning_progress") as batch_op:
        batch_op.add_column(sa.Column("metadata_json", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("learning_progress") as batch_op:
        batch_op.drop_column("metadata_json")
