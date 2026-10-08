"""Unit tests for the unified AnswerGradingService (answer-grader-v2).

Covers the layered pipeline: normalization → numeric/structured → accepted
answers → deterministic mismatch → semantic (mocked) → NEEDS_REVIEW.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

API_ROOT = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from services.practice.grading_service import (  # noqa: E402
    GRADER_VERSION,
    MatchType,
    grade_answer,
    grade_answer_deterministic,
    normalize_answer,
)


def grade(qt: str, student: str, expected: str, **kwargs):
    import asyncio

    return asyncio.run(
        grade_answer(question_type=qt, student_answer=student, expected_answer=expected, **kwargs)
    )


STEM = "如果零上5℃记作+5℃，那么零下2℃记作______℃；若某次增长记为−0.8%，则表示______。"
CTX = {"question": STEM}


class NormalizationTests(unittest.TestCase):
    def test_unicode_minus_equals_ascii_minus(self):
        self.assertEqual(normalize_answer("−2"), normalize_answer("-2"))

    def test_unicode_minus_variants(self):
        for variant in ("−2", "﹣2", "－2"):
            r = grade("fill_blank", variant, "-2")
            self.assertTrue(r.is_correct, variant)

    def test_fullwidth_plus(self):
        r = grade("fill_blank", "＋5", "+5")
        self.assertTrue(r.is_correct)

    def test_fullwidth_digits_and_percent(self):
        r = grade("fill_blank", "－２", "-2")
        self.assertTrue(r.is_correct)

    def test_cjk_and_ascii_punctuation_blank_split(self):
        # Any normal CJK/ASCII answer separator must preserve blank order.
        for sep in ("；", ";", "，", ",", "、", "\n"):
            r = grade("fill_blank", f"-2{sep}减少0.8%", "−2；减少0.8%", question_context=CTX)
            self.assertTrue(r.is_correct, sep)

    def test_whitespace_and_newlines_ignored(self):
        r = grade("fill_blank", "  -2 ；\n 减少0.8% ", "−2；减少0.8%", question_context=CTX)
        self.assertTrue(r.is_correct)

    def test_grader_version_tagged(self):
        self.assertEqual(GRADER_VERSION, "answer-grader-v2")


class NumericLayerTests(unittest.TestCase):
    def test_numeric_equivalent_decimal_form(self):
        r = grade("fill_blank", "-2.0", "-2")
        self.assertTrue(r.is_correct)
        self.assertEqual(r.match_type, MatchType.NUMERIC_EQUIVALENT)

    def test_sign_error_is_incorrect(self):
        r = grade("fill_blank", "2", "-2")
        self.assertFalse(r.is_correct)
        self.assertEqual(r.match_type, MatchType.INCORRECT)

    def test_value_error_is_incorrect(self):
        r = grade("fill_blank", "8", "-2")
        self.assertFalse(r.is_correct)

    def test_unit_omitted_forgiven(self):
        r = grade("fill_blank", "-2", "-2℃")
        self.assertTrue(r.is_correct)

    def test_unit_stated_accepted(self):
        r = grade("fill_blank", "-2℃", "-2℃")
        self.assertTrue(r.is_correct)

    def test_conflicting_unit_rejected(self):
        r = grade("fill_blank", "-2米", "-2℃")
        self.assertFalse(r.is_correct)

    def test_percent_normalized(self):
        r = grade("fill_blank", "50％", "50%")
        self.assertTrue(r.is_correct)

    def test_tolerance_comes_from_config_not_global(self):
        strict = grade("fill_blank", "1.05", "1.0", answer_config={"tolerance": 0.01})
        self.assertFalse(strict.is_correct)
        loose = grade("fill_blank", "1.05", "1.0", answer_config={"tolerance": 0.1})
        self.assertTrue(loose.is_correct)


class AcceptedAnswersTests(unittest.TestCase):
    def test_accepted_answers_match(self):
        r = grade(
            "fill_blank",
            "下降0.8%",
            "减少0.8%",
            answer_config={"acceptedAnswers": ["下降0.8%", "降低0.8%"]},
        )
        self.assertTrue(r.is_correct)

    def test_synonym_direction_words_without_config(self):
        # 同义方向词（减少/下降/降低）由方向归一处理，不要求题库穷举。
        for synonym in ("下降0.8%", "降低0.8%", "减少了0.8%"):
            r = grade("fill_blank", synonym, "减少0.8%")
            self.assertTrue(r.is_correct, synonym)


class DeterministicMismatchTests(unittest.TestCase):
    """Clearly-wrong answers must be rejected without any LLM call."""

    def test_direction_conflict_deterministic(self):
        with patch(
            "services.practice.semantic_grading.grade_blank_semantic"
        ) as mock_semantic:
            r = grade("fill_blank", "增加0.8%", "减少0.8%")
        self.assertFalse(r.is_correct)
        self.assertEqual(r.match_type, MatchType.INCORRECT)
        mock_semantic.assert_not_called()

    def test_key_number_mismatch_deterministic(self):
        with patch(
            "services.practice.semantic_grading.grade_blank_semantic"
        ) as mock_semantic:
            r = grade("fill_blank", "减少8%", "减少0.8%")
        self.assertFalse(r.is_correct)
        self.assertEqual(r.match_type, MatchType.INCORRECT)
        mock_semantic.assert_not_called()


class MultiBlankTests(unittest.TestCase):
    def test_multi_blank_graded_per_blank_not_concatenated(self):
        r = grade("fill_blank", "-2；温度下降0.8%", "−2；减少0.8%", question_context=CTX)
        self.assertTrue(r.is_correct)
        self.assertEqual(len(r.per_blank_results), 2)
        self.assertEqual(r.per_blank_results[0]["match_type"], MatchType.NUMERIC_EQUIVALENT.value)
        self.assertTrue(all(b["is_correct"] for b in r.per_blank_results))

    def test_partial_blank_failure_is_partially_correct(self):
        r = grade("fill_blank", "2；减少0.8%", "−2；减少0.8%", question_context=CTX)
        self.assertFalse(r.is_correct)
        self.assertEqual(r.match_type, MatchType.PARTIALLY_CORRECT)
        self.assertAlmostEqual(r.score, 0.5)

    def test_blank_count_mismatch_is_incorrect(self):
        r = grade("fill_blank", "-2", "−2；减少0.8%", question_context=CTX)
        self.assertFalse(r.is_correct)
        self.assertEqual(r.match_type, MatchType.INCORRECT)


class SpecAcceptanceTests(unittest.TestCase):
    """The exact cases from the fix specification."""

    def test_all_spec_positive_cases(self):
        for student in (
            "-2；减少0.8%",
            "−2；下降0.8%",
            "-2；降低0.8%",
            "-2；减少了0.8%",
            "-2；温度下降0.8%",
        ):
            r = grade("fill_blank", student, "−2；减少0.8%", question_context=CTX)
            self.assertTrue(r.is_correct, student)

    def test_all_spec_negative_cases(self):
        for student in (
            "2；减少0.8%",
            "-2；增加0.8%",
            "-2；减少8%",
            "2；增加0.8%",
        ):
            r = grade("fill_blank", student, "−2；减少0.8%", question_context=CTX)
            self.assertFalse(r.is_correct, student)


class StructuredClassificationTests(unittest.TestCase):
    expected = "右侧：3、2.5；原点：0；左侧：−4、−1/2"

    def test_group_and_member_order_do_not_matter(self):
        r = grade("short_answer", "左侧：-1/2、-4；右侧：2.5、3；原点：0", self.expected)
        self.assertTrue(r.is_correct)
        self.assertEqual(r.match_type, MatchType.STRUCTURED_EQUIVALENT)

    def test_wrong_side_is_incorrect(self):
        r = grade("short_answer", "左侧：-4；右侧：3、2.5、-1/2；原点：0", self.expected)
        self.assertFalse(r.is_correct)
        self.assertEqual(r.match_type, MatchType.INCORRECT)

    def test_labelled_student_answer_matches_natural_language_reference(self):
        """Question banks may phrase the key as a sentence, not form fields."""
        expected = "3、0.5在原点右侧（正半轴）；-4、-5/2在原点左侧（负半轴）；0就在原点。"
        student = "在原点左侧的有：-4，-5/2\n在原点的有：0\n在原点右侧的有：3，0.5"
        r = grade("short_answer", student, expected)
        self.assertTrue(r.is_correct)
        self.assertEqual(r.match_type, MatchType.STRUCTURED_EQUIVALENT)


class SemanticLayerTests(unittest.TestCase):
    def test_semantic_equivalent_marked_correct(self):
        verdict = {"is_correct": True, "confidence": 0.92, "reason": "方向和数值一致"}
        with patch(
            "services.practice.semantic_grading.grade_blank_semantic",
            return_value=verdict,
        ):
            # No shared numbers/direction words → deterministic layers cannot
            # decide, the semantic layer must be consulted.
            r = grade("short_answer", "因为它具有相反的性质", "符号相反")
        self.assertTrue(r.is_correct)
        self.assertEqual(r.match_type, MatchType.SEMANTIC_EQUIVALENT)
        self.assertTrue(r.semantic_grading_used)

    def test_semantic_low_confidence_needs_review_not_wrong(self):
        verdict = {"is_correct": False, "confidence": 0.4, "reason": "无法确定"}
        with patch(
            "services.practice.semantic_grading.grade_blank_semantic",
            return_value=verdict,
        ):
            r = grade("short_answer", "某种模糊表述", "参考答案")
        self.assertFalse(r.is_correct)
        self.assertEqual(r.match_type, MatchType.NEEDS_REVIEW)

    def test_semantic_unavailable_needs_review_not_wrong(self):
        with patch(
            "services.practice.semantic_grading.grade_blank_semantic",
            return_value=None,
        ):
            r = grade("short_answer", "某种模糊表述", "参考答案")
        self.assertFalse(r.is_correct)
        self.assertEqual(r.match_type, MatchType.NEEDS_REVIEW)

    def test_semantic_confident_wrong_is_incorrect(self):
        verdict = {"is_correct": False, "confidence": 0.95, "reason": "核心概念错误"}
        with patch(
            "services.practice.semantic_grading.grade_blank_semantic",
            return_value=verdict,
        ):
            r = grade("short_answer", "完全无关的回答", "参考答案")
        self.assertFalse(r.is_correct)
        self.assertEqual(r.match_type, MatchType.INCORRECT)

    def test_semantic_disabled_by_config_goes_incorrect(self):
        r = grade(
            "fill_blank",
            "某种模糊表述",
            "参考答案",
            answer_config={"allowSemanticMatch": False},
        )
        self.assertFalse(r.is_correct)

    def test_semantic_timeout_needs_review_not_wrong(self):
        """A stalled LLM call must degrade to NEEDS_REVIEW, never 500/wrong."""
        import asyncio

        async def _slow_chat(*args, **kwargs):
            await asyncio.sleep(30)  # longer than the grading timeout
            return '{"is_correct": true, "confidence": 0.9, "reason": "x"}', {}

        with patch(
            "services.llm.router.get_llm_client",
            return_value=type("FakeClient", (), {"chat": _slow_chat})(),
        ):
            r = grade("short_answer", "某种模糊表述", "参考答案")
        self.assertFalse(r.is_correct)
        self.assertEqual(r.match_type, MatchType.NEEDS_REVIEW)


class ObjectiveTypeTests(unittest.TestCase):
    def test_mc_label(self):
        r = grade("mc", "A", "A", options={"A": "甲", "B": "乙"})
        self.assertTrue(r.is_correct)

    def test_tf_chinese_synonyms(self):
        r = grade("tf", "对", "正确")
        self.assertTrue(r.is_correct)

    def test_tf_wrong(self):
        r = grade("tf", "对", "错误")
        self.assertFalse(r.is_correct)


class LegacyWrapperTests(unittest.TestCase):
    def test_deterministic_wrapper_bool(self):
        self.assertTrue(grade_answer_deterministic(
            question_type="fill_blank", student_answer="-2", expected_answer="−2"))
        self.assertFalse(grade_answer_deterministic(
            question_type="fill_blank", student_answer="2", expected_answer="−2"))


if __name__ == "__main__":
    unittest.main()
