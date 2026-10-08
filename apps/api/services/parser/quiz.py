from __future__ import annotations

"""Quiz extraction service.

Extracts practice problems from content using structured LLM output and writes
consistent problem metadata for downstream review, assessment, and mastery
tracking. The metadata schema is generic learning analytics, not domain-specific.
"""

from dataclasses import dataclass, field
import logging
import math
import re
from typing import Any
import uuid

from models.practice import PracticeProblem
from services.llm.router import get_llm_client
from services.practice.annotation import (
    build_practice_problem,
    build_question_dedupe_key,
    normalize_problem_annotation,
    parse_question_array,
    validate_question_payload,
)
from services.content_text import is_generic_textbook_prompt, is_non_learning_question

logger = logging.getLogger(__name__)

# A practice set is one focused learning activity, not a question-bank dump.
# Keep this shared service-level guard so LLM output, saved assistant output
# and every router cannot accidentally create an overwhelming batch.
MAX_GENERATED_QUESTIONS = 15

# 8 question types
QUESTION_TYPES = {
    "mc": "Multiple Choice — one correct answer from 4 options",
    "tf": "True/False — statement is true or false",
    "short_answer": "Short Answer — brief text response",
    "fill_blank": "Fill in the Blank — complete the sentence",
    "matching": "Matching — match items from two columns",
    "select_all": "Select All That Apply — multiple correct answers",
    "free_response": "Free Response — extended written answer",
    "coding": "Coding — write code to solve a problem (LLM-graded, no execution)",
}

