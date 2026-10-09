"""Normalization for text imported from external course materials.

PDF extractors occasionally emit invisible C0 control characters.  They are
valid in a database string but not in user-facing Markdown, where they show up
as garbled symbols or make otherwise valid text fail to render.
"""

import re
import unicodedata


# Keep newline and tab: both are meaningful in Markdown.  All other C0/C1
# controls are presentation noise and must never reach a course content node.
_UNSAFE_CONTROLS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_INVISIBLE_FORMATTING = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060\ufeff]")
# Marker can preserve PDF glyph IDs as private-use characters.  Those IDs only
# work with the source PDF's embedded font, so they become tofu/garbage in a
# browser and must not be stored as lesson text.
_PRIVATE_USE_GLYPHS = re.compile(r"[\ue000-\uf8ff\U000f0000-\U000ffffd\U00100000-\U0010fffd]")
_EXCESS_BLANK_LINES = re.compile(r"\n{3,}")
_CJK_SPACE = re.compile(r"(?<=[\u3400-\u4dbf\u4e00-\u9fff])[ \t\u00a0\u2000-\u200b]+(?=[\u3400-\u4dbf\u4e00-\u9fff])")
_SPACE_BEFORE_PUNCT = re.compile(r"\s+([，。！？；：、）》）】』】〉》])")
_SPACE_AFTER_OPEN = re.compile(r"([（《【『〈“‘])\s+")


def _strip_pdf_garbage_lines(value: str) -> str:
    """Drop short mixed-script glyph runs emitted by broken PDF font maps.

    A malformed embedded font can turn one decorative mark into characters
    from several unrelated Unicode scripts (for example Gujarati + Georgian +
    Lao). They are not readable source text. Real Chinese, Japanese, Russian,
    English and mathematical text uses a consistent script and is preserved.
    """
    kept: list[str] = []
    allowed_ranges = (
        (0x2E80, 0x9FFF),  # CJK and CJK punctuation
        (0x3040, 0x30FF),  # Japanese kana
        (0xAC00, 0xD7AF),  # Hangul
        (0x0400, 0x052F),  # Cyrillic
        (0x0370, 0x03FF),  # Greek
        (0x0000, 0x024F),  # Latin, digits and ASCII punctuation
        (0x2000, 0x206F),  # spaces and general punctuation
        (0x2100, 0x22FF),  # letterlike/math symbols
    )

    def is_allowed(char: str) -> bool:
        codepoint = ord(char)
        return any(start <= codepoint <= end for start, end in allowed_ranges)

    for line in value.split("\n"):
        compact = line.strip()
        if compact and len(compact) <= 48:
            letters = [char for char in compact if unicodedata.category(char).startswith("L")]
            significant = [
                char for char in compact
                if unicodedata.category(char)[0] in {"L", "M", "N", "S"}
            ]
            if letters:
                unusual = [char for char in significant if not is_allowed(char)]
                scripts = {
                    unicodedata.name(char, "UNKNOWN").split(" ")[0]
                    for char in unusual
                }
                if len(unusual) >= 2 and len(unusual) * 2 >= len(significant) and len(scripts) >= 2:
                    continue
            if compact in {"®", "©", "™", "�"}:
                continue
        kept.append(line)
    return "\n".join(kept)
_INLINE_HEADING = re.compile(r"(?<!\n)[ \t]+(#{1,6})[ \t]+")
_EMBEDDED_HEADING_IN_TITLE = re.compile(r"\s+(#{1,6})\s+(.+)")
_NUMBER_GAP = re.compile(r"(?<=[0-9０-９])\s+(?=[0-9０-９])")
_MATH_OPERATOR_GAP = re.compile(r"([+＋\-－−])\s+(?=[0-9０-９])")
_MATH_HEADING_TEXT = re.compile(
    r"^(#{1,6}\s*[+＋\-－−]?\s*[0-9０-９]+\s*[+＋\-－−]\s*[0-9０-９]+)(?=[\u4e00-\u9fff])"
)

# Bibliographic and production pages are useful as source records but are not
# learning material. They must never be used to make learner-facing quizzes or
# flashcards.
_NON_LEARNING_METADATA = re.compile(
    r"(?:出版社|出版者|主编|编著|编者|作者简介|ISBN|CIP|版权|版权所有|"
    r"责任编辑|印刷|版次|定价|图书在版编目|publisher|editor|copyright|isbn)",
    re.IGNORECASE,
)
_GENERIC_TEXTBOOK_PROMPT = re.compile(
    r"^(?:课本|教材|本节|本章|本文).{0,18}(?:介绍|提到|学习|讲了|说明).{0,28}[？?]?$"
)
_NON_BODY_HEADING = re.compile(
    r"^(?:前言与目录|目\s*录|contents?|前\s*言|序(?:言)?|引\s*言|致读者|使用说明|编写说明|"
    r"出版说明|版权页|附录|参考文献|索引|preface|foreword|introduction)$",
    re.IGNORECASE,
)
_NON_BODY_TEXT = re.compile(
    r"(?:目\s*录|contents?|前\s*言|致读者|编写说明|出版说明|图书在版编目|"
    r"版权所有|copyright|all rights reserved)",
    re.IGNORECASE,
)
_STRUCTURAL_RECALL_PROMPT = re.compile(
    r"(?:第[一二三四五六七八九十百\d]+[章节单元].{0,12}(?:标题|名称)|"
    r"(?:课本|教材).{0,16}(?:第[一二三四五六七八九十百\d]+[章节单元]).{0,12}(?:叫|名称|标题)|"
    r"(?:本书|本教材).{0,20}(?:有几[章节单元]|分为几[章节单元]))",
    re.IGNORECASE,
)


