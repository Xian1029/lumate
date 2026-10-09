"""Unified answer grading domain service (answer-grader-v2).

Every correctness decision in the product goes through ``grade_answer``:
practice submit, wrong-answer retry, and any future surface.  The frontend
never decides ``is_correct`` itself.

Layered strategy per blank (first hit wins):

1. EXACT — raw string equality after trimming.
2. NORMALIZED_EXACT — equal after full normalization (Unicode math signs,
   full/half width, CJK/ASCII punctuation, whitespace) or after the small
   deterministic synonym normalisation (direction words, accepted variants,
   guarded containment with numeric + direction + negation checks).
3. NUMERIC_EQUIVALENT — both sides parse as numbers (units reconciled) and
   are mathematically equal within the configured tolerance.
4. SEMANTIC_EQUIVALENT — LLM verdict for text blanks when rules cannot
   decide; structured output, never free text parsing.
5. NEEDS_REVIEW — the grader cannot decide with confidence.  A NEEDS_REVIEW
   answer is **never** auto-marked wrong and never pollutes WrongAnswer /
   Mastery / Weakness.

Multi-blank answers are graded blank-by-blank; the whole answer is never
compared as one concatenated string.
"""

from __future__ import annotations

import enum
import logging
import math
import re
import unicodedata
from fractions import Fraction
from dataclasses import dataclass, field
from typing import Any, Optional

from services.practice.answer_grading import (
    _parse_numeric_answer,
    algebraic_expressions_equivalent,
    arithmetic_work_equivalent,
    named_quantities_with_classification_equivalent,
    signed_opposite_relation_equivalent,
    signed_quantities_equivalent,
)

logger = logging.getLogger(__name__)

GRADER_VERSION = "answer-grader-v2"

# Default numeric tolerance; a question's answerConfig.tolerance overrides it.
_DEFAULT_REL_TOL = 1e-9
_DEFAULT_ABS_TOL = 1e-9

_BLANK_SPLIT = re.compile(r"[,，;；、\n]+")

# Direction words must agree between student and reference; a conflict is an
# automatic mismatch even when every number lines up.
_DIRECTION_CLASSES = (
    (re.compile(r"下降|降低|减少|下跌|变少|decrease|decline|drop|reduce", re.IGNORECASE), "decrease"),
    (re.compile(r"上升|提高|增加|增长|变多|increase|rise|grow|raise", re.IGNORECASE), "increase"),
)
_NEGATION_TOKENS = ("不", "没", "无", "非")
_NEGATION_RE = re.compile(r"\b(?:not|never|no)\b", re.IGNORECASE)

_TRUE_SYNONYMS = frozenset([
    "true", "t", "yes", "y", "correct", "right", "positive", "1",
    "正确", "对", "是", "对的", "是的", "真",
])
_FALSE_SYNONYMS = frozenset([
    "false", "f", "no", "n", "wrong", "incorrect", "negative", "0",
    "错误", "不对", "错", "否", "不是", "错的", "假的", "假", "荒谬",
])


class MatchType(str, enum.Enum):
    EXACT = "EXACT"
    NORMALIZED_EXACT = "NORMALIZED_EXACT"
    NUMERIC_EQUIVALENT = "NUMERIC_EQUIVALENT"
    STRUCTURED_EQUIVALENT = "STRUCTURED_EQUIVALENT"
    SEMANTIC_EQUIVALENT = "SEMANTIC_EQUIVALENT"
    PARTIALLY_CORRECT = "PARTIALLY_CORRECT"
    INCORRECT = "INCORRECT"
    NEEDS_REVIEW = "NEEDS_REVIEW"


#: Match types that count as a correct answer.
CORRECT_MATCH_TYPES = frozenset({
    MatchType.EXACT,
    MatchType.NORMALIZED_EXACT,
    MatchType.NUMERIC_EQUIVALENT,
    MatchType.STRUCTURED_EQUIVALENT,
    MatchType.SEMANTIC_EQUIVALENT,
})

#: Match types allowed to create WrongAnswer rows / Mastery penalties.
#: NEEDS_REVIEW is deliberately excluded — uncertain verdicts stay neutral.
PENALTY_MATCH_TYPES = frozenset({
    MatchType.INCORRECT,
})

# Ranked from strongest to weakest evidence, for whole-answer aggregation.
_MATCH_RANK = {
    MatchType.EXACT: 0,
    MatchType.NORMALIZED_EXACT: 1,
    MatchType.NUMERIC_EQUIVALENT: 2,
    MatchType.STRUCTURED_EQUIVALENT: 3,
    MatchType.SEMANTIC_EQUIVALENT: 4,
    MatchType.PARTIALLY_CORRECT: 5,
    MatchType.NEEDS_REVIEW: 6,
    MatchType.INCORRECT: 7,
}


