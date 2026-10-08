"""Add page-level extraction statistics to ingestion_jobs.

Revision ID: 0027_ingestion_page_stats
Revises: 0026_practice_grading_meta
Create Date: 2026-09-20

Stores per-file extraction integrity stats:
{"total": 100, "parsed": 82, "failed_pages": [..], "unit": "pages"}

Nullable — jobs ingested before this migration simply have no stats.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0027_ingestion_page_stats"
down_revision: Union[str, None] = "0026_practice_grading_meta"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ingestion_jobs") as batch_op:
        batch_op.add_column(sa.Column("page_stats", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("ingestion_jobs") as batch_op:
        batch_op.drop_column("page_stats")
