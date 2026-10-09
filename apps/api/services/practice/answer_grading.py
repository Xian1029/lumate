"""Safe, deterministic equivalence checks for learner numeric answers."""

from __future__ import annotations

import ast
from collections import Counter
import math
import operator
import re
import unicodedata


_UNIT_ALIASES = {
    "°c": "℃", "摄氏度": "℃", "度c": "℃",
    "千克": "kg", "公斤": "kg", "克": "g",
    "米": "m", "厘米": "cm", "毫米": "mm",
}
_UNITS = sorted(
    {"℃", "°c", "摄氏度", "度c", "元", "kg", "千克", "公斤", "g", "克",
     "km", "千米", "m", "米", "cm", "厘米", "mm", "毫米", "%", "％"},
    key=len,
    reverse=True,
)
_UNIT_SUFFIX = re.compile(rf"\s*({'|'.join(map(re.escape, _UNITS))})\s*$", re.IGNORECASE)
_ALLOWED_BINARY = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
}
_ALLOWED_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_SUPERSCRIPTS = str.maketrans({
    "⁰": "^0", "¹": "^1", "²": "^2", "³": "^3", "⁴": "^4",
    "⁵": "^5", "⁶": "^6", "⁷": "^7", "⁸": "^8", "⁹": "^9",
})

# In fill-in-the-blank questions, these expressions describe the same change
# direction.  Keep this deliberately narrow: it normalizes wording only and
# never relaxes the required number, sign, unit, or blank order.
_CHANGE_DIRECTION_ALIASES = (
    (r"(?:下降|降低|减少|下跌|变少)(?:了)?", "decrease"),
    (r"(?:上升|提高|增加|增长|变多)(?:了)?", "increase"),
)


