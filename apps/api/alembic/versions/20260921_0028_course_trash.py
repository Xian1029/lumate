"""Add recoverable learning-space trash state.

Revision ID: 0028_course_trash
Revises: 0027_ingestion_page_stats
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0028_course_trash"
down_revision: Union[str, None] = "0027_ingestion_page_stats"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    with op.batch_alter_table("courses") as batch_op:
        batch_op.add_column(sa.Column("status", sa.String(length=20), nullable=False, server_default="ACTIVE"))
        batch_op.add_column(sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))

def downgrade() -> None:
    with op.batch_alter_table("courses") as batch_op:
        batch_op.drop_column("deleted_at")
        batch_op.drop_column("status")
