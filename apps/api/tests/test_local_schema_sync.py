"""Regression tests for the local SQLite additive schema sync.

Close-out contract: the local dev flow bootstraps schema via
``Base.metadata.create_all`` + additive ``ALTER TABLE`` syncs (hosted
deployments use Alembic).  ``create_all`` never adds a column to an existing
table, so every nullable column added to a pre-existing table must also land
in the local sync — otherwise an older local DB 500s on the first INSERT
that touches the new column (e.g. a quiz submission writing ``grading_meta``).
"""

import pytest
from sqlalchemy import create_engine, inspect, text

from database import Base
from services.app_lifecycle import (
    _LOCAL_ADDITIVE_COLUMNS,
    _upgrade_local_additive_columns,
)

# DDL for the two tables as they existed *before* migrations 0026/0027 —
# the minimal shape an old local SQLite file can have.
_OLD_PRACTICE_RESULTS_DDL = """
CREATE TABLE practice_results (
    id VARCHAR(36) PRIMARY KEY,
    problem_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    user_answer TEXT,
    is_correct BOOLEAN,
    ai_explanation TEXT,
    error_category VARCHAR(50),
    difficulty_layer VARCHAR(20),
    answer_time_ms INTEGER,
    answered_at DATETIME
)
"""

_OLD_INGESTION_JOBS_DDL = """
CREATE TABLE ingestion_jobs (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    source_type VARCHAR(20),
    original_filename VARCHAR(500),
    url TEXT,
    file_path TEXT,
    content_hash VARCHAR(64),
    course_id VARCHAR(36),
    status VARCHAR(20),
    progress_percent INTEGER,
    phase_label VARCHAR(100),
    embedding_status VARCHAR(20)
)
"""


@pytest.fixture
def old_db_engine():
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.execute(text(_OLD_PRACTICE_RESULTS_DDL))
        conn.execute(text(_OLD_INGESTION_JOBS_DDL))
    yield engine
    engine.dispose()


def _columns(engine, table: str) -> set[str]:
    return {col["name"] for col in inspect(engine).get_columns(table)}


def test_upgrade_adds_grading_meta_to_old_practice_results(old_db_engine):
    with old_db_engine.begin() as conn:
        assert "grading_meta" not in _columns(old_db_engine, "practice_results")
        _upgrade_local_additive_columns(conn)
    assert "grading_meta" in _columns(old_db_engine, "practice_results")


def test_upgrade_adds_page_stats_to_old_ingestion_jobs(old_db_engine):
    with old_db_engine.begin() as conn:
        assert "page_stats" not in _columns(old_db_engine, "ingestion_jobs")
        _upgrade_local_additive_columns(conn)
    assert "page_stats" in _columns(old_db_engine, "ingestion_jobs")


def test_upgrade_is_idempotent(old_db_engine):
    with old_db_engine.begin() as conn:
        _upgrade_local_additive_columns(conn)
        _upgrade_local_additive_columns(conn)  # second run must not raise
    assert "grading_meta" in _columns(old_db_engine, "practice_results")
    assert "page_stats" in _columns(old_db_engine, "ingestion_jobs")


def test_upgrade_tolerates_missing_tables():
    """A DB that predates the tables entirely is handled by create_all —
    the additive sync must simply skip them."""
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        _upgrade_local_additive_columns(conn)  # must not raise
    engine.dispose()


def test_synced_columns_exist_in_current_models():
    """Guard against drift: every locally-synced column must still exist in
    the ORM model (a renamed/removed column would silently stop syncing)."""
    for table, additions in _LOCAL_ADDITIVE_COLUMNS.items():
        assert table in Base.metadata.tables, table
        model_columns = set(Base.metadata.tables[table].columns.keys())
        for name in additions:
            assert name in model_columns, f"{table}.{name} not in current model"
