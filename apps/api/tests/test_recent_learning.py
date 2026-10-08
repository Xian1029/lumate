"""Regression tests for the "recent learning" read model.

P0 close-out contract: a course-level heartbeat (``content_node_id=None``,
produced by browsing the course page or chatting with the AI Tutor) must
never mask the last *real* study position.  The frontend tracks course-level
and node-level activity under different ``client_session_id`` values, so they
persist as separate ``StudySession`` rows; selection must prefer node-level
sessions regardless of recency, and only fall back to a course-level session
when the learner never studied a node.
"""

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from database import Base
from models.content import CourseContentTree
from models.course import Course
from models.ingestion import StudySession
from models.progress import LearningProgress
from models.user import User
from routers.learning_plan_dashboard import learning_home_overview


@pytest_asyncio.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        user = User(name="Learner")
        db.add(user)
        await db.flush()
        course = Course(user_id=user.id, name="Math")
        db.add(course)
        await db.flush()
        node = CourseContentTree(
            course_id=course.id,
            title="Chapter 3: Quadratic equations",
            level=1,
            order_index=0,
        )
        db.add(node)
        await db.commit()
        yield db, user, course, node
    await engine.dispose()


def _make_session(
    user_id,
    course_id,
    *,
    client_session_id: str,
    content_node_id=None,
    target_module=None,
    last_activity_at: datetime,
) -> StudySession:
    return StudySession(
        user_id=user_id,
        course_id=course_id,
        client_session_id=client_session_id,
        content_node_id=content_node_id,
        target_module=target_module,
        active_seconds=300,
        elapsed_seconds=600,
        started_at=last_activity_at - timedelta(minutes=10),
        last_activity_at=last_activity_at,
        status="active",
        activity_breakdown={"reading": 300},
    )


@pytest.mark.asyncio
async def test_course_level_heartbeat_never_masks_node_position(session):
    db, user, course, node = session
    now = datetime.now(timezone.utc)
    # Older node-level study session…
    db.add(_make_session(
        user.id, course.id,
        client_session_id="node-session",
        content_node_id=node.id,
        target_module="NOTE",
        last_activity_at=now - timedelta(hours=2),
    ))
    # …followed by a newer course-level heartbeat (browse / AI Tutor chat).
    db.add(_make_session(
        user.id, course.id,
        client_session_id="course-session",
        content_node_id=None,
        last_activity_at=now,
    ))
    await db.commit()

    overview = await learning_home_overview(user=user, db=db)
    recent = overview["recent_learning"]

    assert recent is not None
    assert recent["content_node_id"] == str(node.id)
    assert recent["content_title"] == "Chapter 3: Quadratic equations"
    assert recent["target_module"] == "NOTE"
    assert recent["href"] == f"/course/{course.id}/notes?node={node.id}"


@pytest.mark.asyncio
async def test_front_matter_never_replaces_real_learning_position(session):
    db, user, course, node = session
    now = datetime.now(timezone.utc)
    front_matter = CourseContentTree(
        course_id=course.id,
        title="前言与目录",
        content_category="reference",
        level=1,
        order_index=-1,
    )
    db.add(front_matter)
    await db.flush()
    db.add(_make_session(
        user.id, course.id,
        client_session_id="real-lesson",
        content_node_id=node.id,
        last_activity_at=now - timedelta(minutes=20),
    ))
    db.add(_make_session(
        user.id, course.id,
        client_session_id="front-matter",
        content_node_id=front_matter.id,
        last_activity_at=now,
    ))
    await db.commit()

    overview = await learning_home_overview(user=user, db=db)
    assert overview["recent_learning"]["content_node_id"] == str(node.id)
    assert overview["recent_learning"]["content_title"] != "前言与目录"


@pytest.mark.asyncio
async def test_course_level_session_is_fallback_when_no_node_studied(session):
    db, user, course, _node = session
    now = datetime.now(timezone.utc)
    db.add(_make_session(
        user.id, course.id,
        client_session_id="course-session",
        content_node_id=None,
        last_activity_at=now,
    ))
    await db.commit()

    overview = await learning_home_overview(user=user, db=db)
    recent = overview["recent_learning"]

    assert recent is None


@pytest.mark.asyncio
async def test_most_recent_node_wins_among_node_sessions(session):
    db, user, course, node = session
    now = datetime.now(timezone.utc)
    older_node = CourseContentTree(
        course_id=course.id, title="Chapter 1", level=1, order_index=1,
    )
    db.add(older_node)
    await db.flush()
    db.add(_make_session(
        user.id, course.id,
        client_session_id="older-node-session",
        content_node_id=older_node.id,
        last_activity_at=now - timedelta(hours=5),
    ))
    db.add(_make_session(
        user.id, course.id,
        client_session_id="newer-node-session",
        content_node_id=node.id,
        last_activity_at=now - timedelta(hours=1),
    ))
    db.add(_make_session(
        user.id, course.id,
        client_session_id="course-session",
        content_node_id=None,
        last_activity_at=now,
    ))
    await db.commit()

    overview = await learning_home_overview(user=user, db=db)
    recent = overview["recent_learning"]

    assert recent["content_node_id"] == str(node.id)
    assert recent["href"] == f"/course/{course.id}/unit/{node.id}"


@pytest.mark.asyncio
async def test_deleted_node_degrades_to_course_overview(session):
    db, user, course, _node = session
    now = datetime.now(timezone.utc)
    # Node-level session whose node no longer exists (dangling FK is nulled
    # by SET NULL in production; emulate with a random id not in the tree).
    import uuid as _uuid

    db.add(_make_session(
        user.id, course.id,
        client_session_id="ghost-session",
        content_node_id=_uuid.uuid4(),
        last_activity_at=now,
    ))
    await db.commit()

    overview = await learning_home_overview(user=user, db=db)
    recent = overview["recent_learning"]

    assert recent is None


@pytest.mark.asyncio
async def test_overall_progress_is_weighted_by_learning_items_not_space_average(session):
    db, user, first_course, first_node = session
    db.add(LearningProgress(
        user_id=user.id,
        course_id=first_course.id,
        content_node_id=first_node.id,
        status="mastered",
        mastery_score=1.0,
    ))
    second_course = Course(user_id=user.id, name="Physics")
    db.add(second_course)
    await db.flush()
    for index in range(3):
        db.add(CourseContentTree(
            course_id=second_course.id,
            title=f"Physics topic {index + 1}",
            level=1,
            order_index=index,
        ))
    await db.commit()

    overview = await learning_home_overview(user=user, db=db)
    summary = overview["learning_summary"]
    spaces = {space["name"]: space for space in overview["learning_spaces"]}

    assert spaces["Math"]["progress_percent"] == 100
    assert spaces["Physics"]["progress_percent"] == 0
    assert summary["completed_learning_items"] == 1
    assert summary["total_learning_items"] == 4
    assert summary["progress_percent"] == 25
