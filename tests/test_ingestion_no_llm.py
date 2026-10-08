"""Regression tests: ingestion must never fail when no LLM is available.

Contract (system close-out): the LLM is an *enhancement* layer, not a single
point of failure for basic ingestion. With no provider configured (or the
provider down), the pipeline must still:

1. Classify via the zero-cost tiers (filename regex / content heuristics)
   and fall back to ``"other"`` instead of raising.
2. Extract deadlines via regex/Canvas tiers; the LLM tier returns ``[]``.
3. Skip AI enrichment (notes/flashcards/quiz auto-generation) gracefully
   instead of marking the job ``failed``.
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

API_ROOT = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from libs.exceptions import LLMUnavailableError  # noqa: E402
from services.llm.router import LLMConfigurationError  # noqa: E402
from services.ingestion.classification import (  # noqa: E402
    classify_content,
    classify_document,
)
from services.ingestion.deadline_extractor import (  # noqa: E402
    extract_and_create_deadlines,
    extract_deadlines_llm,
    extract_deadlines_regex,
)


def run(coro):
    return asyncio.run(coro)


_NO_LLM_MSG = "No LLM provider is configured."


def _raise_no_llm(*args, **kwargs):
    raise LLMConfigurationError(_NO_LLM_MSG)


class ClassificationNoLlmTests(unittest.TestCase):
    """Step 3 classification must degrade, never raise, without an LLM."""

    def test_classify_content_returns_other_when_llm_unconfigured(self):
        with patch(
            "services.ingestion.classification.get_llm_client",
            side_effect=_raise_no_llm,
        ):
            # Content long enough that heuristics don't match — only the LLM
            # tier could classify it, and it is unavailable.
            result = run(classify_content("x" * 500))
        self.assertEqual(result, "other")

    def test_classify_document_filename_tier_needs_no_llm(self):
        category, method = run(classify_document("", "lecture_slides_week3.pdf"))
        self.assertEqual(category, "lecture_slides")
        self.assertEqual(method, "filename_regex")

    def test_classify_document_heuristics_tier_needs_no_llm(self):
        content = "Chapter 1 Introduction. Section 1.1 Overview. " * 5
        category, method = run(classify_document(content, "material.pdf"))
        self.assertEqual(category, "textbook")
        self.assertEqual(method, "content_heuristics")

    def test_classify_document_llm_tier_failure_falls_back_to_other(self):
        with patch(
            "services.ingestion.classification.get_llm_client",
            side_effect=_raise_no_llm,
        ):
            # No filename signal, no heuristic signal → reaches the LLM tier.
            category, method = run(classify_document("x" * 500, "material.pdf"))
        self.assertEqual(category, "other")
        self.assertEqual(method, "llm_classification")


class DeadlineNoLlmTests(unittest.TestCase):
    """Tier B (LLM) deadline extraction returns [] and never blocks Tiers A/C."""

    def test_llm_tier_returns_empty_when_unconfigured(self):
        with patch(
            "services.llm.router.get_llm_client",
            side_effect=_raise_no_llm,
        ):
            result = run(extract_deadlines_llm("Week 5 Friday: homework due"))
        self.assertEqual(result, [])

    def test_regex_tier_extracts_without_any_llm(self):
        content = (
            "Syllabus for the semester.\n"
            "Homework 1 due 2026-10-05 at midnight.\n"
            "Midterm exam: October 20, 2026.\n"
        ) * 2
        deadlines = extract_deadlines_regex(content)
        self.assertTrue(deadlines)
        self.assertTrue(all(not d.needs_llm_resolution for d in deadlines))

    def test_extract_and_create_deadlines_regex_only_no_llm(self):
        """Full orchestration path: regex deadlines are persisted even with
        the LLM tier raising — Tier B is best-effort, not a gate."""

        class _FakeResult:
            def scalars(self):
                return self

            def all(self):
                return []

        class _FakeSession:
            def __init__(self):
                self.added = []

            async def execute(self, *args, **kwargs):
                return _FakeResult()

            def add(self, obj):
                self.added.append(obj)

            async def flush(self):
                pass

        import uuid

        db = _FakeSession()
        content = (
            "Homework 1 due October 5, 2026. "
            "Homework 2 due October 12, 2026."
        )
        with patch(
            "services.llm.router.get_llm_client",
            side_effect=_raise_no_llm,
        ):
            created = run(
                extract_and_create_deadlines(
                    db=db,
                    course_id=uuid.uuid4(),
                    content=content,
                )
            )
        self.assertGreaterEqual(created, 1)
        self.assertEqual(len(db.added), created)


class AutoGenerateNoLlmTests(unittest.TestCase):
    """AI enrichment must skip gracefully — the ingestion job stays completed."""

    def test_background_auto_generate_skips_when_llm_not_ready(self):
        from routers.upload_processing import _background_auto_generate

        async def _boom(feature_name: str, **kwargs):
            raise LLMUnavailableError(f"{feature_name} is unavailable")

        with patch(
            "routers.upload_processing.ensure_llm_ready",
            side_effect=_boom,
        ), patch(
            "services.ingestion.pipeline.auto_prepare",
            new=AsyncMock(),
        ) as mock_prepare:
            # Must not raise — enrichment is skipped silently.
            run(_background_auto_generate(course_id=_uuid4(), user_id=_uuid4()))

        mock_prepare.assert_not_called()


def _uuid4():
    import uuid

    return uuid.uuid4()


if __name__ == "__main__":
    unittest.main()