EXTRACTION_PROMPT = """You are an expert educator creating practice questions from learning materials.

Given the content below, extract or generate practice questions. Follow these rules:

1. Generate only these learner-supported question types: mc (multiple choice), tf (true/false), short_answer, and fill_blank. Use coding only when the source explicitly teaches programming, code, or an algorithm implementation. Mathematics, physics, and other non-programming lessons must never be converted into Python/programming questions. Do not generate matching or select-all questions.
2. Ask only about concepts, rules, examples, reasoning, or applications in the lesson body. Never ask for a textbook, chapter, unit, or section title/name, a table-of-contents entry, number of chapters, publisher, editor, author, ISBN, or other document metadata.
3. Build a question blueprint before writing the questions. Identify the lesson's concrete knowledge points, prerequisites, worked examples, methods, and common mistakes. Every question must anchor to ONE named knowledge point from that blueprint; never write a generic "recognition" question merely because a sentence appears in the note.
4. Use a layered practice mix inspired by high-quality Chinese junior-school workbooks:
   - foundation (Layer 1): at most 30%; check a necessary concept or single-step skill
   - improvement (Layer 2): at least 40%; require calculation, explanation, comparison, interpretation, or a two-step application
   - challenge (Layer 3): at least 20% when the source is rich enough; vary a condition, combine concepts, diagnose an error, or transfer the method to a new situation
   True/false questions may be used only for a high-value misconception and must be no more than ONE question in the batch. Do not use true/false for plain factual recognition.
5. Match the subject and source affordances. If the lesson contains calculations, include a calculation/application question. If it contains an experiment, include an experiment-design or evidence question. If it contains a graph, table, geometry figure, number line, or data display, include an interpretation question. Use short_answer for worked calculations or reasoning when no dedicated UI type exists.
6. Prefer original variants of the lesson's examples: change values, conditions, direction, representation, or context while preserving the exact knowledge boundary. Do not copy sentences from the note and turn them into trivial blanks.
7. For multiple choice, always provide exactly 4 plausible options (A, B, C, D). Distractors must correspond to specific common mistakes, not random values.
8. Include the correct answer and a child-friendly worked explanation. The explanation must contain the reasoning or calculation, the likely mistake, and a reusable method; giving only the final answer is invalid.
9. Generate 6-8 questions for a normal lesson and 3-5 only for genuinely short source material.
10. For EACH question, provide structured learning metadata:
   - difficulty_layer: 1 basic understanding, 2 standard application, 3 advanced/tricky transfer
   - core_concept: the main concept being tested
   - bloom_level: remember | understand | apply | analyze | evaluate | create
   - potential_traps: specific misconceptions or pitfalls (empty list if none)
   - layer_justification: one short reason for the difficulty_layer choice
   - skill_focus: what ability is being tested (for example recall, comparison, derivation, interpretation)
   - source_section: the section title if obvious from context
   - source_anchor: the exact named knowledge point or sub-section in the provided source
   - question_role: foundation | improvement | challenge
   - solution_steps: an ordered list of reasoning/calculation steps
   - common_mistake: the most likely wrong approach and why it fails
   - method_summary: one reusable method sentence
11. Write every learner-facing field (question, options, correct answer,
   explanation, and metadata) in the requested output language. If no output
   language is requested, use the language of the source material.
12. Test only the lesson's academic concepts. Never make questions about the
   publisher, editor, author, ISBN, copyright page, printing, or book metadata.
13. Name the exact concept in every question. Do not ask vague questions such as
   “课本中介绍了什么” or “本节学习了什么”.

Output ONLY a valid JSON array with this structure:
```json
[
  {
    "question_type": "mc",
    "question": "What is the primary purpose of...?",
    "options": {"A": "Option 1", "B": "Option 2", "C": "Option 3", "D": "Option 4"},
    "correct_answer": "B",
    "explanation": "Option B is correct because...",
    "difficulty_layer": 2,
    "problem_metadata": {
      "core_concept": "main idea",
      "bloom_level": "apply",
      "potential_traps": ["common confusion 1"],
      "layer_justification": "Requires applying the idea to a new example",
      "skill_focus": "application",
      "source_section": "Section title"
    }
  },
  {
    "question_type": "tf",
    "question": "The process of X always results in Y.",
    "options": null,
    "correct_answer": "False",
    "explanation": "This is false because...",
    "difficulty_layer": 1,
    "problem_metadata": {
      "core_concept": "X versus Y",
      "bloom_level": "understand",
      "potential_traps": [],
      "layer_justification": "Direct comprehension check",
      "skill_focus": "concept check",
      "source_section": "Section title"
    }
  },
  {
    "question_type": "short_answer",
    "question": "Explain the difference between X and Y.",
    "options": null,
    "correct_answer": "X differs from Y in that...",
    "explanation": "The key distinction is...",
    "difficulty_layer": 2,
    "problem_metadata": {
      "core_concept": "difference between X and Y",
      "bloom_level": "analyze",
      "potential_traps": ["mixing the definitions"],
      "layer_justification": "Requires comparison rather than recall",
      "skill_focus": "comparison",
      "source_section": "Section title"
    }
  },
  {
    "question_type": "fill_blank",
    "question": "The _____ algorithm is used for finding shortest paths.",
    "options": null,
    "correct_answer": "Dijkstra's",
    "explanation": "Dijkstra's algorithm...",
    "difficulty_layer": 1,
    "problem_metadata": {
      "core_concept": "shortest path algorithms",
      "bloom_level": "remember",
      "potential_traps": [],
      "layer_justification": "Direct recall of a named algorithm",
      "skill_focus": "recall",
      "source_section": "Section title"
    }
  },
  {
    "question_type": "coding",
    "question": "Write a Python function that returns the factorial of n using recursion.",
    "options": null,
    "correct_answer": "def factorial(n):\n    if n <= 1:\n        return 1\n    return n * factorial(n - 1)",
    "explanation": "The recursive case multiplies n by factorial(n-1), with the base case returning 1 when n <= 1.",
    "difficulty_layer": 2,
    "problem_metadata": {
      "core_concept": "recursion",
      "bloom_level": "apply",
      "potential_traps": ["forgetting the base case", "not handling n=0"],
      "layer_justification": "Requires translating a mathematical definition into working code",
      "skill_focus": "implementation",
      "source_section": "Section title"
    }
  }
]
```

IMPORTANT: Output ONLY the JSON array, no other text."""

