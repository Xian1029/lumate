"""Focused tests for curriculum-grounded quiz generation quality gates."""

from services.parser.quiz import _enforce_quality_mix
from services.practice.annotation import normalize_problem_annotation


def test_quality_gate_caps_true_false_and_foundation_questions():
    questions = [
        {"question_type": "tf", "difficulty_layer": 1, "question": "判断一"},
        {"question_type": "tf", "difficulty_layer": 1, "question": "判断二"},
        {"question_type": "fill_blank", "difficulty_layer": 1, "question": "识记填空"},
        {"question_type": "mc", "difficulty_layer": 2, "question": "情境应用"},
        {"question_type": "short_answer", "difficulty_layer": 2, "question": "两步推理"},
        {"question_type": "short_answer", "difficulty_layer": 3, "question": "变式迁移"},
    ]

    kept, discarded, warnings = _enforce_quality_mix(questions, title="有理数")

    assert sum(item["question_type"] == "tf" for item in kept) == 1
    assert sum(item["difficulty_layer"] == 1 for item in kept) <= 2
    assert sum(item["difficulty_layer"] >= 2 for item in kept) == 3
    assert discarded == 1
    assert warnings


def test_metadata_keeps_curriculum_anchor_and_worked_solution():
    normalized = normalize_problem_annotation(
        {
            "question_type": "short_answer",
            "question": "气温从 3℃ 下降 8℃，请用有理数计算最终温度。",
            "correct_answer": "-5℃",
            "explanation": "用 3+(-8) 计算，结果为 -5℃。",
            "difficulty_layer": 2,
            "problem_metadata": {
                "core_concept": "有理数加法",
                "bloom_level": "apply",
                "source_anchor": "§2.1 有理数加法法则",
                "question_role": "improvement",
                "solution_steps": ["把下降 8℃ 表示为 -8", "计算 3+(-8)"],
                "common_mistake": "把下降误写成 +8",
                "method_summary": "先把方向变化写成带符号的数，再计算。",
            },
        },
        title="有理数的加法",
        source="extracted",
    )

    metadata = normalized["problem_metadata"]
    assert metadata["source_anchor"] == "§2.1 有理数加法法则"
    assert metadata["question_role"] == "improvement"
    assert len(metadata["solution_steps"]) == 2
    assert metadata["common_mistake"] == "把下降误写成 +8"
