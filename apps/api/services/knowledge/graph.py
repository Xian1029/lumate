"""Knowledge graph builders for frontend graph rendering."""

from __future__ import annotations

import uuid
import inspect
import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.content import CourseContentTree
from models.knowledge_graph import KnowledgeNode
from models.progress import LearningProgress
from services.knowledge.content_linking import is_learnable_curriculum_node
from services.learning_progress import learnable_leaf_nodes
from services.loom_graph import get_mastery_graph


def _status_from_mastery(mastery: float) -> str:
    if mastery >= 0.85:
        return "mastered"
    if mastery >= 0.6:
        return "reviewed"
    if mastery > 0:
        return "in_progress"
    return "not_started"


def _color_from_status(status: str) -> str:
    if status == "mastered":
        return "#22C55E"
    if status == "reviewed":
        return "#3B82F6"
    if status == "in_progress":
        return "#F59E0B"
    return "#94A3B8"


_DISPLAY_SECTION_PREFIX = re.compile(r"^\s*(?:\d+(?:[.．]\d+)+[、.．:：\s-]*|第[一二三四五六七八九十百\d]+[章节][、.．:：\s-]*)")


def _concept_display_label(title: str) -> str:
    """Keep source titles intact while removing outline numbering in the map."""
    normalized = _DISPLAY_SECTION_PREFIX.sub("", str(title or "")).strip()
    return normalized or str(title or "未命名知识点")