@dataclass
class BlankResult:
    index: int
    student: str
    expected: str
    match_type: MatchType
    is_correct: bool
    confidence: float
    reason: str
    semantic_used: bool = False


@dataclass
class GradingResult:
    is_correct: bool
    score: float
    match_type: MatchType
    confidence: float
    normalized_student_answer: str
    normalized_expected_answer: str
    reason: str
    per_blank_results: list[dict[str, Any]] = field(default_factory=list)
    semantic_grading_used: bool = False
    grader_version: str = GRADER_VERSION

    @property
    def penalty_allowed(self) -> bool:
        """Only clear failures may write WrongAnswer / lower Mastery."""
        return self.match_type in PENALTY_MATCH_TYPES

    @property
    def needs_review(self) -> bool:
        return self.match_type == MatchType.NEEDS_REVIEW

    def evidence(self) -> dict[str, Any]:
        """Compact, auditable grading evidence for persistence."""
        return {
            "match_type": self.match_type.value,
            "confidence": round(self.confidence, 4),
            "reason": self.reason,
            "score": round(self.score, 4),
            "per_blank_results": self.per_blank_results,
            "semantic_grading_used": self.semantic_grading_used,
            "grader_version": self.grader_version,
        }


# ---------------------------------------------------------------------------
# Layer 1 — normalization
# ---------------------------------------------------------------------------

_MATH_SIGN_TRANSLATION = str.maketrans({
    "−": "-",  # U+2212 minus
    "﹣": "-",  # small minus
    "－": "-",  # fullwidth hyphen-minus
    "–": "-",  # en dash
    "—": "-",  # em dash
    "＋": "+",  # fullwidth plus
    "％": "%",  # fullwidth percent
})


def normalize_answer(value: Any) -> str:
    """Unified normalizer: Unicode math signs, full/half width, whitespace."""
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = text.translate(_MATH_SIGN_TRANSLATION)
    return re.sub(r"\s+", " ", text).strip()


def _canonical_text(value: Any) -> str:
    """Aggressive canonical form: no punctuation, no whitespace, case-folded."""
    text = normalize_answer(value).casefold()
    return "".join(
        char for char in text
        if not char.isspace() and not unicodedata.category(char).startswith("P")
    )


def _direction_class(value: str) -> Optional[str]:
    for pattern, name in _DIRECTION_CLASSES:
        if pattern.search(value):
            return name
    return None


def _has_negation(canonical: str, raw: str) -> bool:
    return any(token in canonical for token in _NEGATION_TOKENS) or bool(_NEGATION_RE.search(raw))


def _numbers_in(value: str) -> list[float]:
    text = normalize_answer(value)
    # Use ASCII-only boundaries: in Python ``\w`` also matches CJK characters,
    # which would hide numbers sitting next to Chinese text (e.g. "减少8%").
    found = re.findall(r"(?<![A-Za-z0-9.])[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?![A-Za-z0-9.])", text)
    result: list[float] = []
    for item in found:
        try:
            result.append(float(item))
        except ValueError:
            continue
    return result


# Relation/classification answers are sets, not prose.  These aliases describe
# the mathematical buckets and deliberately do not encode any particular
# question, course, or chapter.
_RELATION_LABELS = {
    "LEFT": ("左侧", "左边", "负半轴", "left"),
    "RIGHT": ("右侧", "右边", "正半轴", "right"),
    "ORIGIN": ("原点", "origin", "零点"),
}

_RELATION_NUMBER = r"[+-]?(?:\d+\s*/\s*\d+|\d+(?:\.\d+)?|\.\d+)"
_RELATION_NUMBER_LIST = rf"{_RELATION_NUMBER}(?:\s*(?:、|,|，|和|及|与)\s*{_RELATION_NUMBER})*"

# Travel-direction corrections are a common K12 free-response pattern: the
# learner first quotes an incorrect unsigned value and then supplies the
# corrected signed value.  Treating the whole prose as a bag of numbers makes
# a correct answer look inconsistent, so it needs a deterministic parser.
_TRAVEL_DIRECTION = re.compile(r"向\s*(左|右)(?:走|移动|方向)?|\b(left|right)\b", re.IGNORECASE)
_CORRECTION_MARKER = re.compile(
    r"(?:正确(?:的)?(?:表示|答案|写法)?|应该?|应当?|应(?:改为|写作|记作|为)|改为|改成|记作)"
    r"\s*[:：]?",
    re.IGNORECASE,
)
_SIGNED_DISTANCE = re.compile(
    r"([+-]\s*(?:\d+(?:\.\d*)?|\.\d+))\s*(米|m|km|千米|厘米|cm|毫米|mm)\b",
    re.IGNORECASE,
)