def is_body_content(title: str | None, content: str | None) -> bool:
    """Whether imported material is a teachable body section, not front matter."""
    if _NON_BODY_HEADING.match(clean_course_title(title, fallback="")):
        return False
    excerpt = clean_course_text(content) or ""
    # A real lesson can mention one such phrase; front matter/navigation pages
    # repeat multiple signals in their opening screenful.
    return bool(excerpt) and len(_NON_BODY_TEXT.findall(excerpt[:1200])) < 2


def is_assessment_content(
    title: str | None,
    content: str | None,
    *,
    content_category: str | None = None,
    level: int | None = None,
) -> bool:
    """Whether a tree node is suitable material for questions and flashcards."""
    if not content or len(content.strip()) < 80:
        return False
    if content_category in {"syllabus", "assignment", "exam_schedule", "other", "reference"}:
        return False
    if not is_body_content(title, content):
        return False
    heading = clean_course_title(title, fallback="")
    if _NON_LEARNING_METADATA.search(heading):
        return False
    # A short page dominated by publication metadata is a front/back matter
    # page. A full chapter may mention a publisher once, so do not reject it.
    excerpt = content[:1000]
    if len(content) < 1400 and len(_NON_LEARNING_METADATA.findall(excerpt)) >= 2:
        return False
    # Level-zero nodes are document containers in the imported tree. Their
    # children are the actual chapter/section sources.
    return level is None or level > 0


def is_non_learning_question(text: str | None) -> bool:
    """Reject questions about book-production metadata rather than lessons."""
    return bool(text and (_NON_LEARNING_METADATA.search(text) or _STRUCTURAL_RECALL_PROMPT.search(text)))


def is_generic_textbook_prompt(text: str | None) -> bool:
    """Reject vague recall prompts that do not name a learnable concept."""
    normalized = re.sub(r"\s+", "", text or "")
    return bool(_GENERIC_TEXTBOOK_PROMPT.match(normalized))


def clean_course_text(value: str | None) -> str | None:
    """Return Markdown-safe imported text without changing its meaning.

    This intentionally does not try to rewrite formulas, prose, or Markdown.
    It only removes non-printing extractor artefacts and normalizes line
    endings, making it safe for both storage and rendering.
    """
    if value is None:
        return None

    value = unicodedata.normalize("NFC", value)
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = _UNSAFE_CONTROLS.sub("", value)
    value = _INVISIBLE_FORMATTING.sub("", value)
    value = _PRIVATE_USE_GLYPHS.sub("", value)
    value = value.replace("\ufffd", "")
    value = _strip_pdf_garbage_lines(value)
    # CJK PDF text extractors frequently emit a word-space between every
    # Chinese glyph. Those spaces are layout coordinates, not source text;
    # remove them before headings and directory entries are detected.
    value = _CJK_SPACE.sub("", value)
    value = _SPACE_BEFORE_PUNCT.sub(r"\1", value)
    value = _SPACE_AFTER_OPEN.sub(r"\1", value)
    value = _EXCESS_BLANK_LINES.sub("\n\n", value)
    return value.strip()


def clean_course_title(value: str | None, fallback: str = "Untitled") -> str:
    """Produce a compact, safe title for a course tree node."""
    title = clean_course_text(value) or ""
    title = re.sub(r"\s+", " ", title).strip()
    return title[:120] if title else fallback


def normalize_pdf_markdown(value: str | None) -> str | None:
    """Make extractor Markdown structurally readable without rewriting facts.

    Some PDF converters place a Markdown heading in the middle of a line. That
    turns a heading plus its paragraph into a single giant title.  Restore the
    line boundary before building the content tree, and close gaps introduced
    between consecutive digits (for example ``５ ０`` -> ``５０``).
    """
    text = clean_course_text(value)
    if not text:
        return text

    text = _INLINE_HEADING.sub(r"\n\1 ", text)
    # The extraction process can insert a space between every digit in a
    # number. Repeat to handle sequences such as "１ ２ ０" safely.
    previous = None
    while previous != text:
        previous = text
        text = _NUMBER_GAP.sub("", text)
    text = _MATH_OPERATOR_GAP.sub(r"\1", text)
    return clean_course_text(text)


def split_embedded_heading_from_title(value: str | None) -> tuple[str, str | None]:
    """Separate accidental ``title ## subheading`` text in legacy nodes."""
    title = clean_course_title(value)
    match = _EMBEDDED_HEADING_IN_TITLE.search(title)
    if not match:
        return title, None
    parent_title = title[:match.start()].strip()
    embedded = normalize_pdf_markdown(f"{match.group(1)} {match.group(2).strip()}") or ""
    # A frequent textbook layout is a short expression heading such as
    # "## +3 -2" immediately followed by a paragraph. Split it before the
    # first Chinese sentence so it renders as a real heading, not a huge one.
    embedded = _MATH_HEADING_TEXT.sub(r"\1\n", embedded)
    return clean_course_title(parent_title), embedded
