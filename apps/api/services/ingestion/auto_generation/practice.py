"""Auto-generation of flashcards, quiz questions, and learning content."""

import logging
import uuid

import sqlalchemy as sa
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def auto_generate_flashcards(
    db_factory,
    course_id: uuid.UUID,
    user_id: uuid.UUID,
    count: int = 10,
) -> int:
    """Auto-generate flashcards for a course after ingestion.

    Dedup guard: skips if the course already has active flashcard assets.
    """
    from services.generated_assets import save_generated_asset, list_generated_asset_batches

    async with db_factory() as db:
        # Dedup guard -- skip if flashcards already exist for this course
        existing = await list_generated_asset_batches(
            db, user_id=user_id, course_id=course_id, asset_type="flashcards",
        )
        if existing:
            logger.info("Skipping auto-flashcards: %d batches already exist for course %s", len(existing), course_id)
            return 0

        try:
            from services.spaced_repetition.flashcards import generate_flashcards
            cards = await generate_flashcards(db, course_id, None, count, user_id=user_id)
            if not cards:
                return 0

            await save_generated_asset(
                db,
                user_id=user_id,
                course_id=course_id,
                asset_type="flashcards",
                title="Auto-generated starter set",
                content={"cards": cards},
                metadata={"count": len(cards), "auto_generated": True},
            )
            await db.commit()
            logger.info("Auto-generated %d flashcards for course %s", len(cards), course_id)
            return len(cards)
        except (ConnectionError, TimeoutError) as e:
            logger.warning("Auto flashcard generation network error for course %s: %s", course_id, e)
            return 0
        except (ValueError, RuntimeError, sa.exc.SQLAlchemyError, OSError) as exc:
            logger.exception("Auto flashcard generation failed for course %s", course_id)
            return 0


async def auto_generate_quiz(
    db_factory,
    course_id: uuid.UUID,
    user_id: uuid.UUID,
    question_count: int = 6,
) -> int:
    """Auto-generate quiz questions for a course after ingestion.

    Dedup guard: skips if the course already has enough starter questions.
    """
    from models.content import CourseContentTree
    from models.practice import PracticeProblem
    from services.content_text import is_assessment_content
    from services.parser.quiz import MAX_GENERATED_QUESTIONS

    # This background path is still one generation event. Do not let a caller
    # turn initial course preparation into an overwhelming question dump.
    question_count = min(max(1, question_count), MAX_GENERATED_QUESTIONS)

    async with db_factory() as db:
        # Dedup guard -- skip if enough quiz questions already exist
        from sqlalchemy import func as sa_func
        existing_count = (await db.execute(
            select(sa_func.count()).select_from(PracticeProblem).where(
                PracticeProblem.course_id == course_id,
                PracticeProblem.is_archived == False,  # noqa: E712
            )
        )).scalar() or 0
        if existing_count >= question_count:
            logger.info("Skipping auto-quiz: %d questions already exist for course %s", existing_count, course_id)
            return 0

        try:
            from services.parser.quiz import extract_questions

            # Only use knowledge content for quiz generation, skip syllabus/info
            result = await db.execute(
                select(CourseContentTree).where(
                    CourseContentTree.course_id == course_id,
                    CourseContentTree.content.isnot(None),
                )
            )
            nodes = result.scalars().all()
            from services.generated_assets import get_active_note_markdown_by_node
            note_by_node = await get_active_note_markdown_by_node(
                db, user_id=user_id, course_id=course_id,
            )

            problems: list[PracticeProblem] = []
            for node in nodes:
                if is_assessment_content(
                    node.title, node.content, content_category=node.content_category, level=node.level,
                ):
                    note = note_by_node.get(str(node.id))
                    if not note:
                        continue
                    outcome = await extract_questions(note, node.title, course_id, node.id)
                    # ``extract_questions`` returns a structured outcome so
                    # callers can report discarded/repaired questions.  The
                    # old list contract survived here and made successful
                    # workspace preparation fail with "object is not
                    # iterable" after a textbook had already been parsed.
                    problems.extend(outcome.problems)
                    if len(problems) >= question_count:
                        break

            added = 0
            for p in problems[:question_count]:
                db.add(p)
                added += 1
            await db.commit()
            logger.info("Auto-generated %d quiz questions for course %s", added, course_id)
            return added
        except (ConnectionError, TimeoutError) as e:
            logger.warning("Auto quiz generation network error for course %s: %s", course_id, e)
            return 0
        except (ValueError, RuntimeError, sa.exc.SQLAlchemyError, OSError) as exc:
            logger.exception("Auto quiz generation failed for course %s", course_id)
            return 0


async def _auto_generate_learning_content(
    db: AsyncSession,
    course_id: uuid.UUID,
    user_id: uuid.UUID,
    nodes: list,
) -> None:
    """Auto-generate practice problems and flashcards for newly ingested content nodes.

    Runs as a fire-and-forget task after content tree creation.
    Only processes nodes with >300 chars of content.
    """
    from services.content_text import is_assessment_content
    eligible = [
        n for n in nodes
        if is_assessment_content(
            n.title, n.content, content_category=n.content_category, level=n.level,
        ) and len(n.content or "") > 300
    ]
    if not eligible:
        return

    from services.parser.quiz import MAX_GENERATED_QUESTIONS, extract_questions

    generated_count = 0
    for node in eligible[:20]:  # Cap to avoid excessive processing
        if generated_count >= MAX_GENERATED_QUESTIONS:
            break
        try:
            if not node.content or len(node.content) <= 300:
                continue
            # Practice must be derived from the learner-facing note, so notes,
            # quizzes and flashcards share one canonical scope.
            from services.generated_assets import get_active_note_markdown_by_node
            note_by_node = await get_active_note_markdown_by_node(
                db, user_id=user_id, course_id=course_id,
            )
            note = note_by_node.get(str(node.id))
            if not note:
                continue
            outcome = await extract_questions(note, node.title, course_id, node.id)
            remaining = MAX_GENERATED_QUESTIONS - generated_count
            for problem in outcome.problems[:min(3, remaining)]:
                problem.source = "ai_generated"
                problem.source_owner = "ai"
                problem.locked = False
                db.add(problem)
                generated_count += 1

        except (ConnectionError, TimeoutError) as e:
            logger.warning("Auto-generate learning content network error for '%s': %s", node.title, e)
        except (ValueError, KeyError) as e:
            logger.warning("Auto-generate learning content parse error for '%s': %s", node.title, e)
        except (RuntimeError, sa.exc.SQLAlchemyError, OSError) as e:
            logger.exception("Auto-generate learning content unexpected error for '%s'", node.title)

    try:
        await db.flush()
        logger.info("Auto-generated learning content for %d nodes in course %s", len(eligible), course_id)
    except (sa.exc.SQLAlchemyError, OSError) as e:
        logger.exception("Failed to flush auto-generated content")
