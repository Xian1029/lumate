import asyncio

from services.practice.grading_service import MatchType, grade_answer, grade_answer_deterministic


REFERENCE = "李明增长 1.2kg，张华增长 -0.5kg，刘伟增长 0kg。其中 1.2kg 和 0kg 是非负数。"
EQUIVALENT_ANSWER = "李明：1.2 kg\n张华：-0.5kg\n刘伟：0kg\n李明和刘伟为非负数"


def test_structured_word_problem_accepts_equivalent_labelled_answer():
    result = asyncio.run(grade_answer(
        question_type="free_response",
        student_answer=EQUIVALENT_ANSWER,
        expected_answer=REFERENCE,
    ))

    assert result.is_correct is True
    assert result.match_type == MatchType.STRUCTURED_EQUIVALENT
    assert grade_answer_deterministic(
        question_type="free_response",
        student_answer=EQUIVALENT_ANSWER,
        expected_answer=REFERENCE,
    ) is True


def test_structured_word_problem_still_rejects_wrong_classification():
    assert grade_answer_deterministic(
        question_type="free_response",
        student_answer="李明：1.2kg；张华：-0.5kg；刘伟：0kg；张华和刘伟为非负数",
        expected_answer=REFERENCE,
    ) is False


def test_structured_word_problem_accepts_numeric_nonnegative_classification():
    answer = "李明体重增长1.2kg\n张华体重增长-0.5kg\n刘伟体重增长0kg\n非负数为：1.2kg, 0kg"
    assert grade_answer_deterministic(
        question_type="free_response",
        student_answer=answer,
        expected_answer=REFERENCE,
    ) is True


def test_signed_opposite_explanation_accepts_equivalent_k12_wording():
    reference = "该温度表示为-3℃。零上温度为正，零下温度与它意义相反，两者是相反数。"
    answer = "-3℃。零上温度与零下温度表示相反的量。以0摄氏度为分界点，比0℃小的温度为零下温度，比0℃大的温度为零上温度。"

    result = asyncio.run(grade_answer(
        question_type="free_response",
        student_answer=answer,
        expected_answer=reference,
    ))

    assert result.is_correct is True
    assert result.match_type == MatchType.STRUCTURED_EQUIVALENT


def test_signed_opposite_explanation_is_not_lost_for_short_answer_questions():
    reference = "该温度应表示为-3℃。因为规定零上温度为正，零下温度是与它意义相反的量，应记为负数。"
    answer = "-3℃。零上温度与零下温度表示相反的量。以0摄氏度为分界点，比0℃小的温度为零下温度，比0℃大的温度为零上温度。"

    result = asyncio.run(grade_answer(
        question_type="short_answer",
        student_answer=answer,
        expected_answer=reference,
    ))

    assert result.is_correct is True
    assert result.match_type == MatchType.STRUCTURED_EQUIVALENT


def test_signed_opposite_explanation_rejects_wrong_requested_value():
    assert grade_answer_deterministic(
        question_type="free_response",
        student_answer="3℃。零上温度与零下温度表示相反的量。",
        expected_answer="该温度表示为-3℃。零上温度为正，零下温度与它意义相反，两者是相反数。",
    ) is False
