"""Maintain the textbook-first index around existing practice problems."""

from __future__ import annotations

import hashlib
import re
import uuid
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.content import CourseContentTree
from models.knowledge_graph import KnowledgeNode
from models.practice import PracticeProblem
from models.question_catalog import (
    AbilityTag,
    CurriculumChapter,
    CurriculumKnowledgePoint,
    CurriculumTextbook,
    QuestionAbilityTagLink,
    QuestionCatalogEntry,
    QuestionKnowledgePointLink,
)


def infer_textbook_metadata(source_name: str) -> dict[str, str | None]:
    """Extract only stable curriculum labels from an uploaded filename/title."""
    text = str(source_name or "").strip()
    publisher = next((name for name in ("人教版", "北师大版", "苏教版") if name in text), "未识别版本")
    subject = next((name for name in ("数学", "语文", "英语", "物理", "化学", "生物", "历史", "地理", "政治") if name in text), None)
    grade_match = re.search(r"([七八九一二三四五六]|[1-9])年级", text)
    grade = f"{grade_match.group(1)}年级" if grade_match else None
    semester = "上册" if "上册" in text else "下册" if "下册" in text else None
    return {
        "publisher": publisher,
        "edition": publisher if publisher != "未识别版本" else None,
        "subject": subject,
        "grade": grade,
        "semester": semester,
    }


def _ability_code(name: str) -> str:
    ascii_name = re.sub(r"[^a-z0-9]+", "-", name.casefold()).strip("-")
    if ascii_name:
        return ascii_name[:100]
    return f"ability-{hashlib.sha1(name.encode('utf-8')).hexdigest()[:16]}"


def _answer_spec(problem: PracticeProblem) -> dict[str, str]:
    question_type = problem.question_type or "short_answer"
    grading_mode = {
        "mc": "option_label_or_option_text",
        "tf": "boolean_synonym",
        "fill_blank": "ordered_blank_semantics",
        "short_answer": "deterministic_then_semantic",
        "free_response": "deterministic_then_semantic",
    }.get(question_type, "deterministic")
    return {
        "question_type": question_type,
        "grading_mode": grading_mode,
        "canonical_answer": str(problem.correct_answer or ""),
    }


async def ensure_textbook_catalog(
    db: AsyncSession,
    *,
    course_id: uuid.UUID,
    nodes: Iterable[CourseContentTree],
) -> dict[uuid.UUID, CurriculumChapter]:
    """Mirror the uploaded course tree into textbook and chapter catalog rows."""
    node_list = list(nodes)
    if not node_list:
        return {}

    textbooks: dict[str, CurriculumTextbook] = {}
    for source_file in sorted({str(node.source_file or "").strip() for node in node_list if node.source_file}):
        existing = await db.execute(
            select(CurriculumTextbook).where(
                CurriculumTextbook.course_id == course_id,
                CurriculumTextbook.source_file == source_file,
            )
        )
        textbook = existing.scalar_one_or_none()
        if textbook is None:
            details = infer_textbook_metadata(source_file)
            textbook = CurriculumTextbook(
                course_id=course_id,
                title=source_file,
                source_file=source_file,
                publisher=details["publisher"] or "未识别版本",
                edition=details["edition"],
                subject=details["subject"],
                grade=details["grade"],
                semester=details["semester"],
                copyright_notice="来源于用户上传教材，仅用于该学习空间内的学习与练习。",
                metadata_={"catalog_source": "uploaded_material"},
            )
            db.add(textbook)
            await db.flush()
        textbooks[source_file] = textbook

    if not textbooks:
        return {}

    existing_result = await db.execute(
        select(CurriculumChapter).where(
            CurriculumChapter.content_node_id.in_([node.id for node in node_list])
        )
    )
    chapters_by_node = {row.content_node_id: row for row in existing_result.scalars() if row.content_node_id}

    # Parent nodes always precede descendants in the parsed content tree. The
    # fallback sort also makes this safe for imported/legacy trees.
    for node in sorted(node_list, key=lambda item: (item.level, item.order_index)):
        if node.id in chapters_by_node:
            continue
        source_file = str(node.source_file or "").strip()
        textbook = textbooks.get(source_file)
        if textbook is None:
            continue
        parent = chapters_by_node.get(node.parent_id)
        chapter = CurriculumChapter(
            textbook_id=textbook.id,
            parent_id=parent.id if parent and parent.textbook_id == textbook.id else None,
            content_node_id=node.id,
            code=f"node-{node.id}",
            title=node.title,
            level=node.level,
            sort_order=node.order_index,
        )
        db.add(chapter)
        chapters_by_node[node.id] = chapter
    await db.flush()
    return chapters_by_node


