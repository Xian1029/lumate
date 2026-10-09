"""Step 6: Dispatch extracted content to appropriate business tables.

Routes classified content into content_tree, assignments, or exam records,
then triggers deadline extraction and auto-generation of learning content.
"""

import logging

import sqlalchemy as sa
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from models.ingestion import IngestionJob, Assignment

logger = logging.getLogger(__name__)


async def dispatch_content(db: AsyncSession, job: IngestionJob) -> dict:
    """Step 6: Dispatch extracted content to appropriate business tables."""
    result = {}

    if not job.course_id or not job.extracted_markdown:
        return result

    category = job.content_category or "other"
    source_name = (job.original_filename or "").lower()
    inferred_text_source = (
        source_name.endswith((".md", ".txt", ".rst", ".html", ".htm"))
        or (job.mime_type or "").startswith("text/")
        or job.source_type == "url"
    )

    if category in ("lecture_slides", "textbook", "notes", "syllabus") or (
        category == "other" and inferred_text_source
    ):
        # Build content tree using PageIndex pattern
        from services.parser.pdf import _markdown_to_tree
        from services.content_text import normalize_pdf_markdown
        from models.content import CourseContentTree
        source_label = job.original_filename or job.url or "Untitled"

        # Dedup: remove existing content tree nodes from the same source
        # before inserting new ones (prevents duplicates on re-ingestion)
        existing = await db.execute(
            select(CourseContentTree.id).where(
                CourseContentTree.course_id == job.course_id,
                CourseContentTree.source_file == source_label,
            )
        )
        old_ids = existing.scalars().all()
        if old_ids:
            from models.practice import PracticeProblem
            from sqlalchemy import delete as sa_delete

            # 1. Nullify FK references from practice_problems
            await db.execute(
                PracticeProblem.__table__.update()
                .where(PracticeProblem.content_node_id.in_(old_ids))
                .values(content_node_id=None)
            )
            # 2. Break self-referential parent_id chain (NO ACTION on delete):
            #    a) NULL out parent_id of the nodes being deleted
            await db.execute(
                CourseContentTree.__table__.update()
                .where(CourseContentTree.id.in_(old_ids))
                .values(parent_id=None)
            )
            #    b) NULL out parent_id of any OTHER node whose parent is being deleted
            await db.execute(
                CourseContentTree.__table__.update()
                .where(CourseContentTree.parent_id.in_(old_ids))
                .values(parent_id=None)
            )
            # 3. Bulk delete — all FK chains are now clear
            await db.execute(
                sa_delete(CourseContentTree).where(
                    CourseContentTree.id.in_(old_ids)
                )
            )
            await db.flush()
            logger.info("Dedup: removed %d existing nodes for source %s", len(old_ids), source_label)

        # PPT files: split per slide for precise search
        is_pptx = source_name.endswith((".pptx", ".ppt"))
        if is_pptx:
            import uuid as _uuid
            full_content = job.extracted_markdown.strip()
            slide_separator = "\n\n---\n\n"
            slide_chunks = [s.strip() for s in full_content.split(slide_separator) if s.strip()]

            root_summary = full_content[:500] + "..." if len(full_content) > 500 else full_content
            root = CourseContentTree(
                id=_uuid.uuid4(),
                course_id=job.course_id,
                parent_id=None,
                title=job.original_filename or "Presentation",
                level=0,
                order_index=0,
                content=root_summary,
                source_file=source_label,
                source_type=job.source_type,
            )
            nodes = [root]

            for i, slide_content in enumerate(slide_chunks):
                lines = slide_content.split("\n")
                title = lines[0].lstrip("#").strip() if lines else f"Slide {i + 1}"
                if not title or len(title) > 100:
                    title = f"Slide {i + 1}"
                child = CourseContentTree(
                    id=_uuid.uuid4(),
                    course_id=job.course_id,
                    parent_id=root.id,
                    title=title,
                    level=1,
                    order_index=i,
                    content=slide_content,
                    source_file=source_label,
                    source_type=job.source_type,
                )
                nodes.append(child)
            logger.info("PPT split into %d slide nodes for %s", len(slide_chunks), source_label)
        else:
            nodes = _markdown_to_tree(
                # Defensive second boundary: older extractors and imported
                # jobs cannot bypass the Markdown-safe text contract.
                markdown=normalize_pdf_markdown(job.extracted_markdown) or "",
                course_id=job.course_id,
                source_file=source_label,
            )
        outline_report = (job.page_stats or {}).get("outline_integrity", {})
        structure_source = "SOURCE_TOC" if outline_report.get("checked") else "GENERATED_FROM_CONTENT"
        # SQLite otherwise checks self-referential FKs at each statement,
        # while PostgreSQL handles this through its normal transaction rules.
        # Deferring the local constraint lets the complete tree and its
        # catalog mirror be written in one consistent transaction.
        if db.bind is not None and db.bind.dialect.name == "sqlite":
            await db.execute(sa.text("PRAGMA defer_foreign_keys = ON"))
        # SQLite enforces the self-referential parent FK immediately. Flush
        # each tree level before inserting its children instead of relying on
        # SQLAlchemy's batch ordering, which can vary for large textbook
        # uploads and otherwise leaves valid chapters looking like a failed
        # PDF parse.
        ordered_nodes = sorted(nodes, key=lambda item: (item.level, item.order_index))
        node_ids = {node.id for node in ordered_nodes}
        original_parents = {node.id: node.parent_id for node in ordered_nodes}
        # Insert the complete node set without parent references first. This
        # avoids SQLite's immediate self-FK check even when SQLAlchemy groups
        # a large textbook into an INSERT batch in an unexpected order.
        for node in ordered_nodes:
            node.source_type = job.source_type
            node.source_file = source_label
            node.content_category = node.content_category or category
            if node.parent_id is None:
                node.metadata_ = {**(node.metadata_ or {}), "structureSource": structure_source}
            node.parent_id = None
            db.add(node)
        await db.flush()
        # A large textbook can contain malformed/legacy references that are
        # present in the parsed payload but were not actually persisted (for
        # example when a duplicate id is discarded by the identity map).  Do
        # not issue an FK update against a parent that is not in the database:
        # one bad edge must never make the whole PDF upload fail.  Nodes whose
        # parent is missing remain valid root nodes and are still searchable.
        persisted_result = await db.execute(
            select(CourseContentTree.id).where(
                CourseContentTree.id.in_(node_ids)
            )
        )
        persisted_ids = set(persisted_result.scalars().all())
        missing_ids = node_ids - persisted_ids
        if missing_ids:
            logger.warning(
                "Tree persistence skipped %d node ids for %s; preserving upload with safe roots",
                len(missing_ids),
                source_label,
            )
        # Restore only parent references that point to a node in this upload;
        # malformed legacy references are safely treated as roots.
        for node in ordered_nodes:
            parent_id = original_parents.get(node.id)
            parent_id = (
                parent_id
                if node.id in persisted_ids and parent_id in persisted_ids
                else None
            )
            if parent_id is not None:
                # Use a Core UPDATE for the second phase. Mutating all ORM
                # instances after the first flush can produce stale-row
                # updates under SQLite's async driver when a large batch is
                # still being reconciled by the identity map.
                await db.execute(
                    sa.update(CourseContentTree)
                    .where(CourseContentTree.id == node.id)
                    .values(parent_id=parent_id)
                )
            set_committed_value(node, "parent_id", parent_id)

        # Preserve the existing course tree as the learning-space source of
        # truth, then mirror it into the textbook-first catalog for question
        # provenance and cross-chapter retrieval.
        from services.question_catalog import ensure_textbook_catalog
        await ensure_textbook_catalog(db, course_id=job.course_id, nodes=nodes)

        result["content_tree"] = len(nodes)

        # Generation is intentionally not started here. The upload processor
        # runs the canonical pipeline after commit: section notes first, then
        # flashcards and quizzes derived from those notes. Starting a second
        # raw-PDF generation task here caused unrelated and duplicate questions.

    elif category == "assignment":
        # Extract assignment info
        from services.ingestion.content_trimmer import trim_for_llm

        assignment = Assignment(
            course_id=job.course_id,
            title=job.original_filename or "Assignment",
            description=trim_for_llm(job.extracted_markdown, max_tokens=2000) if job.extracted_markdown else None,
            assignment_type="homework",
            source_ingestion_id=job.id,
        )
        db.add(assignment)
        result["assignments"] = 1

    elif category == "exam_schedule":
        from services.ingestion.content_trimmer import trim_for_llm

        assignment = Assignment(
            course_id=job.course_id,
            title=job.original_filename or "Exam",
            description=trim_for_llm(job.extracted_markdown, max_tokens=2000) if job.extracted_markdown else None,
            assignment_type="exam",
            source_ingestion_id=job.id,
        )
        db.add(assignment)
        result["assignments"] = 1

    # ── Cold-start layout (first document only) ──
    try:
        from models.course import Course
        from services.block_decision.cold_start import compute_cold_start_layout

        course_result = await db.execute(
            select(Course).where(Course.id == job.course_id)
        )
        course = course_result.scalar_one_or_none()
        if course:
            existing_meta = course.metadata_ or {}
            if not existing_meta.get("spaceLayout"):
                # Count LOOM concepts if available
                loom_count = 0
                try:
                    from models.progress import LearningProgress
                    count_result = await db.execute(
                        sa.select(sa.func.count(LearningProgress.id)).where(
                            LearningProgress.course_id == job.course_id
                        )
                    )
                    loom_count = count_result.scalar() or 0
                except (sa.exc.SQLAlchemyError, ImportError) as exc:
                    logger.debug("Could not count LOOM nodes for layout: %s", exc)
                cold_layout = compute_cold_start_layout(category, loom_count)
                course.metadata_ = {**existing_meta, "spaceLayout": cold_layout}
                result["cold_start_layout"] = True
    except (sa.exc.SQLAlchemyError, ImportError, ValueError) as e:
        logger.debug("Cold-start layout skipped: %s", e)

    # ── Automatic deadline extraction (all categories) ──
    if job.course_id and job.extracted_markdown:
        try:
            from services.ingestion.deadline_extractor import extract_and_create_deadlines
            canvas_assignments = getattr(job, "_canvas_assignments_data", None)
            deadline_count = await extract_and_create_deadlines(
                db=db,
                course_id=job.course_id,
                content=job.extracted_markdown,
                source_ingestion_id=job.id,
                canvas_assignments=canvas_assignments,
            )
            if deadline_count:
                result["deadlines_extracted"] = deadline_count
        except (sa.exc.SQLAlchemyError, ValueError, KeyError) as e:
            logger.warning("Deadline extraction failed (non-blocking): %s", e)
        except (RuntimeError, ConnectionError, TimeoutError) as e:
            logger.exception("Deadline extraction unexpected error (non-blocking)")

    return result