_REPAIR_PROMPT = """You are repairing ONE invalid practice question so it can be safely saved.

Return ONLY one valid JSON object using the shared schema:
{
  "question_type": "...",
  "question": "...",
  "options": {"A": "...", "B": "...", "C": "...", "D": "..."} | null,
  "correct_answer": "...",
  "explanation": "...",
  "difficulty_layer": 1 | 2 | 3,
  "problem_metadata": {
    "core_concept": "...",
    "bloom_level": "remember|understand|apply|analyze|evaluate|create",
    "potential_traps": [],
    "layer_justification": "...",
    "skill_focus": "...",
    "source_section": "..."
  }
}

Rules:
- Fix only the validation issues called out below.
- Keep the question grounded in the provided source excerpt.
- For `mc`, provide exactly 4 options and ensure `correct_answer` is one option label.
- For `tf`, use `True` or `False`.
- Always provide a non-empty `correct_answer` and `explanation`.
- Never add commentary outside the JSON object."""

_SHORT_CONTENT_THRESHOLD = 500
_MIN_VALID_QUESTIONS_SHORT = 1
_MIN_VALID_QUESTIONS_DEFAULT = 2
_MAX_NODE_ERRORS = 5
_QUESTION_TYPE_SHARE_CAP = 0.6
_QUESTION_TYPE_MIN_CAP = 2
_SIMILARITY_DUPLICATE_THRESHOLD = 0.85
_TRUE_FALSE_BATCH_CAP = 1
_FOUNDATION_SHARE_CAP = 0.4

_PROGRAMMING_SOURCE_RE = re.compile(
    r"(?:python|javascript|typescript|java|c\+\+|编程|程序设计|代码|函数定义|"
    r"算法实现|数据结构|递归程序|class\s+\w+|def\s+\w+\s*\(|console\.log|print\s*\()",
    re.IGNORECASE,
)


def source_supports_coding(title: str, content: str) -> bool:
    """Return whether the lesson itself explicitly teaches programming."""
    source = f"{title}\n{content[:6000]}"
    return bool(_PROGRAMMING_SOURCE_RE.search(source))


@dataclass
class QuizNodeFailure:
    title: str
    reason: str
    node_id: str | None = None
    discarded_count: int = 0
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "title": self.title,
            "reason": self.reason,
            "discarded_count": self.discarded_count,
            "errors": self.errors,
        }


@dataclass
class QuizExtractionOutcome:
    problems: list[PracticeProblem] = field(default_factory=list)
    validated_count: int = 0
    repaired_count: int = 0
    discarded_count: int = 0
    warnings: list[str] = field(default_factory=list)
    node_failures: list[QuizNodeFailure] = field(default_factory=list)

    def extend(self, other: "QuizExtractionOutcome") -> None:
        self.problems.extend(other.problems)
        self.validated_count += other.validated_count
        self.repaired_count += other.repaired_count
        self.discarded_count += other.discarded_count
        self.warnings.extend(other.warnings)
        self.node_failures.extend(other.node_failures)


def cap_question_batch(questions: list[Any], *, title: str) -> tuple[list[Any], int, list[str]]:
    """Enforce the learner-facing batch limit at every persistence boundary."""
    if len(questions) <= MAX_GENERATED_QUESTIONS:
        return questions, 0, []
    discarded = len(questions) - MAX_GENERATED_QUESTIONS
    return (
        questions[:MAX_GENERATED_QUESTIONS],
        discarded,
        [f"Kept the first {MAX_GENERATED_QUESTIONS} validated questions for {title}; {discarded} excess question(s) were not added."],
    )


