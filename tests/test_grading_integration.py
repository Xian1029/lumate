"""Integration tests: unified grading verdicts drive WrongAnswer/Mastery gating.

Verifies the full submit path with a real (in-memory) database:
- SEMANTIC_EQUIVALENT / NORMALIZED_EXACT / NUMERIC_EQUIVALENT never create
  WrongAnswer rows and never penalise mastery.
- Only INCORRECT creates WrongAnswer rows.
- NEEDS_REVIEW is neither punished nor counted correct.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

API_ROOT = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from fastapi import BackgroundTasks  # noqa: E402
from sqlalchemy import func, select  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from database import Base  # noqa: E402
import models  # noqa: E402,F401  (register all tables)
from models.course import Course  # noqa: E402
from models.ingestion import WrongAnswer  # noqa: E402
from models.knowledge_graph import ConceptMastery, KnowledgeNode  # noqa: E402
from models.practice import PracticeProblem, PracticeResult  # noqa: E402
from models.user import User  # noqa: E402
from routers.quiz_submission import submit_answer  # noqa: E402
from schemas.quiz import SubmitAnswerRequest  # noqa: E402

STEM = "如果零上5℃记作+5℃，那么零下2℃记作______℃；若某次增长记为−0.8%，则表示______。"


class SubmitGradingIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()

        self.user = User(name="grader-tester")
        self.session.add(self.user)
        await self.session.flush()

        self.course = Course(user_id=self.user.id, name="七年级数学")
        self.session.add(self.course)
        await self.session.flush()

        # Mastery attaches to graph nodes — create one per knowledge point.
        self.node = KnowledgeNode(course_id=self.course.id, name="正数和负数")
        self.node2 = KnowledgeNode(course_id=self.course.id, name="负数概念")
        self.session.add_all([self.node, self.node2])
        await self.session.flush()

        self.problem = PracticeProblem(
            course_id=self.course.id,
            question_type="fill_blank",
            question=STEM,
            correct_answer="−2；减少0.8%",
            knowledge_points=["正数和负数"],
            order_index=0,
        )
        self.session.add(self.problem)
        await self.session.commit()

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()

    async def _submit(self, answer: str):
        body = SubmitAnswerRequest(problem_id=self.problem.id, user_answer=answer)
        return await submit_answer(body, BackgroundTasks(), user=self.user, db=self.session)

    async def _wrong_answer_count(self) -> int:
        result = await self.session.execute(select(func.count()).select_from(WrongAnswer))
        return result.scalar_one()

    async def _latest_result(self) -> PracticeResult:
        result = await self.session.execute(
            select(PracticeResult).order_by(PracticeResult.answered_at.desc()).limit(1)
        )
        return result.scalars().first()

    async def test_numeric_equivalent_no_wrong_answer_no_penalty(self):
        resp = await self._submit("-2；温度下降0.8%")
        self.assertTrue(resp.is_correct)
        self.assertIn(resp.match_type, ("NUMERIC_EQUIVALENT", "NORMALIZED_EXACT", "SEMANTIC_EQUIVALENT"))
        self.assertEqual(await self._wrong_answer_count(), 0)

        pr = await self._latest_result()
        self.assertTrue(pr.is_correct)
        self.assertEqual(pr.grading_meta["grader_version"], "answer-grader-v2")
        self.assertEqual(pr.grading_meta["match_type"], resp.match_type)

        # Mastery was updated as a *correct* attempt (row exists, not a penalty).
        mastery = await self.session.execute(select(ConceptMastery))
        rows = mastery.scalars().all()
        self.assertTrue(rows, "correct attempt should still update mastery")

    async def test_incorrect_creates_wrong_answer(self):
        resp = await self._submit("2；增加0.8%")
        self.assertFalse(resp.is_correct)
        self.assertEqual(resp.match_type, "INCORRECT")
        self.assertEqual(await self._wrong_answer_count(), 1)

    async def test_partially_correct_is_neutral_but_scores(self):
        resp = await self._submit("2；减少0.8%")
        self.assertFalse(resp.is_correct)
        self.assertEqual(resp.match_type, "PARTIALLY_CORRECT")
        self.assertAlmostEqual(resp.score, 0.5)
        self.assertEqual(await self._wrong_answer_count(), 0)

    async def test_needs_review_no_wrong_answer_no_mastery(self):
        problem2 = PracticeProblem(
            course_id=self.course.id,
            question_type="short_answer",
            question="为什么−2是负数？",
            correct_answer="符号相反",
            knowledge_points=["负数概念"],
            order_index=1,
        )
        self.session.add(problem2)
        await self.session.commit()

        with patch(
            "services.practice.semantic_grading.grade_blank_semantic",
            new=AsyncMock(return_value=None),  # LLM unavailable
        ):
            body = SubmitAnswerRequest(problem_id=problem2.id, user_answer="因为它具有相反的性质")
            resp = await submit_answer(body, BackgroundTasks(), user=self.user, db=self.session)

        self.assertFalse(resp.is_correct)
        self.assertTrue(resp.needs_review)
        self.assertEqual(resp.match_type, "NEEDS_REVIEW")
        self.assertEqual(await self._wrong_answer_count(), 0)

        # No mastery row may be created for an ungradeable attempt.
        mastery = await self.session.execute(
            select(ConceptMastery).where(ConceptMastery.knowledge_node_id == self.node2.id)
        )
        self.assertIsNone(mastery.scalars().first())


if __name__ == "__main__":
    unittest.main()
