"""Page-stats recording + partial-failure continuation in the ingestion pipeline."""

import uuid
from unittest.mock import AsyncMock, patch

import pytest

from services.ingestion.pipeline import run_ingestion_pipeline


class _FakeDB:
    def __init__(self):
        self.added = []

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        return None

    async def commit(self):
        return None

    async def rollback(self):
        return None

    async def execute(self, _stmt):
        class _Res:
            def scalar_one_or_none(self):
                return None

            def scalars(self):
                class _Scalars:
                    def all(self):
                        return []

                    def __iter__(self):
                        return iter([])

                return _Scalars()

        return _Res()


def _marker(failed: list[int], total: int | None = None) -> str:
    inner = ",".join(map(str, failed))
    if total is not None:
        inner += f"|total={total}"
    return f"[[OPENTUTOR_UNREADABLE_PAGES:{inner}]]"


@pytest.mark.asyncio
async def test_partial_pdf_failure_records_stats_and_continues():
    """97/100 pages parsed: job must NOT fail — it records page_stats and proceeds."""
    extracted_text = "第一章 有理数\n内容……\n" + _marker([5, 9, 20], 100)

    with (
        patch("services.ingestion.pipeline.extract_content_with_title", new=AsyncMock(return_value=("教材", extracted_text))),
        patch("services.ingestion.pipeline.classify_document", new=AsyncMock(return_value=("textbook", "filename_regex"))),
        patch("services.ingestion.pipeline._dispatch_content", new=AsyncMock(return_value={"content_tree": 3})),
        patch("services.parser.pdf._markdown_to_tree", return_value=[]),
        patch("services.parser.pdf.assess_textbook_outline_coverage", return_value=(True, [])),
    ):
        job = await run_ingestion_pipeline(
            db=_FakeDB(),
            user_id=uuid.uuid4(),
            file_path="/tmp/fake.pdf",
            filename="数学教材.pdf",
            course_id=uuid.uuid4(),
        )

    assert job.status != "failed"
    assert job.page_stats == {"total": 100, "parsed": 97, "failed_pages": [5, 9, 20], "unit": "pages"}
    # marker stripped from stored text
    assert "OPENTUTOR_UNREADABLE_PAGES" not in (job.extracted_markdown or "")


@pytest.mark.asyncio
async def test_legacy_marker_without_total_still_parsed():
    """Old-style marker (no |total=N) must not break stats parsing."""
    extracted_text = "内容\n" + _marker([3, 7])

    with (
        patch("services.ingestion.pipeline.extract_content_with_title", new=AsyncMock(return_value=("t", extracted_text))),
        patch("services.ingestion.pipeline.classify_document", new=AsyncMock(return_value=("notes", "filename_regex"))),
        patch("services.ingestion.pipeline._dispatch_content", new=AsyncMock(return_value={"content_tree": 1})),
    ):
        job = await run_ingestion_pipeline(
            db=_FakeDB(),
            user_id=uuid.uuid4(),
            file_path="/tmp/fake.pdf",
            filename="notes.pdf",
            course_id=uuid.uuid4(),
        )

    assert job.status != "failed"
    assert job.page_stats["failed_pages"] == [3, 7]
