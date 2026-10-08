"""Tests for deterministic learning-plan task regeneration."""

import uuid
from datetime import date

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from database import Base
from models.content import CourseContentTree
from models.course import Course
from models.learning_plan import LearningPlanStatus
from models.learning_task import LearningTask, LearningTaskStatus
from models.user import User
from services.learning_plans import LearningPlanService, LearningTaskService
from services.learning_plans.plan_regenerator import (
    PlanRegenerationError,
    regenerate_plan_tasks,
)


@pytest_asyncio.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        user = User(name="Plan owner")
        db.add(user)
        await db.flush()
        course = Course(user_id=user.id, name="七年级数学")
        db.add(course)
        await db.flush()
        # Content tree: 1 chapter with 4 sections + 1 info node
        chapter = CourseContentTree(
            course_id=course.id, title="第一章 有理数", level=1, order_index=1,
            content_category="textbook",
        )
        db.add(chapter)
        await db.flush()
        for idx, title in enumerate(["正数和负数", "数轴", "相反数", "绝对值"], start=1):
            db.add(CourseContentTree(
                course_id=course.id, parent_id=chapter.id, title=title, level=2,
                order_index=idx, content_category="textbook",
            ))
        db.add(CourseContentTree(
            course_id=course.id, title="课程安排", level=1, order_index=99,
            content_category="syllabus",
        ))
        await db.commit()
        yield db, user, course
    await engine.dispose()


@pytest.mark.asyncio
async def test_regenerate_builds_ordered_tasks_with_deep_links(session):
    db, user, course = session
    plan = await LearningPlanService.create_draft(
        db, user_id=user.id, course_id=course.id, title="本周计划",
        available_minutes_per_day=30,
    )
    tasks = await regenerate_plan_tasks(db, plan, user.id)
    assert tasks, "should generate tasks from the content tree"
    # Learnable leaves only (4 sections), plus interleaved practice/review.
    learn_titles = [t.title for t in tasks if t.task_type == "LEARN"]
    assert any("正数和负数" in t for t in learn_titles)
    assert any("绝对值" in t for t in learn_titles)
    assert not any("课程安排" in (t.title or "") for t in tasks), "info nodes must be excluded"
    # Tree order preserved (先学后学).
    learn_seq = [t.sequence for t in tasks if t.task_type == "LEARN"]
    first = next(t for t in tasks if "正数和负数" in t.title)
    last = next(t for t in tasks if "绝对值" in t.title)
    assert first.sequence < last.sequence
    # Practice interleaved and review present.
    assert any(t.task_type == "PRACTICE" for t in tasks)
    assert any(t.task_type == "REVIEW" for t in tasks)
    # Deep links present and node-scoped for learn tasks.
    assert first.action_href and first.action_href.startswith(f"/course/{course.id}/unit/")
    # Sequences unique and scheduled.
    seqs = [t.sequence for t in tasks]
    assert len(seqs) == len(set(seqs))
    assert all(t.scheduled_for is not None for t in tasks)
    assert all(t.estimated_minutes for t in tasks)


@pytest.mark.asyncio
async def test_regenerate_respects_study_days(session):
    db, user, course = session
    plan = await LearningPlanService.create_draft(
        db, user_id=user.id, course_id=course.id, title="周末计划",
        available_minutes_per_day=20, study_days_of_week=[6, 0],  # Sat/Sun only
    )
    tasks = await regenerate_plan_tasks(db, plan, user.id)
    assert tasks
    for task in tasks:
        sunday_first = (task.scheduled_for.weekday() + 1) % 7
        assert sunday_first in (6, 0), f"task scheduled on non-study day: {task.scheduled_for}"