@dataclass
class _PreparedQuestionBatch:
    questions: list[dict[str, Any]] = field(default_factory=list)
    repaired_count: int = 0
    discarded_count: int = 0
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def _normalize_problem_metadata(
    question: dict,
    *,
    title: str,
) -> tuple[int | None, dict]:
    normalized = normalize_problem_annotation(question, title=title, source="extracted")
    return normalized["difficulty_layer"], normalized["problem_metadata"]


_MODE_QUIZ_HINTS: dict[str, str] = {
    "exam_prep": "\n\nMode: EXAM PREP — Bias toward Layer 2-3 difficulty. Include time estimates per question. Prefer application and analysis questions.",
    "maintenance": "\n\nMode: MAINTENANCE — Only generate questions about previously-covered core concepts. Focus on retention and recall.",
    "self_paced": "\n\nMode: SELF-PACED — Include open-ended and cross-topic questions. Encourage deeper exploration.",
    "course_following": "\n\nMode: COURSE FOLLOWING — Strictly follow the provided content. Only test concepts explicitly covered in the material.",
}

_DIFFICULTY_HINTS: dict[str, str] = {
    "easy": "\n\nDifficulty: EASY — Mostly Layer 1-2 questions. Focus on core definitions and basic checks.",
    "medium": "\n\nDifficulty: MEDIUM — Balanced Layer 1-3 mix. Emphasize applied understanding.",
    "hard": "\n\nDifficulty: HARD — Bias strongly toward Layer 2-3. Include tricky distractors and transfer scenarios.",
}


def _minimum_valid_questions(content: str) -> int:
    if len(content.strip()) <= _SHORT_CONTENT_THRESHOLD:
        return _MIN_VALID_QUESTIONS_SHORT
    return _MIN_VALID_QUESTIONS_DEFAULT


def _question_token_set(text: str) -> set[str]:
    return {
        token
        for token in build_question_dedupe_key(text).split()
        if len(token) >= 3
    }


def _questions_are_too_similar(first: str, second: str) -> bool:
    first_tokens = _question_token_set(first)
    second_tokens = _question_token_set(second)
    if not first_tokens or not second_tokens:
        return False
    union = first_tokens | second_tokens
    if not union:
        return False
    overlap = len(first_tokens & second_tokens) / len(union)
    return overlap >= _SIMILARITY_DUPLICATE_THRESHOLD


def _enforce_type_balance(
    questions: list[dict[str, Any]],
    *,
    title: str,
) -> tuple[list[dict[str, Any]], int, list[str]]:
    if len(questions) < 3:
        return questions, 0, []

    max_per_type = max(_QUESTION_TYPE_MIN_CAP, math.ceil(len(questions) * _QUESTION_TYPE_SHARE_CAP))
    type_counts: dict[str, int] = {}
    kept: list[dict[str, Any]] = []
    warnings: list[str] = []
    discarded = 0

    for question in questions:
        question_type = str(question.get("question_type") or "mc")
        if type_counts.get(question_type, 0) >= max_per_type:
            discarded += 1
            warnings.append(
                f"Dropped extra {question_type} question in {title} to keep the quiz batch diverse."
            )
            continue
        type_counts[question_type] = type_counts.get(question_type, 0) + 1
        kept.append(question)

    return kept, discarded, warnings


def _enforce_quality_mix(
    questions: list[dict[str, Any]],
    *,
    title: str,
) -> tuple[list[dict[str, Any]], int, list[str]]:
    """Remove excess recognition questions before a batch enters the bank.

    Prompt instructions improve generation on average, but they are not a
    guarantee.  This deterministic gate prevents a model from filling a lesson
    with true/false or Layer-1 recall items.
    """
    if len(questions) < 3:
        return questions, 0, []

    max_foundation = max(1, math.floor(len(questions) * _FOUNDATION_SHARE_CAP))
    tf_count = 0
    foundation_count = 0
    kept: list[dict[str, Any]] = []
    warnings: list[str] = []
    discarded = 0

    for question in questions:
        question_type = str(question.get("question_type") or "")
        layer = int(question.get("difficulty_layer") or 1)
        if question_type == "tf":
            if tf_count >= _TRUE_FALSE_BATCH_CAP:
                discarded += 1
                warnings.append(f"Dropped excess true/false recognition question in {title}.")
                continue
            tf_count += 1
        if layer == 1:
            if foundation_count >= max_foundation:
                discarded += 1
                warnings.append(f"Dropped excess Layer-1 recall question in {title}.")
                continue
            foundation_count += 1
        kept.append(question)

    return kept, discarded, warnings


