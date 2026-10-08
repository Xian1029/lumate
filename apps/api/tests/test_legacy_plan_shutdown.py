"""Phase 4 regression tests: legacy plans are readable but never regain write authority."""

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from database import Base
from models.course import Course
from models.generated_asset import GeneratedAsset
from models.learning_plan import LearningPlan, LearningPlanStatus
from models.learning_task import LearningTask
from models.study_goal import StudyGoal
from models.study_plan import StudyPlan
from models.user import User
from services.generated_assets import list_generated_asset_batches
from services.learning_plans.legacy_compat import create_plan_from_legacy_markdown
from services.legacy_plan_monitor import legacy_write_counts, reset_legacy_write_counts


@pytest_asyncio.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        user = User(name="Legacy plan owner")
        db.add(user)
        await db.flush()
        course = Course(user_id=user.id, name="Math")
        db.add(course)
        await db.commit()
        yield db, user, course
    await engine.dispose()


@pytest.mark.asyncio
async def test_legacy_markdown_adapter_creates_only_reviewable_formal_plan(session):
    db, user, course = session
    reset_legacy_write_counts()
    plan = await create_plan_from_legacy_markdown(
        db,
        user_id=user.id,
        course_id=course.id,
        title="七天复习",
        markdown="## 第 1 天\n- [ ] 复习有理数\n- [ ] 完成小测",
        submit_for_review=True,
    )
    await db.commit()

    assert plan.status == LearningPlanStatus.PENDING_APPROVAL.value
    assert await db.scalar(select(func.count(LearningTask.id)).where(LearningTask.plan_id == plan.id)) == 2
    assert await db.scalar(select(func.count(StudyGoal.id))) == 0
    assert await db.scalar(select(func.count(StudyPlan.id))) == 0
    assert legacy_write_counts().get("legacy_markdown_adapter") == 1


@pytest.mark.asyncio
async def test_legacy_snapshot_reads_are_side_effect_free(session):
    db, user, course = session
    snapshot = GeneratedAsset(
        user_id=user.id,
        course_id=course.id,
        asset_type="study_plan",
        title="旧版计划",
        content={"markdown": "- [ ] 历史任务"},
        batch_id=uuid.uuid4(),
    )
    db.add(snapshot)
    await db.commit()
    before = {
        "assets": await db.scalar(select(func.count(GeneratedAsset.id))),
        "goals": await db.scalar(select(func.count(StudyGoal.id))),
        "tasks": await db.scalar(select(func.count(LearningTask.id))),
    }

    for _ in range(10):
        await list_generated_asset_batches(db, user_id=user.id, course_id=course.id, asset_type="study_plan")

    after = {
        "assets": await db.scalar(select(func.count(GeneratedAsset.id))),
        "goals": await db.scalar(select(func.count(StudyGoal.id))),
        "tasks": await db.scalar(select(func.count(LearningTask.id))),
    }
    assert after == before
