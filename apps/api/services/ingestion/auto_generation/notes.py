"""Auto-generation of AI notes for content nodes after ingestion."""

import logging
import uuid

from sqlalchemy import select

logger = logging.getLogger(__name__)


async def auto_generate_notes(
    db_factory,
    course_id: uuid.UUID,
    user_id: uuid.UUID,
) -> int:
    """Phase 4: Auto-generate AI notes for content nodes after ingestion."""
    from models.content import CourseContentTree
    from services.content_text import is_assessment_content
    from services.parser.notes import restructure_notes
    from services.generated_assets import save_generated_asset

    generated = 0
    async with db_factory() as db:
        # Get content nodes with substantial content
        result = await db.execute(
            select(CourseContentTree).where(
                CourseContentTree.course_id == course_id,
                CourseContentTree.content.isnot(None),
            )
        )
        nodes = result.scalars().all()

        # Notes are the canonical source for later cards and questions. Never
        # create them from document containers, contents pages, or front matter.
        eligible = [
            n for n in nodes
            if is_assessment_content(
                n.title, n.content, content_category=n.content_category, level=n.level,
            ) and len(n.content or "") > 200
        ]
        if not eligible:
            return 0

        # Process every eligible textbook section with bounded concurrency.
        # A small limit avoids provider rate spikes on full-book uploads while
        # ensuring later chapters are not silently left without notes.
        import asyncio as _asyncio
        semaphore = _asyncio.Semaphore(2)

        async def _gen_one(node):
            try:
                content_trimmed = node.content[:4000] if node.content else ""
                async with semaphore:
                    ai_content = await _asyncio.wait_for(
                        restructure_notes(
                            content_trimmed,
                            node.title,
                            note_format="bullet_point",
                        ),
                        timeout=45,
                    )
                if ai_content and len(ai_content) > 50:
                    return (node, ai_content)
            except _asyncio.TimeoutError:
                logger.warning("Auto-generate notes timed out for '%s'", node.title)
            except (ConnectionError, TimeoutError) as e:
                logger.warning("Auto-generate notes network error for '%s': %s", node.title, e)
            except (ValueError, RuntimeError) as e:
                logger.exception("Auto-generate notes unexpected error for '%s'", node.title)
            except Exception as e:
                logger.exception("Auto-generate notes failed for '%s'", node.title)
            return None

        results = await _asyncio.gather(*[_gen_one(n) for n in eligible], return_exceptions=True)
        for res in results:
            if isinstance(res, BaseException):
                logger.warning("Auto-generate gather returned exception: %s", res)
                continue
            if res:
                node, ai_content = res
                await save_generated_asset(
                    db,
                    user_id=user_id,
                    course_id=course_id,
                    asset_type="notes",
                    title=node.title,
                    content={"markdown": ai_content},
                    metadata={
                        "source_node_id": str(node.id),
                        "auto_generated": True,
                        "format": "bullet_point",
                    },
                )
                generated += 1
                logger.info("Auto-generated notes for node '%s'", node.title)

        await db.commit()

    logger.info("Auto-generated notes: %d/%d nodes processed", generated, len(eligible))
    return generated