def _normalize_relationship_edges(edges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep one non-redundant explanation for each directed relationship.

    Imported AI graphs sometimes describe the same pair as both ``related``
    and ``prerequisite``. The former contributes no new guidance once a
    stronger prerequisite relation exists. The same applies when the source
    tree has supplied a concrete curriculum sequence for that pair. Keeping
    all of them makes the learner-facing card look contradictory.
    """
    unique: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    types_by_pair: dict[tuple[str, str], set[str]] = {}
    for edge in edges:
        source, target, relation_type = str(edge["source"]), str(edge["target"]), str(edge["type"])
        key = (source, target, relation_type)
        if key in seen:
            continue
        seen.add(key)
        unique.append({"source": source, "target": target, "type": relation_type})
        types_by_pair.setdefault((source, target), set()).add(relation_type)

    return [
        edge for edge in unique
        if not (
            edge["type"] == "related"
            and ({"prerequisite", "curriculum_sequence"} & types_by_pair[(edge["source"], edge["target"])])
        )
    ]


def _material_sort_key(source_file: str) -> tuple[int, int, str]:
    """Provide a stable curriculum order for uploaded materials.

    A learning space may hold several textbooks.  ``order_index`` is scoped
    to one document, so it cannot establish a cross-textbook order by itself.
    We only interpret grade/semester when they are explicitly present in the
    filename; every other material keeps a deterministic lexical fallback.
    This is display/recommendation order, not a fabricated prerequisite.
    """
    text = str(source_file or "")
    grade_map = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    grade = 999
    for label, value in grade_map.items():
        if f"{label}年级" in text:
            grade = value
            break
    else:
        import re
        match = re.search(r"([1-9])年级", text)
        if match:
            grade = int(match.group(1))
    semester = 0 if "上册" in text else 1 if "下册" in text else 2
    return (grade, semester, text.casefold())


def _ordered_content_nodes(nodes: list[CourseContentTree]) -> list[CourseContentTree]:
    """Return parsed textbook nodes in source-tree reading order.

    This consumes the persisted tree rather than guessing a new textbook
    structure, so new uploads automatically follow the same rule.
    """
    by_parent: dict[uuid.UUID | None, list[CourseContentTree]] = {}
    for node in nodes:
        by_parent.setdefault(node.parent_id, []).append(node)
    for siblings in by_parent.values():
        siblings.sort(key=lambda item: (getattr(item, "order_index", 0) or 0, item.title.casefold(), str(item.id)))

    ordered: list[CourseContentTree] = []

    def visit(node: CourseContentTree) -> None:
        ordered.append(node)
        for child in by_parent.get(node.id, []):
            visit(child)

    roots = by_parent.get(None, [])
    roots.sort(key=lambda item: (_material_sort_key(getattr(item, "source_file", None) or item.title), getattr(item, "order_index", 0) or 0, str(item.id)))
    for root in roots:
        visit(root)
    # Defensive fallback for malformed legacy trees with an orphan parent.
    seen = {node.id for node in ordered}
    ordered.extend(node for node in nodes if node.id not in seen)
    return ordered


def _status_from_learning_progress(progress: LearningProgress | None) -> tuple[str, float]:
    """Translate the existing content-progress source of truth for fallback nodes."""
    if progress is None:
        return "not_started", 0.0
    status = str(progress.status or "not_started")
    mastery = max(0.0, min(1.0, float(progress.mastery_score or 0.0)))
    if status == "mastered":
        return "mastered", mastery
    if status == "reviewed":
        return "reviewed", mastery
    if status == "in_progress":
        return "in_progress", mastery
    return "not_started", mastery


async def build_knowledge_graph(
    db: AsyncSession,
    course_id: uuid.UUID,
    user_id: uuid.UUID,
) -> dict[str, Any]:
    """Return a D3-friendly knowledge graph payload for the web app."""
    graph = await get_mastery_graph(db, user_id, course_id)

    raw_nodes = graph.get("nodes", [])
    raw_edges = graph.get("edges", [])

    # The parsed source tree is the coverage baseline.  A completed upload is
    # useful even when asynchronous LOOM extraction creates only a subset of
    # concepts.  Never let a partial AI extraction hide another textbook.
    # `source_file` is inherited from the imported document tree; for older
    # imports that only stored it on an ancestor, resolve it through the tree.
    content_query = db.execute(
        select(CourseContentTree)
        .where(CourseContentTree.course_id == course_id)
        .order_by(CourseContentTree.level.asc(), CourseContentTree.order_index.asc())
    )
    # A small compatibility guard keeps this read service usable by legacy
    # callers/tests that provide a non-async mock. Production AsyncSession
    # always takes the awaited branch.
    content_result = await content_query if inspect.isawaitable(content_query) else None
    all_content_nodes = list(content_result.scalars().all()) if content_result is not None else []
    content_by_id = {item.id: item for item in all_content_nodes}

    def material_key_for_content(content_id: uuid.UUID | None) -> str | None:
        visited: set[uuid.UUID] = set()
        current = content_by_id.get(content_id) if content_id else None
        while current and current.id not in visited:
            visited.add(current.id)
            source_file = getattr(current, "source_file", None)
            if source_file:
                return source_file
            current = content_by_id.get(current.parent_id) if current.parent_id else None
        return None

    def curriculum_context_for_content(content_id: uuid.UUID | None) -> tuple[str | None, str | None]:
        """Return the uploaded material and nearest chapter heading for a node."""
        visited: set[uuid.UUID] = set()
        current = content_by_id.get(content_id) if content_id else None
        material_title: str | None = None
        chapter_title: str | None = None
        while current and current.id not in visited:
            visited.add(current.id)
            material_title = material_title or getattr(current, "source_file", None)
            if chapter_title is None and (current.level or 0) == 1:
                chapter_title = current.title
            current = content_by_id.get(current.parent_id) if current.parent_id else None
        return material_title, chapter_title

    linked_content_by_concept: dict[str, uuid.UUID | None] = {}
    if raw_nodes:
        concept_query = db.execute(
            select(KnowledgeNode.id, KnowledgeNode.content_node_id)
            .where(KnowledgeNode.course_id == course_id)
        )
        concept_result = await concept_query if inspect.isawaitable(concept_query) else None
        linked_content_by_concept = {
            str(concept_id): content_id for concept_id, content_id in concept_result.all()
        } if concept_result is not None else {}

    # ``KnowledgeNode`` stores mastery/semantic relationships; the parsed
    # source tree stores textbook coverage.  Use both, rather than selecting
    # one with an all-or-nothing ``if raw_nodes`` branch.
    # Graph fallback nodes are concrete learnable units, not a duplicated
    # visual copy of every chapter heading. Roots/front matter and intermediate
    # chapter containers remain available as grouping context only. Existing
    # AI-extracted concepts may still represent a genuine chapter-level idea.
    leaf_ids = {node.id for node in learnable_leaf_nodes(all_content_nodes)}
    ordered_learnable_nodes = [
        item for item in _ordered_content_nodes(all_content_nodes)
        if item.id in leaf_ids and is_learnable_curriculum_node(item)
    ]
    material_order = {
        material: index
        for index, material in enumerate(sorted(
            {material_key_for_content(node.id) or getattr(node, "source_file", None) or "未分类资料" for node in ordered_learnable_nodes},
            key=_material_sort_key,
        ))
    }
    curriculum_order_by_content = {node.id: index for index, node in enumerate(ordered_learnable_nodes)}

    progress_by_content: dict[uuid.UUID, LearningProgress] = {}
    if raw_nodes and ordered_learnable_nodes:
        progress_query = db.execute(
            select(LearningProgress).where(
                LearningProgress.user_id == user_id,
                LearningProgress.course_id == course_id,
                LearningProgress.content_node_id.in_([node.id for node in ordered_learnable_nodes]),
            )
        )
        progress_result = await progress_query if inspect.isawaitable(progress_query) else None
        progress_by_content = {
            row.content_node_id: row
            for row in progress_result.scalars().all()
            if getattr(row, "content_node_id", None) is not None
        } if progress_result is not None else {}

    nodes: list[dict[str, Any]] = []
    represented_content_ids: set[uuid.UUID] = set()
    visual_id_by_content: dict[uuid.UUID, str] = {}
    for raw in raw_nodes:
        mastery = float(raw.get("mastery") or 0.0)
        status = _status_from_mastery(mastery)
        level = int(raw.get("bloom_level") or 1)
        size = max(8, min(24, int(10 + mastery * 14)))
        raw_id = str(raw.get("id"))
        content_node_id = raw.get("content_node_id") or linked_content_by_concept.get(raw_id)
        if content_node_id is not None and not isinstance(content_node_id, uuid.UUID):
            try:
                content_node_id = uuid.UUID(str(content_node_id))
            except (TypeError, ValueError):
                content_node_id = None
        if content_node_id in curriculum_order_by_content:
            represented_content_ids.add(content_node_id)
            visual_id_by_content[content_node_id] = raw_id
        material_id = material_key_for_content(content_node_id)
        material_title, chapter_title = curriculum_context_for_content(content_node_id)
        nodes.append(
            {
                "id": raw_id,
                "label": _concept_display_label(str(raw.get("name") or "Untitled Concept")),
                "type": "concept",
                "level": level,
                "size": size,
                "color": _color_from_status(status),
                "status": status,
                "mastery": round(mastery, 3),
                "gap_type": None,
                "content_node_id": str(content_node_id) if content_node_id else None,
                "material_id": material_id,
                "material_title": material_title,
                "chapter_title": chapter_title,
                "material_order": material_order.get(material_id or "未分类资料", len(material_order)),
                "curriculum_order": curriculum_order_by_content.get(content_node_id, len(curriculum_order_by_content)),
            }
        )

    # Add a stable content-backed node for every learnable textbook section
    # that has no AI concept node. Content tree UUIDs are already durable and
    # do not require a write during a GET request.
    for content_node in ordered_learnable_nodes:
        if content_node.id in represented_content_ids:
            continue
        material_id = material_key_for_content(content_node.id) or getattr(content_node, "source_file", None) or "未分类资料"
        material_title, chapter_title = curriculum_context_for_content(content_node.id)
        visual_id = str(content_node.id)
        visual_id_by_content[content_node.id] = visual_id
        status, mastery = _status_from_learning_progress(progress_by_content.get(content_node.id))
        nodes.append(
            {
                "id": visual_id,
                "label": _concept_display_label(content_node.title),
                "type": "curriculum_content",
                "level": max(1, min(6, content_node.level or 1)),
                "size": max(8, min(24, int(10 + mastery * 14))),
                "color": _color_from_status(status),
                "status": status,
                "mastery": round(mastery, 3),
                "gap_type": None,
                "content_node_id": str(content_node.id),
                "material_id": material_id,
                "material_title": material_title,
                "chapter_title": chapter_title,
                "material_order": material_order.get(material_id, len(material_order)),
                "curriculum_order": curriculum_order_by_content[content_node.id],
            }
        )

    edges: list[dict[str, Any]] = []
    for raw in raw_edges:
        source = raw.get("source")
        target = raw.get("target")
        if source is None or target is None:
            continue
        edges.append(
            {
                "source": str(source),
                "target": str(target),
                "type": str(raw.get("type") or "related"),
            }
        )

    # Preserve source-backed context only. `contains` is a real hierarchy;
    # `curriculum_sequence` means printed learning order, explicitly *not* a
    # prerequisite. This connects every fallback unit without inventing
    # cognitive dependencies where the uploaded material has not established
    # them yet.
    existing_edges = {(edge["source"], edge["target"], edge["type"]) for edge in edges}
    for content_node in ordered_learnable_nodes:
        if content_node.parent_id is None:
            continue
        source = visual_id_by_content.get(content_node.parent_id)
        target = visual_id_by_content.get(content_node.id)
        if source is None or target is None or source == target:
            continue
        key = (source, target, "contains")
        if key not in existing_edges:
            edges.append({"source": source, "target": target, "type": "contains"})
            existing_edges.add(key)

    prior_by_material: dict[str, str] = {}
    for content_node in ordered_learnable_nodes:
        material_id = material_key_for_content(content_node.id) or getattr(content_node, "source_file", None) or "未分类资料"
        target = visual_id_by_content.get(content_node.id)
        source = prior_by_material.get(material_id)
        if source and target and source != target:
            key = (source, target, "curriculum_sequence")
            if key not in existing_edges:
                edges.append({"source": source, "target": target, "type": "curriculum_sequence"})
                existing_edges.add(key)
        if target:
            prior_by_material[material_id] = target

    edges = _normalize_relationship_edges(edges)

    return {
        "course_id": str(course_id),
        "nodes": nodes,
        "edges": edges,
        "coverage": {
            "learnable_content_count": len(ordered_learnable_nodes),
            "represented_content_count": len({node.get("content_node_id") for node in nodes if node.get("content_node_id")}),
            "material_count": len(material_order),
        },
    }