def _travel_direction(value: str) -> Optional[str]:
    matches = list(_TRAVEL_DIRECTION.finditer(normalize_answer(value)))
    if not matches:
        return None
    # Explanations often state the sign convention first ("向右为正") and
    # the requested movement second. The last direction is the one attached
    # to the answer being evaluated.
    match = matches[-1]
    side = (match.group(1) or match.group(2) or "").casefold()
    return "left" if side in {"左", "left"} else "right"


def _direction_correction_equivalent(student: str, expected: str) -> bool:
    """Match an explicit correction of a signed travel distance.

    Both answers must identify the same direction, the learner must use a
    correction marker, and the final explicitly signed distance must equal the
    reference. Unsigned numbers before the marker are the quoted mistake and
    are deliberately ignored.
    """
    student_text = normalize_answer(student)
    expected_text = normalize_answer(expected)
    student_direction = _travel_direction(student_text)
    expected_direction = _travel_direction(expected_text)
    if not student_direction or student_direction != expected_direction:
        return False
    marker = _CORRECTION_MARKER.search(student_text)
    if not marker:
        return False
    student_signed = list(_SIGNED_DISTANCE.finditer(student_text[marker.end():]))
    expected_signed = list(_SIGNED_DISTANCE.finditer(expected_text))
    if not student_signed or not expected_signed:
        return False
    student_match = student_signed[-1]
    expected_match = expected_signed[-1]
    try:
        student_number = float(student_match.group(1).replace(" ", ""))
        expected_number = float(expected_match.group(1).replace(" ", ""))
    except ValueError:
        return False
    if not math.isclose(student_number, expected_number, rel_tol=_DEFAULT_REL_TOL, abs_tol=_DEFAULT_ABS_TOL):
        return False
    if student_direction == "left" and student_number >= 0:
        return False
    if student_direction == "right" and student_number <= 0:
        return False
    return True


def _relation_bucket(label: str) -> Optional[str]:
    """Map a learner-facing position label to its mathematical bucket."""
    value = normalize_answer(label).casefold()
    for bucket, aliases in _RELATION_LABELS.items():
        if any(alias in value for alias in aliases):
            return bucket
    return None


def _relation_values(value: str) -> Optional[frozenset[Fraction]]:
    """Read the ordered/unordered numeric members of one position group."""
    tokens = re.findall(_RELATION_NUMBER, value)
    if not tokens:
        return None
    try:
        return frozenset(Fraction(token.replace(" ", "")) for token in tokens)
    except (ValueError, ZeroDivisionError):
        return None


def _parse_relation_sets(value: str) -> Optional[dict[str, frozenset[Fraction]]]:
    """Parse labelled classification prose into canonical mathematical sets.

    A parser is only considered applicable when all recognised labels are
    present.  This prevents ordinary prose from accidentally being treated as
    a classification exercise.
    """
    # Keep line breaks here: they are meaningful group separators in a
    # classification answer. ``normalize_answer`` intentionally collapses all
    # whitespace for ordinary blanks, so it is too aggressive for this parser.
    text = unicodedata.normalize("NFKC", str(value or "")).translate(_MATH_SIGN_TRANSLATION).casefold()
    parsed: dict[str, frozenset[Fraction]] = {}

    # Learners naturally write one group per line, while generated reference
    # answers commonly use semicolons.  Interpret each complete group before
    # looking for a label.  This avoids treating the ``原点`` inside
    # ``原点左侧`` / ``原点右侧`` as an independent ORIGIN label.
    for segment in re.split(r"[;\n]+", text):
        segment = segment.strip()
        if not segment:
            continue
        bucket = _relation_bucket(segment)
        if bucket is None:
            continue
        # A side label takes precedence over the shared word "原点".
        if any(alias in segment for alias in _RELATION_LABELS["LEFT"]):
            bucket = "LEFT"
        elif any(alias in segment for alias in _RELATION_LABELS["RIGHT"]):
            bucket = "RIGHT"
        elif not any(alias in segment for alias in _RELATION_LABELS["ORIGIN"]):
            continue
        members = _relation_values(segment)
        if members is not None:
            parsed[bucket] = members
    if len(parsed) >= 2:
        return parsed

    # References generated for the same question often use a natural sentence
    # instead of field labels: "3、0.5 在原点右侧；-4 在原点左侧；0 在原点".
    # This is the same classification task, so compare the mathematical sets,
    # not the incidental sentence order or wording.  Require at least two
    # explicit groups so ordinary prose cannot be mistaken for a classifier.
    trailing_patterns = (
        ("RIGHT", re.compile(rf"({_RELATION_NUMBER_LIST})\s*(?:在)?\s*(?:原点)?\s*(?:右侧|右边|正半轴)")),
        ("LEFT", re.compile(rf"({_RELATION_NUMBER_LIST})\s*(?:在)?\s*(?:原点)?\s*(?:左侧|左边|负半轴)")),
        ("ORIGIN", re.compile(rf"({_RELATION_NUMBER_LIST})\s*(?:就)?\s*在\s*(?:原点|零点)(?!\s*(?:左侧|左边|右侧|右边))")),
    )
    for bucket, pattern in trailing_patterns:
        match = pattern.search(text)
        if not match:
            continue
        members = _relation_values(match.group(1))
        if members is not None:
            parsed[bucket] = members
    return parsed if len(parsed) >= 2 else None