async def catalog_practice_problem(
    db: AsyncSession,
    *,
    problem: PracticeProblem,
    course_id: uuid.UUID,
) -> QuestionCatalogEntry:
    """Attach one practice problem to textbook, concept and ability dimensions."""
    existing = await db.execute(
        select(QuestionCatalogEntry).where(QuestionCatalogEntry.problem_id == problem.id)
    )
    entry = existing.scalar_one_or_none()

    chapter = None
    if problem.content_node_id:
        chapter_result = await db.execute(
            select(CurriculumChapter).where(CurriculumChapter.content_node_id == problem.content_node_id)
        )
        chapter = chapter_result.scalar_one_or_none()

    if entry is None:
        entry = QuestionCatalogEntry(
            problem_id=problem.id,
            textbook_id=chapter.textbook_id if chapter else None,
            chapter_id=chapter.id if chapter else None,
            question_type=problem.question_type,
            difficulty=problem.difficulty_layer or 2,
            source_type=problem.source or "legacy_course_content",
            source_reference=chapter.title if chapter else None,
            answer_spec=_answer_spec(problem),
        )
        db.add(entry)
        await db.flush()
    else:
        entry.question_type = problem.question_type
        entry.difficulty = problem.difficulty_layer or entry.difficulty or 2
        entry.answer_spec = _answer_spec(problem)
        if chapter:
            entry.textbook_id = chapter.textbook_id
            entry.chapter_id = chapter.id

    metadata = problem.problem_metadata or {}
    textbook = None
    if entry.textbook_id:
        textbook_result = await db.execute(
            select(CurriculumTextbook).where(CurriculumTextbook.id == entry.textbook_id)
        )
        textbook = textbook_result.scalar_one_or_none()
    if textbook:
        entry.source_reference = textbook.source_file
        entry.copyright_notice = textbook.copyright_notice
        entry.license = textbook.license
    traps = metadata.get("potential_traps")
    if isinstance(traps, list):
        entry.common_mistake = "；".join(str(item).strip() for item in traps if str(item).strip()) or None
    else:
        entry.common_mistake = str(metadata.get("common_mistake") or "").strip() or None
    steps = metadata.get("solution_steps")
    if isinstance(steps, list):
        entry.solution_method = "\n".join(str(item).strip() for item in steps if str(item).strip()) or None
    else:
        entry.solution_method = str(metadata.get("method_summary") or "").strip() or None
    concept_names = list(problem.knowledge_points or [])
    core_concept = str(metadata.get("core_concept") or "").strip()
    if core_concept and core_concept not in concept_names:
        concept_names.append(core_concept)

    for name in dict.fromkeys(str(item).strip() for item in concept_names if str(item).strip()):
        if not entry.textbook_id:
            continue
        kp_result = await db.execute(
            select(CurriculumKnowledgePoint).where(
                CurriculumKnowledgePoint.textbook_id == entry.textbook_id,
                CurriculumKnowledgePoint.name == name,
            )
        )
        knowledge_point = kp_result.scalar_one_or_none()
        if knowledge_point is None:
            graph_result = await db.execute(
                select(KnowledgeNode).where(
                    KnowledgeNode.course_id == course_id,
                    KnowledgeNode.name == name,
                )
            )
            graph_node = graph_result.scalar_one_or_none()
            knowledge_point = CurriculumKnowledgePoint(
                textbook_id=entry.textbook_id,
                chapter_id=entry.chapter_id,
                knowledge_node_id=graph_node.id if graph_node else None,
                name=name,
                description=graph_node.description if graph_node else None,
            )
            db.add(knowledge_point)
            await db.flush()
        linked = await db.execute(
            select(QuestionKnowledgePointLink).where(
                QuestionKnowledgePointLink.question_entry_id == entry.id,
                QuestionKnowledgePointLink.knowledge_point_id == knowledge_point.id,
            )
        )
        if linked.scalar_one_or_none() is None:
            db.add(QuestionKnowledgePointLink(question_entry_id=entry.id, knowledge_point_id=knowledge_point.id))

    ability_names = [
        str(metadata.get("skill_focus") or "").strip(),
        str(metadata.get("bloom_level") or "").strip(),
    ]
    for name in dict.fromkeys(item for item in ability_names if item):
        code = _ability_code(name)
        tag_result = await db.execute(select(AbilityTag).where(AbilityTag.code == code))
        tag = tag_result.scalar_one_or_none()
        if tag is None:
            tag = AbilityTag(code=code, name=name, category="学习能力")
            db.add(tag)
            await db.flush()
        linked = await db.execute(
            select(QuestionAbilityTagLink).where(
                QuestionAbilityTagLink.question_entry_id == entry.id,
                QuestionAbilityTagLink.ability_tag_id == tag.id,
            )
        )
        if linked.scalar_one_or_none() is None:
            db.add(QuestionAbilityTagLink(question_entry_id=entry.id, ability_tag_id=tag.id))
    return entry


async def backfill_question_catalog(db: AsyncSession) -> int:
    """Index existing uploads/questions once without changing their behavior."""
    node_result = await db.execute(select(CourseContentTree))
    nodes = list(node_result.scalars().all())
    nodes_by_course: dict[uuid.UUID, list[CourseContentTree]] = {}
    for node in nodes:
        nodes_by_course.setdefault(node.course_id, []).append(node)
    for course_id, course_nodes in nodes_by_course.items():
        await ensure_textbook_catalog(db, course_id=course_id, nodes=course_nodes)

    problem_result = await db.execute(select(PracticeProblem))
    problems = list(problem_result.scalars().all())
    created = 0
    for problem in problems:
        prior = await db.execute(select(QuestionCatalogEntry.id).where(QuestionCatalogEntry.problem_id == problem.id))
        if prior.scalar_one_or_none() is None:
            created += 1
        await catalog_practice_problem(db, problem=problem, course_id=problem.course_id)
    if problems:
        await db.commit()
    return created