def _safe_number(node: ast.AST) -> float:
    if isinstance(node, ast.Expression):
        return _safe_number(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    if isinstance(node, ast.UnaryOp) and type(node.op) in _ALLOWED_UNARY:
        return _ALLOWED_UNARY[type(node.op)](_safe_number(node.operand))
    if isinstance(node, ast.BinOp) and type(node.op) in _ALLOWED_BINARY:
        left, right = _safe_number(node.left), _safe_number(node.right)
        if isinstance(node.op, ast.Pow) and (abs(right) > 12 or abs(left) > 1e6):
            raise ValueError("unsafe exponent")
        return float(_ALLOWED_BINARY[type(node.op)](left, right))
    raise ValueError("not a numeric expression")


def _parse_numeric_answer(value: str) -> tuple[float, str | None] | None:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    text = text.replace("×", "*").replace("÷", "/").replace("^", "**").replace("−", "-")
    match = _UNIT_SUFFIX.search(text)
    unit = None
    if match:
        raw_unit = match.group(1).lower()
        unit = _UNIT_ALIASES.get(raw_unit, raw_unit).replace("％", "%")
        text = text[:match.start()].strip()
    # Do not pull a number out of prose: the entire remaining answer must be a
    # small arithmetic expression made only from numbers and operators.
    if not text or not re.fullmatch(r"[\d\s.+\-*/()]+", text):
        return None
    try:
        number = _safe_number(ast.parse(text, mode="eval"))
    except (SyntaxError, ValueError, TypeError, ZeroDivisionError, OverflowError):
        return None
    if not math.isfinite(number):
        return None
    return number, unit


def numeric_answers_equivalent(user_answer: str, correct_answer: str) -> bool:
    """Compare one or more numeric results with forgiving formatting.

    Multiple blanks may be separated by Chinese/ASCII commas, semicolons, or
    enumeration punctuation. Spaces between a value and its unit are ignored.
    """
    def _parts(value: str) -> list[str]:
        normalized = unicodedata.normalize("NFKC", str(value or "")).strip()
        return [part.strip() for part in re.split(r"[,;，；、\n]+", normalized) if part.strip()]

    user_parts = _parts(user_answer)
    correct_parts = _parts(correct_answer)
    if not user_parts or len(user_parts) != len(correct_parts):
        return False

    for user_text, correct_text in zip(user_parts, correct_parts):
        user = _parse_numeric_answer(user_text)
        correct = _parse_numeric_answer(correct_text)
        if not user or not correct:
            return False
        user_number, user_unit = user
        correct_number, correct_unit = correct
        if user_unit and correct_unit and user_unit != correct_unit:
            return False
        if not math.isclose(user_number, correct_number, rel_tol=1e-9, abs_tol=1e-9):
            return False
    return True


def _normalize_math_text(value: str) -> str:
    """Normalize visually equivalent math characters without changing meaning."""
    # Translate superscripts before NFKC; NFKC alone turns ``a²`` into ``a2``
    # and silently loses the exponent relationship.
    value = str(value or "").translate(_SUPERSCRIPTS)
    return (
        unicodedata.normalize("NFKC", value)
        .replace("−", "-")
        .replace("–", "-")
        .replace("—", "-")
        .replace("＋", "+")
        .replace("×", "*")
        .replace("÷", "/")
    )


def _last_numeric_value(value: str) -> float | None:
    text = _normalize_math_text(value)
    candidates = re.findall(r"(?<![\w.])[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?![\w.])", text)
    if not candidates:
        return None
    try:
        return float(candidates[-1])
    except ValueError:
        return None


def _first_step_operands(value: str) -> Counter[float]:
    """Return operand magnitudes from the learner's first displayed equation."""
    first_step = _normalize_math_text(value).split("=", 1)[0]
    numbers = re.findall(r"(?<![\w.])[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?![\w.])", first_step)
    return Counter(abs(float(number)) for number in numbers)


def arithmetic_work_equivalent(user_answer: str, correct_answer: str) -> bool:
    """Accept equivalent arithmetic working while still requiring shown work.

    This is intentionally conservative: both answers must contain an equation,
    finish at the same numeric result, and use the same original operands. It
    accepts regrouping such as ``40-30`` versus ``40+(-30)`` but does not accept
    an unrelated expression that happens to have the same result.
    """
    user = _normalize_math_text(user_answer)
    correct = _normalize_math_text(correct_answer)
    if "=" not in user or "=" not in correct:
        return False
    user_result = _last_numeric_value(user)
    correct_result = _last_numeric_value(correct)
    if user_result is None or correct_result is None:
        return False
    if not math.isclose(user_result, correct_result, rel_tol=1e-9, abs_tol=1e-9):
        return False
    user_operands = _first_step_operands(user)
    correct_operands = _first_step_operands(correct)
    return bool(user_operands) and user_operands == correct_operands


def _normalize_blank_part(value: str) -> str:
    text = _normalize_math_text(value).strip().casefold()
    # Generated references sometimes annotate an accepted alternative inline,
    # e.g. ``-28（或-28的绝对值28）``. The annotation must not become part of
    # the required learner answer.
    text = re.sub(r"[（(]\s*或.*?[）)]", "", text)
    text = re.sub(r"\s+", "", text)
    if text in {"负", "负号", "-", "minus", "negative"}:
        return "negative_sign"
    if text in {"正", "正号", "+", "plus", "positive"}:
        return "positive_sign"
    parsed = _parse_numeric_answer(text)
    if parsed:
        number, unit = parsed
        number_text = f"{number:.12g}"
        return f"number:{number_text}:{unit or ''}"
    # Learners may use equally valid everyday wording such as “下降了” where
    # the reference says “减少”.  Normalize only a small, directional synonym
    # set so mathematical content is still checked strictly below.
    for pattern, canonical in _CHANGE_DIRECTION_ALIASES:
        text = re.sub(pattern, canonical, text)
    return "".join(
        char for char in text
        if not unicodedata.category(char).startswith("P")
    )


def structured_blanks_equivalent(user_answer: str, correct_answer: str) -> bool:
    """Compare ordered multi-blank answers across punctuation and sign wording."""
    def raw_parts(value: str) -> list[str]:
        normalized = _normalize_math_text(value)
        return [part for part in re.split(r"[,，;；、\n]+", normalized) if part.strip()]

    user_parts = raw_parts(user_answer)
    correct_parts = raw_parts(correct_answer)
    if len(user_parts) < 2 or len(user_parts) != len(correct_parts):
        return False

    for user_part, correct_part in zip(user_parts, correct_parts):
        user_value = _normalize_blank_part(user_part)
        # A generated reference may contain explicit alternatives such as
        # ``+8848.86 或 8848.86``. Any one alternative is a complete answer.
        if re.search(r"[（(]\s*或", correct_part):
            alternatives = [correct_part]
        else:
            alternatives = re.split(r"\s*(?:或者|或是|或|/)\s*", correct_part)
        accepted = {_normalize_blank_part(item) for item in alternatives if item.strip()}
        if user_value not in accepted:
            return False
    return True


def signed_quantities_equivalent(user_answer: str, correct_answer: str) -> bool:
    """Compare all explicitly signed, unit-bearing quantities in prose answers."""
    unit_pattern = "|".join(map(re.escape, _UNITS))
    pattern = re.compile(
        rf"([+\-]\s*(?:\d+(?:\.\d*)?|\.\d+))\s*({unit_pattern})",
        re.IGNORECASE,
    )

    def quantities(value: str) -> Counter[tuple[float, str]]:
        normalized = _normalize_math_text(value).lower()
        result: Counter[tuple[float, str]] = Counter()
        for number, raw_unit in pattern.findall(normalized):
            unit = _UNIT_ALIASES.get(raw_unit.lower(), raw_unit.lower()).replace("％", "%")
            result[(float(number.replace(" ", "")), unit)] += 1
        return result

    user_values = quantities(user_answer)
    correct_values = quantities(correct_answer)
    # Explanations commonly repeat a quantity while showing a calculation.
    # Repetition is presentation, not an additional required answer.
    return len(user_values) >= 2 and set(user_values) == set(correct_values)


def named_quantities_with_classification_equivalent(user_answer: str, correct_answer: str) -> bool:
    """Compare labelled quantities and a non-negative classification.

    Word-problem answers are often written as one item per person/object, for
    example ``李明：1.2kg``.  Generated references frequently use a sentence
    instead (``李明增长 1.2kg``).  String or blank-by-blank matching treats
    those two valid formats as different answers.  This helper only applies
    when *both* answers contain at least two labelled, unit-bearing quantities
    and explicitly ask for a non-negative classification; numbers, units,
    labels, and the classification itself still have to agree exactly.
    """
    unit_pattern = "|".join(map(re.escape, _UNITS))
    quantity_pattern = re.compile(
        # A sign commonly follows Chinese text directly ("增长-0.5kg").
        # Only prevent embedded digits/decimals from being re-read; blocking
        # after ``\w`` would drop the minus sign and mis-parse the value.
        rf"(?<![\d.])([+\-]?\s*(?:\d+(?:\.\d*)?|\.\d+))\s*({unit_pattern})",
        re.IGNORECASE,
    )
    trailing_relation = re.compile(
        r"(?:体重)?(?:增长|增加|减少|下降|上升|变化(?:为)?|为|是|的值|值)+$"
    )

    def labelled_quantities(value: str) -> dict[str, tuple[float, str]]:
        result: dict[str, tuple[float, str]] = {}
        normalized = _normalize_math_text(value)
        for clause in re.split(r"[，,；;\n。]+", normalized):
            # The final classification clause may itself contain quantities
            # ("非负数为：1.2kg、0kg"). Those are evidence for the classifier,
            # not another named person/object.
            if "非负" in clause:
                continue
            matches = list(quantity_pattern.finditer(clause))
            if len(matches) != 1:
                continue
            match = matches[0]
            label = trailing_relation.sub("", clause[:match.start()].strip())
            label = re.sub(r"[\s:：、()（）]+", "", label)
            # This deliberately accepts a short Chinese/Latin label only.
            # Explanatory prose must not accidentally become a named item.
            if not re.fullmatch(r"[\u4e00-\u9fffA-Za-z]{1,12}", label):
                continue
            raw_number, raw_unit = match.groups()
            unit = _UNIT_ALIASES.get(raw_unit.lower(), raw_unit.lower()).replace("％", "%")
            result[label] = (float(raw_number.replace(" ", "")), unit)
        return result

    user_items = labelled_quantities(user_answer)
    correct_items = labelled_quantities(correct_answer)
    if len(user_items) < 2 or set(user_items) != set(correct_items):
        return False
    for label, (expected_number, expected_unit) in correct_items.items():
        actual_number, actual_unit = user_items[label]
        if actual_unit != expected_unit or not math.isclose(
            actual_number, expected_number, rel_tol=1e-9, abs_tol=1e-9
        ):
            return False

    # The rule is intentionally scoped to questions whose reference actually
    # asks for this classification.  A learner must state the same conclusion,
    # but can name the people/objects instead of repeating their quantities.
    if "非负" not in _normalize_math_text(correct_answer) or "非负" not in _normalize_math_text(user_answer):
        return False
    expected_nonnegative = {label for label, (number, _) in correct_items.items() if number >= 0}
    expected_nonnegative_values = {
        (number, unit) for number, unit in correct_items.values() if number >= 0
    }
    user_nonnegative: set[str] = set()
    user_nonnegative_values: set[tuple[float, str]] = set()
    # Keep commas inside the classification clause because learners commonly
    # write “非负数为：1.2kg、0kg”. Only sentence terminators/newlines split
    # the scan; the quantity regex then extracts every listed value.
    for sentence in re.split(r"(?:[。！？!?；;]+|\n+)", _normalize_math_text(user_answer)):
        if "非负" not in sentence:
            continue
        # Accept both valid classroom forms:
        #   “李明和刘伟是非负数” (labels before the classifier)
        #   “非负数为：1.2kg、0kg” (values after the classifier)
        before, after = sentence.split("非负", 1)
        user_nonnegative.update(label for label in user_items if label in before)
        for raw_number, raw_unit in quantity_pattern.findall(after):
            unit = _UNIT_ALIASES.get(raw_unit.lower(), raw_unit.lower()).replace("％", "%")
            user_nonnegative_values.add((float(raw_number.replace(" ", "")), unit))
    labels_match = bool(expected_nonnegative) and user_nonnegative == expected_nonnegative
    values_match = bool(expected_nonnegative_values) and user_nonnegative_values == expected_nonnegative_values
    return labels_match or values_match


def signed_opposite_relation_equivalent(user_answer: str, correct_answer: str) -> bool:
    """Accept a complete, equivalent explanation of signed opposite values.

    Some K12 prompts ask learners to write a signed contextual value and state
    the relation between its positive/negative counterparts.  The necessary
    facts are the signed value, both contextual sides (such as 零上/零下), and
    the opposite relation — not the exact reference sentence.
    """
    # ``\w`` includes CJK characters in Python, so use ASCII boundaries: the
    # requested value is commonly written right after Chinese prose ("为-3℃").
    number_pattern = re.compile(r"(?<![A-Za-z0-9.])([+\-]\s*(?:\d+(?:\.\d*)?|\.\d+))")
    user = _normalize_math_text(user_answer)
    correct = _normalize_math_text(correct_answer)
    if "相反" not in user or "相反" not in correct:
        return False
    for contextual_side in ("零上", "零下"):
        if contextual_side in correct and contextual_side not in user:
            return False
    expected_values = number_pattern.findall(correct)
    actual_values = number_pattern.findall(user)
    if not expected_values or not actual_values:
        return False
    try:
        # The first signed value is the requested contextual value.  We do not
        # compare illustrative values later in the explanation (e.g. +3/-3).
        return math.isclose(
            float(actual_values[0].replace(" ", "")),
            float(expected_values[0].replace(" ", "")),
            rel_tol=1e-9,
            abs_tol=1e-9,
        )
    except ValueError:
        return False


def algebraic_expressions_equivalent(user_answer: str, correct_answer: str) -> bool:
    """Accept visually different spellings of the same simple algebraic form.

    This deliberately does not perform arbitrary symbolic execution. It covers
    the notation variants learners can type on an ordinary keyboard, including
    ``a^2/b`` versus ``a²/b`` and optional multiplication signs/spaces.
    """
    def canonical(value: str) -> str:
        text = _normalize_math_text(value).casefold()
        text = text.replace("**", "^").replace("·", "*")
        text = re.sub(r"\s+", "", text)
        text = re.sub(r"(?<=[0-9a-z)])\*(?=[0-9a-z(])", "", text)
        text = text.replace("{", "(").replace("}", ")")
        while text.startswith("(") and text.endswith(")"):
            text = text[1:-1]
        return text

    user = canonical(user_answer)
    correct = canonical(correct_answer)
    if not user or not correct:
        return False
    if not re.fullmatch(r"[0-9a-z+\-*/^().]+", user + correct):
        return False
    return user == correct
