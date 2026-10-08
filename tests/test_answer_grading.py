"""Regression tests for forgiving learner-answer grading."""

from routers.quiz_submission import _grade_text_answer
from services.practice.answer_grading import numeric_answers_equivalent


def test_multiple_numeric_blanks_ignore_cjk_separator_and_unit_spacing():
    assert numeric_answers_equivalent("-0.5kg，0kg", "-0.5 kg；0 kg")
    assert numeric_answers_equivalent("-0.5kg\n0kg", "−0.5 kg；0 kg")
    assert _grade_text_answer("fill_blank", "-0.5kg，0kg", "-0.5 kg；0 kg")


def test_multiple_numeric_blanks_still_reject_wrong_value_or_unit():
    assert not numeric_answers_equivalent("0.5kg，0kg", "-0.5 kg；0 kg")
    assert not numeric_answers_equivalent("-0.5m，0kg", "-0.5 kg；0 kg")


def test_multiple_numeric_blanks_require_all_answers():
    assert not numeric_answers_equivalent("-0.5kg", "-0.5 kg；0 kg")


def test_text_grading_ignores_punctuation_spacing_and_accepts_fuller_explanation():
    assert _grade_text_answer("fill_blank", "负数！", "负数")
    assert _grade_text_answer("short_answer", "我的答案是：互为相反数。", "互为相反数")


def test_text_grading_does_not_ignore_changed_meaning():
    assert not _grade_text_answer("short_answer", "它们不是互为相反数", "互为相反数")


def test_equivalent_arithmetic_work_is_accepted():
    assert _grade_text_answer(
        "short_answer",
        "25+15-(18+12)=40-30=10",
        "(25+15)+[(-18)+(-12)]=40+(-30)=10",
    )
    assert _grade_text_answer(
        "short_answer",
        "18+22-(7+3)=40-10=30",
        "(18+22)+[(-7)+(-3)]=40+(-10)=30",
    )


def test_equivalent_work_rejects_wrong_result_or_different_operands():
    assert not _grade_text_answer("short_answer", "18+22-(7+3)=31", "18+22-7-3=30")
    assert not _grade_text_answer("short_answer", "20+20-7-3=30", "18+22-7-3=30")


def test_blank_sign_words_and_unicode_minus_are_equivalent():
    assert _grade_text_answer("fill_blank", "-7，负号，4", "−7；负；4")
    assert _grade_text_answer("fill_blank", "-28，-，13", "−28；负；13")
    assert not _grade_text_answer("fill_blank", "-28，正，13", "−28；负；13")
    assert _grade_text_answer(
        "fill_blank",
        "-28；负；13",
        "−28（或−28的绝对值28）；负；13",
    )


def test_fill_blanks_accept_equivalent_change_direction_wording():
    # “下降了 0.8%” and “减少 0.8%” express the same required change.
    assert _grade_text_answer("fill_blank", "-2\n下降了0.8%", "-2；减少0.8%")
    # The wording is flexible, but direction and value remain mandatory.
    assert not _grade_text_answer("fill_blank", "-2\n上升了0.8%", "-2；减少0.8%")


def test_multiple_blanks_accept_an_explicit_reference_alternative():
    assert _grade_text_answer(
        "fill_blank",
        "8848.86\n-154.31",
        "+8848.86 或 8848.86；−154.31",
    )
    assert _grade_text_answer(
        "fill_blank",
        "+8848.86；-154.31",
        "+8848.86 或 8848.86；−154.31",
    )
    assert not _grade_text_answer(
        "fill_blank",
        "8848.86；154.31",
        "+8848.86 或 8848.86；−154.31",
    )


def test_keyboard_exponent_matches_superscript_notation():
    assert _grade_text_answer("fill_blank", "a^2/b", "a²/b")
    assert _grade_text_answer("short_answer", "a ** 2 / b", "a²/b")
    assert not _grade_text_answer("fill_blank", "a^3/b", "a²/b")


def test_prose_answer_accepts_same_signed_quantities_with_units():
    assert _grade_text_answer(
        "short_answer",
        "+150g表示比标准质量多150g，-80g表示少80g；实际4.95kg，所以是-50g。",
        "+150 g表示超出150 g，-80 g表示不足80 g；4.95 kg比5 kg少50 g，标作-50 g。",
    )
    assert not _grade_text_answer(
        "short_answer",
        "+150g表示多150g，-80g表示少80g，最后是+50g。",
        "+150g，-80g，-50g",
    )


def test_repeated_quantities_in_reference_are_not_required_from_learner():
    assert _grade_text_answer(
        "short_answer",
        "+150g表示重150g，-80g表示轻80g，4.95kg应标-50g",
        "+150g表示多150g，实际是5kg+150g；-80g表示少80g；最后标-50g",
    )


def test_legacy_true_false_option_label_accepts_visible_text():
    options = {"A": "正确", "B": "错误"}
    assert _grade_text_answer("tf", "对的", "A", options)
    assert _grade_text_answer("tf", "正确", "A", options)
    assert not _grade_text_answer("tf", "错误", "A", options)


def test_legacy_text_question_option_label_accepts_option_text():
    options = {"A": "增加了", "B": "减少了"}
    assert _grade_text_answer("short_answer", "减少了", "B", options)
    assert not _grade_text_answer("short_answer", "增加了", "B", options)
