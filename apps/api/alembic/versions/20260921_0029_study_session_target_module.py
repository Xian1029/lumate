"""Persist the exact module for resume learning.

Revision ID: 0029_study_session_target_module
Revises: 0028_course_trash
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0029_study_session_target_module"
down_revision: Union[str, None] = "0028_course_trash"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    with op.batch_alter_table("study_sessions") as batch_op:
        batch_op.add_column(sa.Column("target_module", sa.String(length=30), nullable=True))

def downgrade() -> None:
    with op.batch_alter_table("study_sessions") as batch_op:
        batch_op.drop_column("target_module")