def _structured_relation_match(student: str, expected: str) -> Optional[bool]:
    student_sets = _parse_relation_sets(student)
    expected_sets = _parse_relation_sets(expected)
    if student_sets is None or expected_sets is None:
        return None
    return student_sets == expected_sets


# ---------------------------------------------------------------------------
# Answer config
# ---------------------------------------------------------------------------

def _answer_config(raw: Any) -> dict[str, Any]:
    """Normalise a question's answerConfig dict (from problem_metadata)."""
    config = raw if isinstance(raw, dict) else {}
    accepted = config.get("acceptedAnswers") or config.get("accepted_answers") or []
    return {
        "answer_kind": str(config.get("answerKind") or config.get("answer_kind") or "").upper(),
        "accepted_answers": [str(item) for item in accepted if str(item).strip()],
        "allow_semantic": bool(config.get("allowSemanticMatch", config.get("allow_semantic_match", True))),
        "tolerance": config.get("tolerance"),
        "case_sensitive": bool(config.get("caseSensitive", config.get("case_sensitive", False))),
    }


def _reference_variants(reference: str, config: dict[str, Any]) -> list[str]:
    """All accepted variants for one blank: '或' alternatives + acceptedAnswers."""
    variants = [reference]
    if not re.search(r"[（(]\s*或", reference):
        variants.extend(
            part for part in re.split(r"\s*(?:或者|或是|或|/)\s*", reference) if part.strip()
        )
    variants.extend(config["accepted_answers"])
    seen: set[str] = set()
    unique: list[str] = []
    for item in variants:
        key = item.strip()
        if key and key not in seen:
            seen.add(key)
            unique.append(key)
    return unique


# ---------------------------------------------------------------------------
# Layer 2/3 — deterministic single-blank checks
# ---------------------------------------------------------------------------

def _numeric_match(student: str, expected: str, config: dict[str, Any]) -> Optional[bool]:
    """Return True/False when both sides parse numerically, else None."""
    student_parsed = _parse_numeric_answer(student)
    expected_parsed = _parse_numeric_answer(expected)
    if not student_parsed or not expected_parsed:
        return None
    s_number, s_unit = student_parsed
    e_number, e_unit = expected_parsed
    # A unit stated on both sides must agree; a unit omitted by the learner is
    # forgiven when the stem/blank already carries it.
    if s_unit and e_unit and s_unit != e_unit:
        return False
    tol = config.get("tolerance")
    if isinstance(tol, (int, float)) and tol > 0:
        return math.isclose(s_number, e_number, rel_tol=float(tol), abs_tol=float(tol))
    return math.isclose(s_number, e_number, rel_tol=_DEFAULT_REL_TOL, abs_tol=_DEFAULT_ABS_TOL)


def _guarded_containment(student: str, expected: str) -> bool:
    """Reference content may appear inside a fuller learner phrasing.

    Guards keep this strict: numeric values must match exactly, direction
    words must not conflict, and negation polarity must be identical — so
    “温度下降0.8%” matches “减少0.8%” but “增加0.8%” never does.
    """
    student_alias = _apply_direction_aliases(_canonical_text(student))
    expected_alias = _apply_direction_aliases(_canonical_text(expected))
    if not expected_alias or len(expected_alias) < 2 or expected_alias not in student_alias:
        return False
    s_numbers = _numbers_in(student)
    e_numbers = _numbers_in(expected)
    if len(s_numbers) != len(e_numbers):
        return False
    if any(not math.isclose(s, e, rel_tol=_DEFAULT_REL_TOL, abs_tol=_DEFAULT_ABS_TOL) for s, e in zip(s_numbers, e_numbers)):
        return False
    s_dir = _direction_class(normalize_answer(student))
    e_dir = _direction_class(normalize_answer(expected))
    if s_dir and e_dir and s_dir != e_dir:
        return False
    return _has_negation(_canonical_text(student), normalize_answer(student)) == _has_negation(
        _canonical_text(expected), normalize_answer(expected)
    )


