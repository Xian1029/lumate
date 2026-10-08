"""Deep-link construction for learning actions.

One module owns the mapping from a structured learning action (task type +
course + content node) to an executable in-app route.  Recommendations and
navigation must always come from the *same* object — the helpers here are
that single source.

Fallback rule (capability validation): a link is only as deep as the data
that actually exists.  A missing/deleted content node degrades to the course
overview, never to a 404.
"""

from __future__ import annotations

import uuid

# Learning task types (models.learning_task.LearningTask.task_type) mapped to
# the workspace module that can execute them.  Routes follow the existing
# Next.js app-router structure; no new route style is introduced.
TASK_TYPE_TO_MODULE: dict[str, str] = {
    "LEARN": "CONTENT",
    "PRACTICE": "PRACTICE",
    "FLASHCARD": "FLASHCARD",
    "REVIEW": "REVIEW",
    "REFLECTION": "CONTENT",
    "ASSESSMENT": "MASTERY_CHECK",
    "NOTE": "NOTE",
}

MODULE_CTA_LABELS: dict[str, str] = {
    "CONTENT": "继续学习",
    "NOTE": "开始整理笔记",
    "PRACTICE": "开始练习",
    "REVIEW": "开始复习",
    "MASTERY_CHECK": "开始检测",
    "FLASHCARD": "开始记忆复习",
    "AI_TUTOR": "和AI导师聊一聊",
    "FEYNMAN": "开始费曼讲解",
}


def module_for_task_type(task_type: str | None) -> str:
    return TASK_TYPE_TO_MODULE.get((task_type or "").upper(), "CONTENT")


def cta_label_for_module(module: str) -> str:
    return MODULE_CTA_LABELS.get(module, "继续学习")


def build_action_href(
    *,
    task_type: str | None,
    course_id: uuid.UUID | str,
    content_node_id: uuid.UUID | str | None,
    node_exists: bool,
) -> str:
    """Resolve the deepest *executable* route for a learning action.

    ``node_exists`` is the capability check: callers must verify the content
    node is still present (batch query) so a stale task never deep-links into
    a deleted unit.
    """
    cid = str(course_id)
    node = str(content_node_id) if content_node_id and node_exists else None
    module = module_for_task_type(task_type)

    # Plan execution always enters the course workspace, not a separate
    # feature route.  The workspace already owns selected-node/module state,
    # so this gives every course the same stable deep-link contract.
    params = f"?module={module}"
    if node:
        params = f"?node={node}&module={module}"
    return f"/course/{cid}{params}"


def build_resume_href(
    *,
    course_id: uuid.UUID | str,
    content_node_id: uuid.UUID | str | None,
    node_exists: bool,
    target_module: str | None = None,
) -> str:
    """Deep link for "resume last learning" — unit workspace when the last
    studied node still exists, course overview otherwise (never a 404)."""
    cid = str(course_id)
    node = str(content_node_id) if content_node_id and node_exists else None
    module = (target_module or "CONTENT").upper()
    if module == "NOTE":
        return f"/course/{cid}/notes?node={node}" if node else f"/course/{cid}/notes"
    if module in {"PRACTICE", "MASTERY_CHECK"}:
        return f"/course/{cid}/practice?tab=quiz&node={node}" if node else f"/course/{cid}/practice?tab=quiz"
    if module == "FLASHCARD":
        return f"/course/{cid}/practice?tab=flashcards&node={node}" if node else f"/course/{cid}/practice?tab=flashcards"
    if module == "REVIEW":
        return f"/course/{cid}/review"
    if module == "GRAPH":
        return f"/course/{cid}/graph" + (f"?node={node}" if node else "")
    if node:
        return f"/course/{cid}/unit/{node}"
    return f"/course/{cid}"
