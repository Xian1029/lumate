"""Track repeated wrong attempts on one logical wrong-answer record.

Revision ID: 0031_wrong_answer_attempt_count
Revises: 0030_ingestion_attempt_state
"""

from alembic import op
import sqlalchemy as sa


revision = "0031_wrong_answer_attempt_count"
down_revision = "0030_ingestion_attempt_state"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("wrong_answers") as batch_op:
        batch_op.add_column(sa.Column("wrong_attempt_count", sa.Integer(), nullable=False, server_default="1"))


def downgrade() -> None:
    with op.batch_alter_table("wrong_answers") as batch_op:
        batch_op.drop_column("wrong_attempt_count")
