"""Deterministic concept-to-curriculum linking shared by LOOM and LECTOR."""

from __future__ import annotations

import re
from collections.abc import Iterable

from models.content import CourseContentTree


_NON_LEARNING_CATEGORIES = {"reference", "syllabus", "assignment", "exam_schedule", "other"}
_NON_LEARNING_TITLE = re.compile(r"前言|目录|版权|出版社|编者|主编|出版说明|封面")
_STRUCTURE_PREFIX = re.compile(r"^(?:第[^章节]{0,8}[章节]|\d+(?:[.．·]\d+)*|[一二三四五六七八九十]+[、.．])")


def _normalized(value: str) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", value.lower())


def _title_core(value: str) -> str:
    return _normalized(_STRUCTURE_PREFIX.sub("", value.strip()))


def _bigrams(value: str) -> set[str]:
    return {value[index:index + 2] for index in range(max(0, len(value) - 1))}


def _match_score(concept_name: str, node: CourseContentTree) -> float:
    concept = _normalized(concept_name)
    title = _title_core(node.title or "")
    if not concept or not title:
        return 0.0

    score = 0.0
    if title == concept:
        score = 140.0
    elif concept in title:
        score = 110.0 + min(15.0, len(concept))
    elif len(title) >= 2 and title in concept:
        score = 90.0 + min(12.0, len(title))
    else:
        concept_pairs = _bigrams(concept)
        title_pairs = _bigrams(title)
        if concept_pairs and title_pairs:
            overlap = len(concept_pairs & title_pairs) / len(concept_pairs | title_pairs)
            score = overlap * 70.0

    if concept in _normalized(node.content or ""):
        score += 18.0
    score += min(max(node.level or 0, 0), 4) * 2.0
    return score


def is_learnable_curriculum_node(node: CourseContentTree) -> bool:
    if (node.content_category or "") in _NON_LEARNING_CATEGORIES:
        return False
    if _NON_LEARNING_TITLE.search(node.title or ""):
        return False
    return (node.level or 0) > 0 and bool((node.content or "").strip())


def select_best_content_node(
    concept_name: str,
    content_nodes: Iterable[CourseContentTree],
) -> CourseContentTree | None:
    """Return the most specific learnable section matching a concept."""
    candidates = [node for node in content_nodes if is_learnable_curriculum_node(node)]
    if not candidates:
        return None
    scored = sorted(
        ((_match_score(concept_name, node), node) for node in candidates),
        key=lambda item: (item[0], item[1].level or 0),
        reverse=True,
    )
    best_score, best_node = scored[0]
    return best_node if best_score >= 32.0 else None
