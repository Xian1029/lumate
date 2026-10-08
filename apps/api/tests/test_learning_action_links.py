"""Recommendation → navigation and resume-learning deep link tests.

Covers:
- task_type → module → route mapping for every LearningTaskType;
- capability fallback when a referenced content node was deleted;
- the home overview emitting one structured action object (text + target +
  href from the same source);
- recent-learning deep links into the last studied unit, with a course-level
  fallback when that unit no longer exists.
"""

import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from database import Base
from models.content import CourseContentTree
from models.course import Course
from models.ingestion import StudySession
from models.learning_plan import LearningPlanStatus
from models.learning_task import LearningTaskStatus
from models.user import User
from routers.learning_plan_dashboard import learning_home_overview
from services.learning_plans import LearningPlanService, LearningTaskService
from services.learning_plans.action_links import (
    build_action_href,
    build_resume_href,
    cta_label_for_module,
    module_for_task_type,
)

CID = uuid.uuid4()
NID = uuid.uuid4()


# ---------------------------------------------------------------------------
# Pure mapping tests (no DB)
# ---------------------------------------------------------------------------

def test_module_mapping_covers_all_task_types():
    assert module_for_task_type("LEARN") == "CONTENT"
    assert module_for_task_type("PRACTICE") == "PRACTICE"
    assert module_for_task_type("FLASHCARD") == "FLASHCARD"
    assert module_for_task_type("REVIEW") == "REVIEW"
    assert module_for_task_type("REFLECTION") == "CONTENT"
    assert module_for_task_type("ASSESSMENT") == "MASTERY_CHECK"
    assert module_for_task_type("NOTE") == "NOTE"
    assert module_for_task_type("UNKNOWN") == "CONTENT"
    assert module_for_task_type(None) == "CONTENT"


def test_deep_links_per_module():
    cases = {
        "NOTE": f"/course/{CID}?node={NID}&module=NOTE",
        "PRACTICE": f"/course/{CID}?node={NID}&module=PRACTICE",
        "ASSESSMENT": f"/course/{CID}?node={NID}&module=MASTERY_CHECK",
        "FLASHCARD": f"/course/{CID}?node={NID}&module=FLASHCARD",
        "REVIEW": f"/course/{CID}?node={NID}&module=REVIEW",
        "LEARN": f"/course/{CID}?node={NID}&module=CONTENT",
    }
    for task_type, expected in cases.items():
        href = build_action_href(task_type=task_type, course_id=CID, content_node_id=NID, node_exists=True)
        assert href == expected, task_type


def test_deleted_node_falls_back_never_404():
    assert build_action_href(task_type="LEARN", course_id=CID, content_node_id=NID, node_exists=False) == f"/course/{CID}?module=CONTENT"
    assert build_action_href(task_type="NOTE", course_id=CID, content_node_id=NID, node_exists=False) == f"/course/{CID}?module=NOTE"
    assert build_action_href(task_type="PRACTICE", course_id=CID, content_node_id=NID, node_exists=False) == f"/course/{CID}?module=PRACTICE"


def test_node_less_task_still_deep_links_to_module():
    # A task without a content node must still land in the right module, not
    # on a generic page.
    assert build_action_href(task_type="NOTE", course_id=CID, content_node_id=None, node_exists=False) == f"/course/{CID}?module=NOTE"
    assert build_action_href(task_type="REVIEW", course_id=CID, content_node_id=None, node_exists=False) == f"/course/{CID}?module=REVIEW"


def test_cta_labels_align_with_module():
    assert cta_label_for_module("NOTE") == "开始整理笔记"
    assert cta_label_for_module("PRACTICE") == "开始练习"
    assert cta_label_for_module("REVIEW") == "开始复习"
    assert cta_label_for_module("MASTERY_CHECK") == "开始检测"
    assert cta_label_for_module("FLASHCARD") == "开始记忆复习"


def test_resume_href_fallback():
    assert build_resume_href(course_id=CID, content_node_id=NID, node_exists=True) == f"/course/{CID}/unit/{NID}"
    assert build_resume_href(course_id=CID, content_node_id=NID, node_exists=False) == f"/course/{CID}"
    assert build_resume_href(course_id=CID, content_node_id=None, node_exists=False) == f"/course/{CID}"
    assert build_resume_href(course_id=CID, content_node_id=NID, node_exists=True, target_module="NOTE") == f"/course/{CID}/notes?node={NID}"
    assert build_resume_href(course_id=CID, content_node_id=NID, node_exists=True, target_module="PRACTICE") == f"/course/{CID}/practice?tab=quiz&node={NID}"