@pytest.mark.asyncio
async def test_regenerate_keeps_completed_tasks(session):
    db, user, course = session
    plan = await LearningPlanService.create_draft(
        db, user_id=user.id, course_id=course.id, title="进行中计划",
    )
    done = await LearningTaskService.create_task(
        db, plan_id=plan.id, course_id=course.id, title="已完成任务", task_type="LEARN", sequence=1,
    )
    await LearningTaskService.complete_task(db, done)
    tasks = await regenerate_plan_tasks(db, plan, user.id)
    remaining = (
        await db.execute(select(LearningTask).where(LearningTask.plan_id == plan.id))
    ).scalars().all()
    assert any(t.id == done.id and t.status == LearningTaskStatus.COMPLETED.value for t in remaining)
    # New sequences must not collide with the kept completed task.
    assert all(t.sequence > 1 for t in tasks)


@pytest.mark.asyncio
async def test_regenerate_rejects_active_plan(session):
    db, user, course = session
    plan = await LearningPlanService.create_draft(db, user_id=user.id, course_id=course.id, title="P")
    await LearningPlanService.submit_for_approval(db, plan, user.id)
    await LearningPlanService.approve(db, plan, user.id)
    assert plan.status == LearningPlanStatus.ACTIVE.value
    with pytest.raises(PlanRegenerationError):
        await regenerate_plan_tasks(db, plan, user.id)


@pytest.mark.asyncio
async def test_regenerate_empty_course_raises(session):
    db, user, course = session
    empty = Course(user_id=user.id, name="空课程")
    db.add(empty)
    await db.flush()
    plan = await LearningPlanService.create_draft(db, user_id=user.id, course_id=empty.id, title="P")
    with pytest.raises(PlanRegenerationError):
        await regenerate_plan_tasks(db, plan, user.id)


@pytest.mark.asyncio
async def test_selected_chapter_never_generates_unselected_chapter_tasks(session):
    db, user, course = session
    first_chapter = (await db.execute(
        select(CourseContentTree).where(
            CourseContentTree.course_id == course.id,
            CourseContentTree.title == "第一章 有理数",
        )
    )).scalar_one()
    other_chapter = CourseContentTree(
        course_id=course.id, title="第二章 整式", level=1, order_index=2,
        content_category="textbook",
    )
    db.add(other_chapter)
    await db.flush()
    db.add(CourseContentTree(
        course_id=course.id, parent_id=other_chapter.id, title="整式的加减", level=2,
        order_index=1, content_category="textbook",
    ))
    await db.flush()
    plan = await LearningPlanService.create_draft(
        db, user_id=user.id, course_id=course.id, title="只学第一章",
        draft_payload={"selected_content_node_ids": [str(first_chapter.id)]},
    )
    tasks = await regenerate_plan_tasks(db, plan, user.id)
    assert any("正数和负数" in task.title for task in tasks)
    assert all("第二章" not in task.title and "整式的加减" not in task.title for task in tasks)
    assert all("第一章 有理数" not in task.title for task in tasks), "chapter container is not a duplicate task"


@pytest.mark.asyncio
async def test_selecting_one_section_does_not_expand_its_siblings(session):
    db, user, course = session
    selected = (await db.execute(
        select(CourseContentTree).where(
            CourseContentTree.course_id == course.id,
            CourseContentTree.title == "数轴",
        )
    )).scalar_one()
    plan = await LearningPlanService.create_draft(
        db, user_id=user.id, course_id=course.id, title="只学数轴",
        draft_payload={"selected_content_node_ids": [str(selected.id)]},
    )
    tasks = await regenerate_plan_tasks(db, plan, user.id)
    learn_tasks = [task for task in tasks if task.task_type == "LEARN"]
    assert len(learn_tasks) == 1
    assert "数轴" in learn_tasks[0].title
    assert all("相反数" not in task.title and "绝对值" not in task.title for task in tasks)


@pytest.mark.asyncio
async def test_same_day_target_keeps_every_generated_task_today(session):
    db, user, course = session
    plan = await LearningPlanService.create_draft(
        db, user_id=user.id, course_id=course.id, title="今天完成",
        target_date=date.today(), available_minutes_per_day=20,
    )
    tasks = await regenerate_plan_tasks(db, plan, user.id)
    assert tasks
    assert {task.scheduled_for.date() for task in tasks} == {date.today()}
