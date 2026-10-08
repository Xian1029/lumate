"""Temporary observability for legacy learning-plan writes.

This module is intentionally dependency-free so ORM model events can import it
without creating a model/service import cycle.  Counters reset on process
restart; they are a migration guardrail, not product analytics.
"""

from __future__ import annotations

from collections import Counter
import logging
from typing import Any

logger = logging.getLogger(__name__)
_legacy_write_counts: Counter[str] = Counter()


def record_legacy_write(kind: str, **context: Any) -> None:
    _legacy_write_counts[kind] += 1
    logger.warning("legacy_learning_plan_write", extra={"legacy_write_kind": kind, **context})


def legacy_write_counts() -> dict[str, int]:
    return dict(_legacy_write_counts)


def reset_legacy_write_counts() -> None:
    """Test-only reset; production code should only read the counters."""
    _legacy_write_counts.clear()