async def _repair_question(
    *,
    client: Any,
    question: dict[str, Any],
    title: str,
    content: str,
    errors: list[str],
    language: str | None = None,
) -> dict[str, Any] | None:
    source_excerpt = content[:3000]
    user_msg = (
        f"Title: {title}\n\n"
        f"Validation errors:\n- " + "\n- ".join(errors[:6]) + "\n\n"
        f"Source excerpt:\n{source_excerpt}\n\n"
        f"Invalid question JSON:\n{question}"
    )
    if language == "zh":
        user_msg += "\n\nLearner language: Simplified Chinese. Rewrite every learner-facing field in Chinese."
    elif language == "en":
        user_msg += "\n\nLearner language: English. Rewrite every learner-facing field in English."
    try:
        repaired_raw, _ = await client.chat(_REPAIR_PROMPT, user_msg)
    except (ConnectionError, TimeoutError, ValueError, RuntimeError) as exc:
        logger.warning("Quiz repair call failed for %s: %s", title, exc)
        return None

    repaired_questions = parse_question_array(repaired_raw)
    if repaired_questions:
        return repaired_questions[0]
    return None


async def _prepare_question_batch(
    *,
    questions: list[dict[str, Any]],
    title: str,
    content: str,
    client: Any,
    allow_repair: bool,
    language: str | None = None,
) -> _PreparedQuestionBatch:
    prepared = _PreparedQuestionBatch()
    seen_questions: set[str] = set()

    coding_allowed = source_supports_coding(title, content)
    for question in questions:
        validation = validate_question_payload(question, title=title, source="extracted", learner_language=language)
        normalized = validation.question
        errors = list(validation.errors)
        repaired = False

        if normalized and normalized.get("question_type") == "coding" and not coding_allowed:
            prepared.discarded_count += 1
            prepared.warnings.append(
                f"Dropped a coding question because {title} is not a programming lesson."
            )
            continue

        if errors and allow_repair:
            repaired_question = await _repair_question(
                client=client,
                question=question,
                title=title,
                content=content,
                errors=errors,
                language=language,
            )
            if repaired_question is not None:
                repaired_validation = validate_question_payload(
                    repaired_question,
                    title=title,
                    source="extracted",
                    learner_language=language,
                )
                normalized = repaired_validation.question
                errors = list(repaired_validation.errors)
                repaired = len(errors) == 0

        if errors or normalized is None:
            prepared.discarded_count += 1
            prepared.errors.append("; ".join(errors[:3]) if errors else "question: validation failed")
            continue

        if is_non_learning_question(normalized["question"]) or is_generic_textbook_prompt(normalized["question"]):
            prepared.discarded_count += 1
            prepared.warnings.append(f"Dropped non-lesson metadata question in {title}.")
            continue

        dedupe_key = build_question_dedupe_key(normalized["question"])
        if dedupe_key in seen_questions:
            prepared.discarded_count += 1
            prepared.warnings.append(f"Dropped duplicate question in {title}.")
            continue
        if any(
            existing.get("question_type") == normalized["question_type"]
            and _questions_are_too_similar(existing["question"], normalized["question"])
            for existing in prepared.questions
        ):
            prepared.discarded_count += 1
            prepared.warnings.append(f"Dropped near-duplicate question in {title}.")
            continue

        seen_questions.add(dedupe_key)
        prepared.questions.append(normalized)
        if repaired:
            prepared.repaired_count += 1

    prepared.questions, type_balance_discards, type_balance_warnings = _enforce_type_balance(
        prepared.questions,
        title=title,
    )
    prepared.discarded_count += type_balance_discards
    prepared.warnings.extend(type_balance_warnings)
    prepared.questions, quality_discards, quality_warnings = _enforce_quality_mix(
        prepared.questions,
        title=title,
    )
    prepared.discarded_count += quality_discards
    prepared.warnings.extend(quality_warnings)
    prepared.questions, capped, cap_warnings = cap_question_batch(prepared.questions, title=title)
    prepared.discarded_count += capped
    prepared.warnings.extend(cap_warnings)
    return prepared


