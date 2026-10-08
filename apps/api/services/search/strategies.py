"""Individual search strategies: keyword, vector, and tree search.

Each strategy retrieves candidates independently; they are combined
by the RRF fusion layer in ``fusion.py``.
"""

import json
import logging
import uuid

from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from models.content import CourseContentTree
from services.content_text import clean_course_title, normalize_pdf_markdown
from services.search.compat import cosine_similarity
from services.search.scoring import _tokenize_query, decompose_search_query

logger = logging.getLogger(__name__)


def _presentable_text(value: str | None) -> str:
    """Keep legacy PDF extraction artefacts out of RAG prompts and evidence."""
    return normalize_pdf_markdown(value) or ""


def _search_result(node: CourseContentTree, score: float, source: str, title: str | None = None) -> dict:
    return {
        "id": str(node.id),
        "title": clean_course_title(title if title is not None else node.title),
        "content": _presentable_text(node.content)[:1500],
        "level": node.level,
        "parent_id": str(node.parent_id) if node.parent_id else None,
        "source_file": node.source_file,
        "score": score,
        "source": source,
    }


async def keyword_search(
    db: AsyncSession,
    course_id: uuid.UUID,
    query: str,
    limit: int = 10,
) -> list[dict]:
    """Keyword search using LIKE-based term matching."""
    terms = _tokenize_query(query)
    for facet in decompose_search_query(query):
        for token in _tokenize_query(facet):
            if token not in terms:
                terms.append(token)
    if not terms:
        return []

    conditions = [
        or_(
            CourseContentTree.title.ilike(f"%{t}%"),
            CourseContentTree.content.ilike(f"%{t}%"),
        )
        for t in terms[:6]
    ]

    result = await db.execute(
        select(CourseContentTree)
        .where(CourseContentTree.course_id == course_id, or_(*conditions))
        .limit(limit * 2)
    )
    nodes = result.scalars().all()

    scored = []
    for node in nodes:
        content_lower = _presentable_text(node.content).lower()
        title_lower = clean_course_title(node.title).lower()
        hit_count = sum(
            1 for t in terms
            if t.lower() in content_lower or t.lower() in title_lower
        )
        level_boost = max(0.5, 1.0 - node.level * 0.1)
        scored.append(_search_result(node, hit_count * level_boost, "keyword"))

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:limit]


async def vector_search(
    db: AsyncSession,
    course_id: uuid.UUID,
    query: str,
    limit: int = 10,
) -> list[dict]:
    """Cosine similarity search on content tree embeddings."""
    try:
        from services.embedding.registry import get_embedding_provider, is_noop_provider
        if is_noop_provider():
            return []  # Embeddings disabled; fall back to keyword search
        provider = get_embedding_provider()
        query_embedding = await provider.embed(query)
    except (ImportError, ConnectionError, TimeoutError, RuntimeError, ValueError) as e:
        logger.warning("Embedding unavailable for vector search: %s", e, exc_info=True)
        return []

    result = await db.execute(
        select(CourseContentTree)
        .where(
            CourseContentTree.course_id == course_id,
            CourseContentTree.embedding.isnot(None),
        )
    )
    nodes = result.scalars().all()
    if not nodes:
        return []

    scored = []
    for n in nodes:
        emb = n.embedding
        if isinstance(emb, str):
            try:
                emb = json.loads(emb)
            except (ValueError, TypeError):
                continue
        if not emb:
            continue
        sim = cosine_similarity(query_embedding, emb)
        scored.append((n, sim))
    scored.sort(key=lambda x: x[1], reverse=True)

    return [
        _search_result(n, sim, "vector")
        for n, sim in scored[:limit]
    ]


async def tree_search(
    db: AsyncSession,
    course_id: uuid.UUID,
    query: str,
    limit: int = 5,
) -> list[dict]:
    """PageIndex-style tree reasoning search.

    Phase 1: Navigate the content tree hierarchically.
    Start from root nodes, check if query relates to each chapter,
    then drill down into matching subtrees.
    """
    # Get top-level nodes (chapters)
    result = await db.execute(
        select(CourseContentTree)
        .where(
            CourseContentTree.course_id == course_id,
            CourseContentTree.level <= 1,
        )
        .order_by(CourseContentTree.order_index)
    )
    chapters = result.scalars().all()

    if not chapters:
        return []

    # Simple relevance check: does the query relate to this chapter?
    query_terms = _tokenize_query(query)
    relevant_chapters = []
    for ch in chapters:
        title_lower = clean_course_title(ch.title).lower()
        content_lower = _presentable_text(ch.content)[:500].lower()
        if any(term in title_lower or term in content_lower for term in query_terms):
            relevant_chapters.append(ch)

    if not relevant_chapters:
        relevant_chapters = chapters[:3]  # Fallback to first 3 chapters

    # Drill into relevant chapters for leaf content
    results = []
    for chapter in relevant_chapters[:3]:
        child_result = await db.execute(
            select(CourseContentTree)
            .where(
                CourseContentTree.course_id == course_id,
                CourseContentTree.parent_id == chapter.id,
            )
            .order_by(CourseContentTree.order_index)
        )
        children = child_result.scalars().all()

        # Score children by query relevance
        for child in children:
            content_lower = _presentable_text(child.content).lower()
            hit_count = sum(
                1 for t in query_terms
                if t in content_lower or t in (child.title or "").lower()
            )
            if hit_count > 0 or len(children) <= 3:
                results.append(_search_result(
                    child,
                    hit_count + 0.5,
                    "tree",
                    f"{clean_course_title(chapter.title)} > {clean_course_title(child.title)}",
                ))

    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:limit]
