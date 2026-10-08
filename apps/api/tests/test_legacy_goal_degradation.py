"""Regression tests for legacy-goal href degradation.

P1 close-out contract: a legacy StudyGoal whose ``metadata_json.action_href``
embeds a content node (but has no separate ``content_node_id`` field) must
still be capability-checked.  When the referenced unit was deleted — e.g. the
source material was re-ingested and the tree rebuilt — the home CTA degrades
to the module-level route instead of deep-linking into a 404.
"""

import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from database import Base
from models.content import CourseContentTree
from models.course import Course
from models.study_goal import StudyGoal
from models.user import User
from routers.goals import (
    _extract_node_from_href,
    _strip_node_from_href,
    get_user_next_learning_action,
)

CID = uuid.uuid4()
NID = uuid.uuid4()


# ---------------------------------------------------------------------------
# Pure href helpers (no DB)
# ---------------------------------------------------------------------------

def test_extract_node_from_unit_href():
    href = f"/course/{CID}/unit/{NID}"
    assert _extract_node_from_href(href) == NID


def test_extract_node_from_query_param_href():
    assert _extract_node_from_href(f"/course/{CID}/notes?node={NID}") == NID
    assert _extract_node_from_href(f"/course/{CID}/practice?tab=quiz&node={NID}") == NID
    assert _extract_node_from_href(f"/course/{CID}/practice?node={NID}&tab=flashcards") == NID


def test_extract_node_returns_none_for_module_routes():
    assert _extract_node_from_href(f"/course/{CID}") is None
    assert _extract_node_from_href(f"/course/{CID}/review") is None
    assert _extract_node_from_href(f"/course/{CID}/notes") is None


def test_strip_node_from_unit_href():
    assert _strip_node_from_href(f"/course/{CID}/unit/{NID}", CID) == f"/course/{CID}"


def test_strip_node_from_query_param_href():
    assert (
        _strip_node_from_href(f"/course/{CID}/practice?tab=quiz&node={NID}", CID)
        == f"/course/{CID}/practice?tab=quiz"
    )
    assert (
        _strip_node_from_href(f"/course/{CID}/notes?node={NID}", CID)
        == f"/course/{CID}/notes"
    )
    # Module-level routes pass through untouched.
    assert _strip_node_from_href(f"/course/{CID}/review", CID) == f"/course/{CID}/review"


# ---------------------------------------------------------------------------
# Endpoint integration
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        user = User(name="Goal owner")
        db.add(user)
        await db.flush()
        course = Course(user_id=user.id, name="物理")
        db.add(course)
        await db.flush()
        node = CourseContentTree(course_id=course.id, title="牛顿第一定律", level=2, order_index=0)
        db.add(node)
        await db.commit()
        yield db, user, course, node
    await engine.dispose()


def _legacy_goal(user_id, course_id, *, action_href: str) -> StudyGoal:
    """A goal written before the structured content_node_id field existed:
    the node reference lives only inside action_href."""
    return StudyGoal(
        user_id=user_id,
        course_id=course_id,
        title="本周掌握力学基础",
        objective="完成力学入门章节",
        next_action="继续学习牛顿第一定律",
        status="active",
        metadata_json={"action_href": action_href},
    )


@pytest.mark.asyncio
async def test_legacy_goal_with_live_node_deep_links(session):
    db, user, course, node = session
    db.add(_legacy_goal(user.id, course.id, action_href=f"/course/{course.id}/unit/{node.id}"))
    await db.commit()

    action = await get_user_next_learning_action(user=user, db=db)

    assert action.href == f"/course/{course.id}/unit/{node.id}"
    assert action.content_node_id == str(node.id)
    assert action.target_module == "CONTENT"


@pytest.mark.asyncio
async def test_legacy_goal_with_deleted_node_degrades_to_course(session):
    db, user, course, node = session
    db.add(_legacy_goal(user.id, course.id, action_href=f"/course/{course.id}/unit/{node.id}"))
    await db.commit()
    await db.delete(node)  # 教材重建导致节点消失
    await db.commit()

    action = await get_user_next_learning_action(user=user, db=db)

    assert action.href == f"/course/{course.id}"
    assert action.content_node_id is None
    assert action.target_module == "CONTENT"


@pytest.mark.asyncio
async def test_legacy_goal_with_ghost_node_id_degrades(session):
    """Legacy href referencing a node that never existed in this tree."""
    db, user, course, _node = session
    ghost = uuid.uuid4()
    db.add(_legacy_goal(user.id, course.id, action_href=f"/course/{course.id}/unit/{ghost}"))
    await db.commit()

    action = await get_user_next_learning_action(user=user, db=db)

    assert action.href == f"/course/{course.id}"
    assert action.content_node_id is None


@pytest.mark.asyncio
async def test_legacy_goal_module_href_passes_through(session):
    """Legacy hrefs without any node reference keep their module route."""
    db, user, course, _node = session
    db.add(_legacy_goal(user.id, course.id, action_href=f"/course/{course.id}/review"))
    await db.commit()

    action = await get_user_next_learning_action(user=user, db=db)

    assert action.href == f"/course/{course.id}/review"
    assert action.target_module == "REVIEW"


@pytest.mark.asyncio
async def test_structured_goal_with_deleted_node_stays_module_level(session):
    """New-style goals store a module-level action_href plus a separate
    content_node_id; a deleted node must not leak into the rendered href."""
    db, user, course, node = session
    goal = StudyGoal(
        user_id=user.id,
        course_id=course.id,
        title="练习目标",
        objective="完成练习",
        next_action="开始练习",
        status="active",
        metadata_json={
            "action_href": f"/course/{course.id}/practice?tab=quiz",
            "content_node_id": str(node.id),
        },
    )
    db.add(goal)
    await db.commit()
    await db.delete(node)
    await db.commit()

    action = await get_user_next_learning_action(user=user, db=db)

    assert action.href == f"/course/{course.id}/practice?tab=quiz"
    assert action.content_node_id is None
    assert action.target_module == "PRACTICE"