async def prepare_generated_questions(
    *,
    raw_content: str,
    title: str,
) -> _PreparedQuestionBatch:
    """Validate a raw assistant quiz payload before saving a generated set."""
    questions = parse_question_array(raw_content)
    if not questions:
        return _PreparedQuestionBatch(errors=["payload: no valid question array found"])

    prepared = _PreparedQuestionBatch()
    seen_questions: set[str] = set()
    for question in questions:
        validation = validate_question_payload(question, title=title, source="generated")
        normalized = validation.question
        if validation.errors or normalized is None:
            prepared.discarded_count += 1
            prepared.errors.append("; ".join(validation.errors[:3]) if validation.errors else "question: validation failed")
            continue

        if is_non_learning_question(normalized["question"]) or is_generic_textbook_prompt(normalized["question"]):
            prepared.discarded_count += 1
            prepared.warnings.append(f"Dropped non-lesson generated question in {title}.")
            continue

        dedupe_key = build_question_dedupe_key(normalized["question"])
        if dedupe_key in seen_questions:
            prepared.discarded_count += 1
            prepared.warnings.append(f"Dropped duplicate generated question in {title}.")
            continue
        if any(
            existing.get("question_type") == normalized["question_type"]
            and _questions_are_too_similar(existing["question"], normalized["question"])
            for existing in prepared.questions
        ):
            prepared.discarded_count += 1
            prepared.warnings.append(f"Dropped near-duplicate generated question in {title}.")
            continue

        seen_questions.add(dedupe_key)
        prepared.questions.append(normalized)

    prepared.questions, type_balance_discards, type_balance_warnings = _enforce_type_balance(
        prepared.questions,
        title=title,
    )
    prepared.discarded_count += type_balance_discards
    prepared.warnings.extend(type_balance_warnings)
    prepared.questions, quality_discards, quality_warnings = _enforce_quality_mix(
        prepared.questions,
        title=title,
    )
    prepared.discarded_count += quality_discards
    prepared.warnings.extend(quality_warnings)
    prepared.questions, capped, cap_warnings = cap_question_batch(prepared.questions, title=title)
    prepared.discarded_count += capped
    prepared.warnings.extend(cap_warnings)
    return prepared


def _build_low_quality_failure(
    *,
    title: str,
    content_node_id: uuid.UUID | None,
    validated_count: int,
    required_count: int,
    discarded_count: int,
    errors: list[str],
) -> QuizNodeFailure:
    reason = (
        f"Only {validated_count} validated question(s) survived quality checks; "
        f"required at least {required_count} to save this node."
    )
    return QuizNodeFailure(
        node_id=str(content_node_id) if content_node_id else None,
        title=title,
        reason=reason,
        discarded_count=discarded_count,
        errors=errors[:_MAX_NODE_ERRORS],
    )


