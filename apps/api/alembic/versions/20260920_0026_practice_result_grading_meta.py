"""Add grading evidence column to practice_results.

Revision ID: 0026_practice_grading_meta
Revises: 0025_learning_plan_domain
Create Date: 2026-09-20

Stores auditable evidence from the unified AnswerGradingService
(match_type, confidence, reason, grader_version, semantic usage) so that
historical grading decisions can be inspected and re-graded later.
Nullable — existing rows remain valid.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0026_practice_grading_meta"
down_revision: Union[str, None] = "0025_learning_plan_domain"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("practice_results") as batch_op:
        batch_op.add_column(sa.Column("grading_meta", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("practice_results") as batch_op:
        batch_op.drop_column("grading_meta")
