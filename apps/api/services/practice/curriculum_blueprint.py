"""Build the curriculum/knowledge-graph blueprint used for quiz generation."""

from __future__ import annotations

import uuid

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.knowledge_graph import KnowledgeEdge, KnowledgeNode


async def build_question_blueprint(
    db: AsyncSession,
    *,
    course_id: uuid.UUID,
    content_node_id: uuid.UUID,
) -> str | None:
    """Return a compact, textbook-scoped concept graph for one section.

    The graph is authoritative for question scope when available.  Missing
    graph data is represented by ``None`` so ingestion can still fall back to
    the learner-visible note instead of blocking practice.
    """
    result = await db.execute(
        select(KnowledgeNode).where(
            KnowledgeNode.course_id == course_id,
            KnowledgeNode.content_node_id == content_node_id,
        )
    )
    nodes = list(result.scalars().all())
    if not nodes:
        return None

    node_ids = [node.id for node in nodes]
    edge_result = await db.execute(
        select(KnowledgeEdge).where(
            or_(KnowledgeEdge.source_id.in_(node_ids), KnowledgeEdge.target_id.in_(node_ids))
        )
    )
    edges = list(edge_result.scalars().all())
    related_ids = {
        endpoint
        for edge in edges
        for endpoint in (edge.source_id, edge.target_id)
    }
    names = {node.id: node.name for node in nodes}
    if related_ids - set(names):
        related_result = await db.execute(
            select(KnowledgeNode).where(KnowledgeNode.id.in_(related_ids - set(names)))
        )
        names.update({node.id: node.name for node in related_result.scalars().all()})

    lines = ["Authoritative knowledge anchors for this textbook section:"]
    for node in nodes:
        metadata = node.metadata_ or {}
        bloom = metadata.get("bloom_label") or metadata.get("bloom_level") or "understand"
        description = (node.description or "").strip()
        lines.append(f"- {node.name} | target cognition: {bloom} | {description}")
    if edges:
        lines.append("Knowledge relations:")
        for edge in edges:
            source = names.get(edge.source_id)
            target = names.get(edge.target_id)
            if source and target:
                lines.append(f"- {source} --{edge.relation_type}--> {target}")
    return "\n".join(lines)