async def extract_questions(
    content: str,
    title: str,
    course_id: uuid.UUID,
    content_node_id: uuid.UUID | None = None,
    mode: str | None = None,
    difficulty: str | None = None,
    language: str | None = None,
    knowledge_blueprint: str | None = None,
) -> QuizExtractionOutcome:
    """Extract practice questions from content using LLM.

    Args:
        content: Text content to generate questions from
        title: Section title for context
        course_id: Course UUID
        content_node_id: Optional reference to content tree node
        mode: Learning mode hint for question generation style

    Returns:
        QuizExtractionOutcome with validated PracticeProblem objects and stats.
    """
    client = get_llm_client()

    user_msg = f"## {title}\n\n{content}"
    if knowledge_blueprint:
        user_msg += (
            "\n\n## Curriculum knowledge blueprint\n"
            f"{knowledge_blueprint}\n\n"
            "Scope rule: every question's source_anchor and core_concept must match one of "
            "these anchors. Relations may guide prerequisite or transfer questions, but must "
            "not introduce content outside the provided lesson."
        )
    if not source_supports_coding(title, content):
        user_msg += (
            "\n\nSubject constraint: this source is not a programming lesson. "
            "Do not ask the learner to write Python, code, functions, or programs. "
            "Use only multiple-choice, true/false, fill-in-the-blank, or short-answer questions."
        )
    if mode and mode in _MODE_QUIZ_HINTS:
        user_msg += _MODE_QUIZ_HINTS[mode]
    if difficulty and difficulty in _DIFFICULTY_HINTS:
        user_msg += _DIFFICULTY_HINTS[difficulty]
    if language == "zh":
        user_msg += "\n\nOutput language: Simplified Chinese. Write every learner-facing field in Chinese."
    elif language == "en":
        user_msg += "\n\nOutput language: English. Write every learner-facing field in English."
    else:
        user_msg += "\n\nOutput language: Use the same language as the source material."

    response, _ = await client.chat(
        EXTRACTION_PROMPT,
        user_msg,
    )

    questions = parse_question_array(response)
    if not questions:
        return QuizExtractionOutcome(
            warnings=[f"No parsable quiz questions were returned for {title}."],
            node_failures=[
                QuizNodeFailure(
                    node_id=str(content_node_id) if content_node_id else None,
                    title=title,
                    reason="LLM output did not contain a valid question array.",
                ),
            ],
        )

    prepared = await _prepare_question_batch(
        questions=questions,
        title=title,
        content=content,
        client=client,
        allow_repair=True,
        language=language,
    )

    validated_count = len(prepared.questions)
    minimum_valid = _minimum_valid_questions(content)
    if validated_count < minimum_valid:
        return QuizExtractionOutcome(
            validated_count=validated_count,
            repaired_count=prepared.repaired_count,
            discarded_count=prepared.discarded_count + validated_count,
            warnings=[
                f"{title}: discarded low-confidence quiz batch after validation ({validated_count}/{minimum_valid} usable questions).",
                *prepared.warnings,
            ],
            node_failures=[
                _build_low_quality_failure(
                    title=title,
                    content_node_id=content_node_id,
                    validated_count=validated_count,
                    required_count=minimum_valid,
                    discarded_count=prepared.discarded_count + validated_count,
                    errors=prepared.errors,
                ),
            ],
        )

    problems: list[PracticeProblem] = []
    for i, question in enumerate(prepared.questions):
        problem = build_practice_problem(
            course_id=course_id,
            content_node_id=content_node_id,
            title=title,
            question=question,
            order_index=i,
            source="extracted",
        )
        problems.append(problem)

    return QuizExtractionOutcome(
        problems=problems,
        validated_count=validated_count,
        repaired_count=prepared.repaired_count,
        discarded_count=prepared.discarded_count,
        warnings=prepared.warnings,
    )


async def extract_all_questions(
    nodes: list[dict],
    course_id: uuid.UUID,
) -> list[PracticeProblem]:
    """Extract questions from all content tree nodes that have content."""
    all_problems = []
    for node in nodes:
        if node.get("content") and len(node["content"]) > 100:
            outcome = await extract_questions(
                node["content"],
                node["title"],
                course_id,
                content_node_id=node.get("id"),
            )
            all_problems.extend(outcome.problems)
    return all_problems