_DIRECTION_ALIAS_SUBS = (
    (re.compile(r"(?:下降|降低|减少|下跌|变少)(?:了)?"), "decrease"),
    (re.compile(r"(?:上升|提高|增加|增长|变多)(?:了)?"), "increase"),
)


def _apply_direction_aliases(canonical: str) -> str:
    for pattern, name in _DIRECTION_ALIAS_SUBS:
        canonical = pattern.sub(name, canonical)
    return canonical


def _deterministic_blank_match(student: str, expected: str, config: dict[str, Any]) -> Optional[BlankResult]:
    """Run layers 1-3 for one blank.  None → needs semantic / review."""
    index = 0
    s_raw = str(student or "").strip()
    e_raw = str(expected or "").strip()
    if not s_raw or not e_raw:
        return BlankResult(index, s_raw, e_raw, MatchType.INCORRECT, False, 1.0, "空答案")

    # Layer: exact string equality.
    if s_raw == e_raw:
        return BlankResult(index, s_raw, e_raw, MatchType.EXACT, True, 1.0, "完全一致")

    # Layer: numeric equivalence (never string-compare numbers).
    numeric = _numeric_match(s_raw, e_raw, config)
    if numeric is True:
        return BlankResult(index, s_raw, e_raw, MatchType.NUMERIC_EQUIVALENT, True, 1.0, "数值等价")
    if numeric is False:
        # Both sides are numeric but differ (wrong value/sign/unit): clearly wrong.
        return BlankResult(index, s_raw, e_raw, MatchType.INCORRECT, False, 1.0, "数值不一致")

    # Layer: accepted variants + canonical equality + guarded containment.
    for variant in _reference_variants(e_raw, config):
        if s_raw == variant.strip():
            return BlankResult(index, s_raw, e_raw, MatchType.EXACT, True, 1.0, "匹配可接受答案")
        if _canonical_text(s_raw) == _canonical_text(variant):
            return BlankResult(index, s_raw, e_raw, MatchType.NORMALIZED_EXACT, True, 0.99, "规范化后一致")
        if _apply_direction_aliases(_canonical_text(s_raw)) == _apply_direction_aliases(_canonical_text(variant)):
            return BlankResult(index, s_raw, e_raw, MatchType.NORMALIZED_EXACT, True, 0.97, "同义表达（方向词归一）")
        if _guarded_containment(s_raw, variant):
            return BlankResult(index, s_raw, e_raw, MatchType.NORMALIZED_EXACT, True, 0.95, "包含参考答案要点且数值/方向一致")

    # Sign-only answers (“负”, “-”, “negative”).
    sign_map = {"负", "负号", "-", "minus", "negative", "正", "正号", "+", "plus", "positive"}
    s_canon = _canonical_text(s_raw)
    e_canon = _canonical_text(e_raw)
    if s_canon in sign_map or e_canon in sign_map:
        negative = {"负", "负号", "-", "minus", "negative"}
        if (s_canon in negative) == (e_canon in negative) and (s_canon in sign_map) and (e_canon in sign_map):
            return BlankResult(index, s_raw, e_raw, MatchType.NORMALIZED_EXACT, True, 0.99, "正负号表达一致")
        return BlankResult(index, s_raw, e_raw, MatchType.INCORRECT, False, 1.0, "正负号不一致")

    # Layer: deterministic *mismatch* detection.  A direction conflict or a
    # key-number difference in otherwise parallel phrasing is clearly wrong —
    # these must never reach the LLM (and must never be forgiven by it).
    s_dir = _direction_class(normalize_answer(s_raw))
    e_dir = _direction_class(normalize_answer(e_raw))
    if s_dir and e_dir and s_dir != e_dir:
        return BlankResult(index, s_raw, e_raw, MatchType.INCORRECT, False, 1.0, "方向与参考答案相反")
    s_numbers = _numbers_in(s_raw)
    e_numbers = _numbers_in(e_raw)
    if s_numbers and e_numbers and len(s_numbers) == len(e_numbers) and any(
        not math.isclose(s, e, rel_tol=_DEFAULT_REL_TOL, abs_tol=_DEFAULT_ABS_TOL)
        for s, e in zip(s_numbers, e_numbers)
    ):
        strip_num = lambda t: re.sub(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", "#", t)  # noqa: E731
        if strip_num(_apply_direction_aliases(_canonical_text(s_raw))) == strip_num(
            _apply_direction_aliases(_canonical_text(e_raw))
        ):
            return BlankResult(index, s_raw, e_raw, MatchType.INCORRECT, False, 1.0, "关键数值与参考答案不一致")

    return None


# ---------------------------------------------------------------------------
# Layer 4 — semantic grading
# ---------------------------------------------------------------------------

async def _semantic_blank_match(
    student: str,
    expected: str,
    *,
    question_context: Optional[dict[str, Any]],
) -> BlankResult:
    from services.practice.semantic_grading import grade_blank_semantic

    verdict = await grade_blank_semantic(
        expected_answer=expected,
        student_answer=student,
        question=(question_context or {}).get("question"),
        knowledge_point=(question_context or {}).get("knowledge_point"),
    )
    if verdict is None:
        return BlankResult(0, student, expected, MatchType.NEEDS_REVIEW, False, 0.0, "语义判题不可用，需人工复核", semantic_used=True)
    is_correct = bool(verdict.get("is_correct"))
    confidence = float(verdict.get("confidence") or 0.0)
    reason = str(verdict.get("reason") or "")
    if is_correct and confidence >= 0.6:
        return BlankResult(0, student, expected, MatchType.SEMANTIC_EQUIVALENT, True, confidence, reason or "语义等价", semantic_used=True)
    if not is_correct and confidence >= 0.75:
        return BlankResult(0, student, expected, MatchType.INCORRECT, False, confidence, reason or "语义不一致", semantic_used=True)
    return BlankResult(0, student, expected, MatchType.NEEDS_REVIEW, False, confidence, reason or "语义判题置信度不足", semantic_used=True)


# ---------------------------------------------------------------------------
# Whole-answer entry point
# ---------------------------------------------------------------------------

def _split_blanks(value: str) -> list[str]:
    return [part.strip() for part in _BLANK_SPLIT.split(str(value or "").strip()) if part.strip()]


def _grade_objective(question_type: str, student: str, expected: str, options: Any) -> GradingResult:
    """MC / select-all / matching / true-false: deterministic only."""
    s_norm = normalize_answer(student)
    e_text = _option_text(expected, options)
    e_norm = normalize_answer(e_text)

    def _key_set(value: str) -> str:
        parts = [p.strip().upper() for p in re.split(r"[,\s，、;；]+", value) if p.strip()]
        return ",".join(sorted(parts))

    qt = question_type.lower()
    if qt in ("tf", "true_false", "boolean", "bool"):
        s_bool = _bool_synonym(s_norm)
        e_bool = _bool_synonym(e_norm)
        if s_bool and e_bool:
            correct = s_bool == e_bool
            return _single_result(correct, MatchType.EXACT if correct else MatchType.INCORRECT,
                                  s_norm, e_norm, "判断一致" if correct else "判断相反")
        correct = _canonical_text(s_norm) == _canonical_text(e_norm)
        return _single_result(correct, MatchType.NORMALIZED_EXACT if correct else MatchType.INCORRECT,
                              s_norm, e_norm, "判断文本一致" if correct else "判断文本不一致")

    e_raw_norm = normalize_answer(expected)
    # Label-vs-label first ("A" == "A"), then label-vs-resolved-text for
    # legacy questions rendered as text inputs.
    if _key_set(s_norm) == _key_set(e_raw_norm):
        return _single_result(True, MatchType.EXACT, s_norm, e_raw_norm, "选项一致")
    if e_norm != e_raw_norm and _key_set(s_norm) == _key_set(e_norm):
        return _single_result(True, MatchType.NORMALIZED_EXACT, s_norm, e_norm, "匹配选项文本")
    if e_text != e_raw_norm and _canonical_text(s_norm) == _canonical_text(e_text):
        return _single_result(True, MatchType.NORMALIZED_EXACT, s_norm, e_norm, "匹配选项文本")
    return _single_result(False, MatchType.INCORRECT, s_norm, e_norm, "选项不一致")


def _bool_synonym(value: str) -> Optional[str]:
    cand = value.strip().lower()
    if cand in _TRUE_SYNONYMS:
        return "True"
    if cand in _FALSE_SYNONYMS:
        return "False"
    stripped = _canonical_text(value)
    if stripped in _TRUE_SYNONYMS:
        return "True"
    if stripped in _FALSE_SYNONYMS:
        return "False"
    return None


def _option_text(expected: Any, options: Any) -> str:
    answer = normalize_answer(expected)
    if not answer or not isinstance(options, dict):
        return answer
    for key, value in options.items():
        if answer.casefold() == str(key).strip().casefold():
            return normalize_answer(value)
    return answer


def _single_result(correct: bool, match_type: MatchType, s_norm: str, e_norm: str, reason: str) -> GradingResult:
    return GradingResult(
        is_correct=correct,
        score=1.0 if correct else 0.0,
        match_type=match_type,
        confidence=1.0,
        normalized_student_answer=s_norm,
        normalized_expected_answer=e_norm,
        reason=reason,
        per_blank_results=[{
            "index": 0, "student": s_norm, "expected": e_norm,
            "match_type": match_type.value, "is_correct": correct,
            "confidence": 1.0, "reason": reason, "semantic_used": False,
        }],
    )


async def grade_answer(
    *,
    question_type: str,
    student_answer: str,
    expected_answer: str,
    options: Any = None,
    answer_config: Any = None,
    question_context: Optional[dict[str, Any]] = None,
) -> GradingResult:
    """Grade one answer through the layered pipeline.

    ``answer_config`` is the question's own config (``answerKind``,
    ``acceptedAnswers``, ``allowSemanticMatch``, ``tolerance`` ...); there is
    no global tolerance.
    """
    qt = (question_type or "").lower()
    config = _answer_config(answer_config)
    s_structured = str(student_answer or "").strip()
    # Keep the raw expected answer: _grade_objective resolves option labels
    # (A/B/...) to their text internally — pre-resolving here would break
    # label-vs-label comparison.
    e_structured = str(expected_answer or "").strip()

    if qt in ("mc", "select_all", "matching", "tf", "true_false", "boolean", "bool"):
        return _grade_objective(qt, s_structured, e_structured, options)

    if not s_structured or not e_structured:
        return _single_result(False, MatchType.INCORRECT, normalize_answer(s_structured),
                              normalize_answer(e_structured), "缺少答案")

    # A direction word problem may contain both the quoted mistake and the
    # corrected signed value. Resolve that structure before generic numeric
    # mismatch detection or semantic grading.
    if _direction_correction_equivalent(s_structured, e_structured):
        return _single_result(True, MatchType.STRUCTURED_EQUIVALENT,
                              normalize_answer(s_structured), normalize_answer(e_structured),
                              "方向与正负号修正一致")

    # Structured relation/classification precedes accepted and semantic text
    # matching.  Group order, member order and incidental wording are not part
    # of the answer; bucket membership is.
    structured = _structured_relation_match(s_structured, e_structured)
    if structured is not None:
        return _single_result(
            structured,
            MatchType.STRUCTURED_EQUIVALENT if structured else MatchType.INCORRECT,
            normalize_answer(s_structured), normalize_answer(e_structured),
            "分类关系一致" if structured else "分类关系不一致",
        )

    # Structured word-problem answers may be stored as short-answer, fill-in,
    # or free-response questions.  Their mathematical truth must not depend on
    # the editor's presentation type.
    if named_quantities_with_classification_equivalent(s_structured, e_structured):
        return _single_result(True, MatchType.STRUCTURED_EQUIVALENT, normalize_answer(s_structured),
                              normalize_answer(e_structured), "对象、数值和分类结论一致")
    if signed_opposite_relation_equivalent(s_structured, e_structured):
        return _single_result(True, MatchType.STRUCTURED_EQUIVALENT, normalize_answer(s_structured),
                              normalize_answer(e_structured), "带符号数值和相反关系一致")

    # Whole-answer deterministic shortcuts for worked solutions (free_response).
    if qt == "free_response":
        if arithmetic_work_equivalent(s_structured, e_structured):
            return _single_result(True, MatchType.NUMERIC_EQUIVALENT, normalize_answer(s_structured),
                                  normalize_answer(e_structured), "演算过程与结果等价")
        if signed_quantities_equivalent(s_structured, e_structured):
            return _single_result(True, MatchType.NUMERIC_EQUIVALENT, normalize_answer(s_structured),
                                  normalize_answer(e_structured), "带符号数量一致")
        if algebraic_expressions_equivalent(s_structured, e_structured):
            return _single_result(True, MatchType.NORMALIZED_EXACT, normalize_answer(s_structured),
                                  normalize_answer(e_structured), "代数式书写等价")

    # Multi-blank: grade blank-by-blank, never as one concatenated string.
    s_blanks = _split_blanks(s_structured)
    e_blanks = _split_blanks(e_structured)
    single_blank = len(e_blanks) <= 1
    if single_blank:
        s_blanks = [s_structured]
        e_blanks = [e_structured]

    blank_results: list[BlankResult] = []
    blank_count_mismatch = not single_blank and len(s_blanks) != len(e_blanks)

    if blank_count_mismatch:
        # The learner answered a different number of blanks than required.
        return GradingResult(
            is_correct=False,
            score=0.0,
            match_type=MatchType.INCORRECT,
            confidence=1.0,
            normalized_student_answer=normalize_answer(s_structured),
            normalized_expected_answer=normalize_answer(e_structured),
            reason=f"需要 {len(e_blanks)} 个空，实际作答 {len(s_blanks)} 个",
            per_blank_results=[],
        )

    semantic_used = False
    for index, (s_blank, e_blank) in enumerate(zip(s_blanks, e_blanks)):
        result = _deterministic_blank_match(s_blank, e_blank, config)
        if result is None:
            if config["allow_semantic"]:
                result = await _semantic_blank_match(s_blank, e_blank, question_context=question_context)
                semantic_used = True
            else:
                # Disabling an LLM must not turn an otherwise indeterminate
                # natural-language response into a wrong answer.
                result = BlankResult(index, s_blank, e_blank, MatchType.NEEDS_REVIEW, False, 0.0, "未启用语义判题，需人工复核")
        result.index = index
        blank_results.append(result)

    correct_count = sum(1 for r in blank_results if r.is_correct)
    total = len(blank_results)
    score = correct_count / total if total else 0.0

    if correct_count == total:
        # The whole answer takes the *weakest* per-blank evidence.
        overall = max(blank_results, key=lambda r: _MATCH_RANK[r.match_type]).match_type
        is_correct = True
        reason = "全部作答正确" if total > 1 else blank_results[0].reason
        confidence = min(r.confidence for r in blank_results)
    elif any(r.match_type == MatchType.NEEDS_REVIEW for r in blank_results) and correct_count + sum(
        1 for r in blank_results if r.match_type == MatchType.NEEDS_REVIEW
    ) == total:
        overall = MatchType.NEEDS_REVIEW
        is_correct = False
        reason = "部分作答无法确定，需人工复核"
        confidence = min(r.confidence for r in blank_results)
    elif correct_count == 0:
        overall = MatchType.INCORRECT
        is_correct = False
        reason = blank_results[0].reason if total == 1 else "全部作答错误"
        confidence = max(r.confidence for r in blank_results)
    else:
        overall = MatchType.PARTIALLY_CORRECT
        is_correct = False
        reason = f"答对 {correct_count}/{total} 个空"
        confidence = min(1.0, max(r.confidence for r in blank_results))

    if single_blank and blank_results:
        overall = blank_results[0].match_type
        reason = blank_results[0].reason

    return GradingResult(
        is_correct=is_correct,
        score=score,
        match_type=overall,
        confidence=confidence,
        normalized_student_answer=normalize_answer(s_structured),
        normalized_expected_answer=normalize_answer(e_structured),
        reason=reason,
        per_blank_results=[
            {
                "index": r.index,
                "student": r.student,
                "expected": r.expected,
                "match_type": r.match_type.value,
                "is_correct": r.is_correct,
                "confidence": round(r.confidence, 4),
                "reason": r.reason,
                "semantic_used": r.semantic_used,
            }
            for r in blank_results
        ],
        semantic_grading_used=semantic_used or any(r.semantic_used for r in blank_results),
    )


def grade_answer_deterministic(
    *,
    question_type: str,
    student_answer: str,
    expected_answer: str,
    options: Any = None,
    answer_config: Any = None,
) -> bool:
    """Sync, rules-only wrapper kept for legacy callers (no LLM)."""
    qt = (question_type or "").lower()
    config = _answer_config(answer_config)
    s_structured = str(student_answer or "").strip()
    e_structured = str(expected_answer or "").strip()

    if qt in ("mc", "select_all", "matching", "tf", "true_false", "boolean", "bool"):
        e_structured = _option_text(expected_answer, options)
        return _grade_objective(qt, s_structured, e_structured, options).is_correct

    if not s_structured or not e_structured:
        return False
    if _direction_correction_equivalent(s_structured, e_structured):
        return True
    structured = _structured_relation_match(s_structured, e_structured)
    if structured is not None:
        return structured
    if named_quantities_with_classification_equivalent(s_structured, e_structured):
        return True
    if signed_opposite_relation_equivalent(s_structured, e_structured):
        return True
    if qt == "free_response":
        if arithmetic_work_equivalent(s_structured, e_structured):
            return True
        if signed_quantities_equivalent(s_structured, e_structured):
            return True
        if algebraic_expressions_equivalent(s_structured, e_structured):
            return True
    s_blanks = _split_blanks(s_structured)
    e_blanks = _split_blanks(e_structured)
    if len(e_blanks) <= 1:
        s_blanks, e_blanks = [s_structured], [e_structured]
    if len(s_blanks) != len(e_blanks):
        return False
    for s_blank, e_blank in zip(s_blanks, e_blanks):
        result = _deterministic_blank_match(s_blank, e_blank, config)
        if result is None or not result.is_correct:
            return False
    return True