# ---------------------------------------------------------------------------
# Home overview integration
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        user = User(name="Home owner")
        db.add(user)
        await db.flush()
        course = Course(user_id=user.id, name="七年级数学")
        db.add(course)
        await db.flush()
        node = CourseContentTree(course_id=course.id, title="正数和负数", level=2, order_index=1)
        db.add(node)
        await db.commit()
        yield db, user, course, node
    await engine.dispose()


async def _activate_plan_with_task(db, user, course, *, task_type="NOTE", with_node=True):
    plan = await LearningPlanService.create_draft(db, user_id=user.id, course_id=course.id, title="本周计划")
    node = (await db.get(CourseContentTree, (await db.execute(
        __import__("sqlalchemy").select(CourseContentTree.id).where(CourseContentTree.course_id == course.id)
    )).scalar_one())) if with_node else None
    task = await LearningTaskService.create_task(
        db,
        plan_id=plan.id,
        course_id=course.id,
        content_node_id=node.id if node else None,
        task_type=task_type,
        title=f"执行任务-{task_type}",
        instruction="围绕核心概念完成学习动作",
        scheduled_for=datetime.now(timezone.utc),
        sequence=1,
    )
    await LearningPlanService.submit_for_approval(db, plan, user.id)
    await LearningPlanService.approve(db, plan, user.id)
    await db.commit()
    return plan, task


@pytest.mark.asyncio
async def test_overview_action_is_structured_and_deep_linked(session):
    db, user, course, node = session
    _, task = await _activate_plan_with_task(db, user, course, task_type="NOTE")

    overview = await learning_home_overview(user=user, db=db)
    action = overview["current_learning_action"]

    # Recommendation and navigation come from the same object.
    assert action["learning_task_id"] == str(task.id)
    assert action["content_node_id"] == str(node.id)
    assert action["target_module"] == "NOTE"
    assert action["action_text"] == "开始整理笔记"
    assert action["href"] == f"/course/{course.id}?node={node.id}&module=NOTE"
    assert action["instruction"]

    today = overview["today_tasks"]
    assert today and today[0]["href"] == f"/course/{course.id}?node={node.id}&module=NOTE"


@pytest.mark.asyncio
async def test_overview_action_falls_back_when_node_deleted(session):
    db, user, course, node = session
    await _activate_plan_with_task(db, user, course, task_type="LEARN")
    await db.delete(node)  #教材重建导致节点消失
    await db.commit()

    overview = await learning_home_overview(user=user, db=db)
    action = overview["current_learning_action"]
    assert action["href"] == f"/course/{course.id}?module=CONTENT"
    assert action["target_module"] == "CONTENT"


@pytest.mark.asyncio
async def test_recent_learning_deep_links_to_last_unit(session):
    db, user, course, node = session
    db.add(StudySession(user_id=user.id, course_id=course.id, content_node_id=node.id, status="completed"))
    await db.commit()

    overview = await learning_home_overview(user=user, db=db)
    recent = overview["recent_learning"]
    assert recent is not None
    assert recent["content_node_id"] == str(node.id)
    assert recent["content_title"] == "正数和负数"
    assert recent["href"] == f"/course/{course.id}/unit/{node.id}"


@pytest.mark.asyncio
async def test_recent_learning_falls_back_when_node_deleted(session):
    db, user, course, node = session
    db.add(StudySession(user_id=user.id, course_id=course.id, content_node_id=node.id, status="completed"))
    await db.commit()
    await db.delete(node)
    await db.commit()

    overview = await learning_home_overview(user=user, db=db)
    recent = overview["recent_learning"]
    assert recent is None


@pytest.mark.asyncio
async def test_in_progress_task_cta_stays_continue(session):
    db, user, course, node = session
    _, task = await _activate_plan_with_task(db, user, course, task_type="PRACTICE")
    await LearningTaskService.start_task(db, task)
    await db.commit()
    assert task.status == LearningTaskStatus.IN_PROGRESS.value

    overview = await learning_home_overview(user=user, db=db)
    action = overview["current_learning_action"]
    assert action["action_text"] == "继续学习"
    assert action["href"] == f"/course/{course.id}?node={node.id}&module=PRACTICE"
    assert action["target_module"] == "PRACTICE"
