"""PDF parsing service using Marker → Markdown → content tree.

Enhanced with:
- Code-block-aware heading extraction (PageIndex pattern)
- Token counting with bottom-up accumulation (PageIndex)
- Tree thinning: merge small nodes into parents (PageIndex)
- No-heading fallback: paragraph splitting (Deep-Research separator pattern)

References:
- PageIndex: page_index_md.py extract_nodes_from_markdown(), tree_thinning_for_index()
- Deep-Research: text-splitter.ts recursive separators
- Marker (VikParuchuri/marker) for PDF → Markdown conversion
"""

import logging
import re
import uuid
import asyncio
from functools import partial

from models.content import CourseContentTree
from services.content_text import clean_course_text, clean_course_title, is_body_content, normalize_pdf_markdown

logger = logging.getLogger(__name__)

# Tree thinning threshold (nodes with fewer total tokens get merged into parent)
MIN_NODE_TOKENS = 50

HEADING_PATTERN = re.compile(r"^(#{1,6})\s+(.+)$")
CODE_BLOCK_PATTERN = re.compile(r"^```")


def _sanitize_title(title: str) -> str:
    """Strip newlines, collapse whitespace, and truncate titles."""
    return clean_course_title(title)

# Marker model singleton — avoids reloading ~1GB models on every call
_marker_models: dict | None = None


def _get_marker_models() -> dict:
    """Lazy-load and cache Marker models as a module-level singleton."""
    global _marker_models
    if _marker_models is None:
        from marker.models import create_model_dict

        logger.info("Loading Marker models (one-time)...")
        _marker_models = create_model_dict()
    return _marker_models


def _marker_pdf_to_markdown(file_path: str) -> str:
    """Convert PDF to Markdown using Marker.

    Marker is CPU/GPU intensive, so we run it in a thread.
    Models are cached as a singleton to avoid repeated loading.
    """
    try:
        from marker.converters.pdf import PdfConverter

        models = _get_marker_models()
        converter = PdfConverter(artifact_dict=models)
        rendered = converter(file_path)
        # Sanitize at the ingestion boundary.  This prevents invisible PDF
        # extraction controls from ever being stored in CourseContentTree.
        return normalize_pdf_markdown(rendered.markdown) or ""
    except ImportError:
        raise ImportError(
            "marker-pdf is required for PDF parsing. "
            "Install with: pip install marker-pdf"
        )


def _count_tokens(text: str) -> int:
    """Count tokens using tiktoken (cl100k_base). Falls back to word-count estimate."""
    try:
        import tiktoken

        enc = tiktoken.get_encoding("cl100k_base")
        return len(enc.encode(text))
    except (ImportError, OSError, RuntimeError, ValueError):
        # ``tiktoken.get_encoding`` may need a one-time network download. PDF
        # ingestion must remain available in offline/self-hosted deployments,
        # so token counting is deliberately only an estimate when that cache is
        # unavailable. Chinese text has few whitespace-delimited words, hence
        # a character based estimate is safer than ``text.split()`` here.
        return max(1, len(text) // 2)


def _has_headings_code_aware(markdown: str) -> bool:
    """Quick check if Markdown contains any headings outside code blocks.

    Stops at the first heading found — avoids scanning the entire document
    just to decide between heading-based vs paragraph-based tree building.
    """
    in_code_block = False

    for line in markdown.split("\n"):
        stripped = line.strip()
        if CODE_BLOCK_PATTERN.match(stripped):
            in_code_block = not in_code_block
            continue
        if not in_code_block and HEADING_PATTERN.match(line):
            return True
    return False


_NUMBERED_TOPIC_LINE = re.compile(
    r"^\s*(?:第\s*[一二三四五六七八九十百千万\d０-９]+\s*[章节篇部分]|"
    r"[０-９\d]+(?:\s*[.．、)、）]\s*[０-９\d]*)?\s+)[^。！？!?；;]{2,60}$"
)
_TOPIC_PUNCTUATION = re.compile(r"[。！？!?；;：:]$")


def _looks_like_topic_line(line: str) -> bool:
    """Return whether a line is likely a semantic title, not body prose."""
    candidate = re.sub(r"\s+", " ", line).strip(" #\t")
    if not candidate or len(candidate) < 3 or len(candidate) > 70:
        return False
    if candidate.startswith(("- ", "* ", "• ", "· ")) or _TOPIC_PUNCTUATION.search(candidate):
        return False
    if _NUMBERED_TOPIC_LINE.match(candidate):
        return True
    # Short standalone lines with no sentence punctuation are common in
    # OCR'd handouts (e.g. "相反数的意义", "例题"). Require at least two
    # Chinese/letter characters so page noise and isolated numbers do not
    # become fake sections.
    return bool(re.search(r"[\u4e00-\u9fffA-Za-z].*[\u4e00-\u9fffA-Za-z]", candidate)) and len(candidate) <= 32


def _title_from_content(text: str, index: int) -> str:
    """Create a useful, source-grounded title when no heading exists."""
    first = re.split(r"(?<=[。！？!?；;])\s*", text.strip(), maxsplit=1)[0].strip()
    first = re.sub(r"\s+", " ", first).strip("-•· ")
    if len(first) > 42:
        first = first[:42].rstrip("，,、；; ") + "…"
    return _sanitize_title(first or f"正文内容 {index}")


def _split_into_paragraphs(text: str, max_tokens: int = 420, *, semantic: bool = True) -> list[dict]:
    """Build coherent sections when a source has no formal table of contents.

    The fallback is content-driven: explicit numbered/standalone topic lines
    become section boundaries; otherwise natural paragraphs and sentence
    boundaries are grouped without cutting a sentence in half. This preserves
    source order and gives every generated node a title derived from its own
    evidence instead of arbitrary "page 1/page 2" labels.
    """
    normalized = re.sub(r"\r\n?", "\n", text).strip()
    if not semantic:
        paragraphs = [p.strip() for p in normalized.split("\n\n") if p.strip()]
        chunks: list[dict] = []
        current: list[str] = []
        current_tokens = 0
        for paragraph in paragraphs:
            paragraph_tokens = _count_tokens(paragraph)
            if current and current_tokens + paragraph_tokens > max_tokens:
                chunks.append({"title": _sanitize_title(current[0][:80]), "text": "\n\n".join(current), "level": 1})
                current, current_tokens = [], 0
            current.append(paragraph)
            current_tokens += paragraph_tokens
        if current:
            chunks.append({"title": _sanitize_title(current[0][:80]), "text": "\n\n".join(current), "level": 1})
        return chunks
    lines = normalized.split("\n")
    has_topic_lines = any(_looks_like_topic_line(line) for line in lines)
    sections: list[dict] = []

    if has_topic_lines:
        current_title: str | None = None
        current_lines: list[str] = []

        def flush() -> None:
            nonlocal current_title, current_lines
            body = "\n".join(current_lines).strip()
            if body:
                sections.append({
                    "title": _sanitize_title(current_title or _title_from_content(body, len(sections) + 1)),
                    "text": body,
                    "level": 1,
                })
            current_title = None
            current_lines = []

        for line in lines:
            candidate = re.sub(r"\s+", " ", line).strip(" #\t")
            if _looks_like_topic_line(candidate):
                flush()
                current_title = candidate
            elif candidate:
                current_lines.append(candidate)
        flush()
        if sections:
            return sections

    # No reliable topic lines: use blank paragraphs first, then sentence
    # boundaries for oversized paragraphs. Adjacent short paragraphs stay
    # together when they form one coherent learning unit.
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", normalized) if p.strip()]
    chunks: list[str] = []
    current: list[str] = []
    current_tokens = 0
    for paragraph in paragraphs:
        sentences = [s.strip() for s in re.split(r"(?<=[。！？!?；;])", paragraph) if s.strip()]
        if not sentences:
            sentences = [paragraph]
        for sentence in sentences:
            sentence_tokens = _count_tokens(sentence)
            if current and current_tokens + sentence_tokens > max_tokens:
                chunks.append(" ".join(current))
                current, current_tokens = [], 0
            current.append(sentence)
            current_tokens += sentence_tokens
    if current:
        chunks.append(" ".join(current))

    return [
        {"title": _title_from_content(chunk, index), "text": chunk, "level": 1}
        for index, chunk in enumerate(chunks, start=1)
    ]


def _markdown_to_tree(
    markdown: str,
    course_id: uuid.UUID,
    source_file: str,
) -> list[CourseContentTree]:
    """Convert Markdown to content tree nodes.

    Enhanced PageIndex pattern with:
    1. Quick heading check (early exit for no-heading documents)
    2. Single-pass code-block-aware tree building (no duplicate scan)
    3. No-heading fallback (paragraph splitting)
    4. Bottom-up token counting + tree thinning (merge small nodes)
    """
    markdown = normalize_pdf_markdown(markdown) or ""
    if not markdown:
        return []

    lines = markdown.split("\n")

    # Step 1: Quick heading check (early exit, avoids full scan)
    if not _has_headings_code_aware(markdown):
        # Preserve the dedicated textbook-outline recovery path when a formal
        # contents block exists; semantic fallback is for genuinely unheaded
        # material only.
        has_formal_contents = _find_textbook_body_start(markdown.splitlines())[0] is not None
        nodes = _build_tree_from_paragraphs(
            markdown, course_id, source_file, semantic=not has_formal_contents,
        )
        nodes = _restructure_textbook_nodes(nodes, course_id, source_file, markdown)
        return _thin_tree(nodes)

    # Step 2: Single-pass tree build from headings (code-block aware)
    nodes: list[CourseContentTree] = []
    stack: list[tuple[int, CourseContentTree]] = []
    order_counter: dict[str, int] = {}
    current_content_lines: list[str] = []

    def flush_content():
        if stack and current_content_lines:
            content = "\n".join(current_content_lines).strip()
            if content:
                stack[-1][1].content = clean_course_text(content)
        current_content_lines.clear()

    # Root node
    root = CourseContentTree(
        id=uuid.uuid4(),
        course_id=course_id,
        parent_id=None,
        title=source_file,
        level=0,
        order_index=0,
        source_file=source_file,
        source_type="pdf",
    )
    nodes.append(root)
    stack.append((0, root))

    in_code_block = False

    for line in lines:
        stripped = line.strip()

        # Track code blocks
        if CODE_BLOCK_PATTERN.match(stripped):
            in_code_block = not in_code_block
            current_content_lines.append(line)
            continue

        # Only parse headings outside code blocks
        if not in_code_block:
            match = HEADING_PATTERN.match(line)
            if match:
                flush_content()

                level = len(match.group(1))
                title = _sanitize_title(match.group(2))

                while len(stack) > 1 and stack[-1][0] >= level:
                    stack.pop()

                parent = stack[-1][1]
                parent_key = str(parent.id)
                order_counter[parent_key] = order_counter.get(parent_key, 0) + 1

                node = CourseContentTree(
                    id=uuid.uuid4(),
                    course_id=course_id,
                    parent_id=parent.id,
                    title=title,
                    level=level,
                    order_index=order_counter[parent_key],
                    source_file=source_file,
                    source_type="pdf",
                )
                nodes.append(node)
                stack.append((level, node))
                continue

        current_content_lines.append(line)

    flush_content()

    # Step 3: Remove useless root node
    # If root has no content and has children, it's just a structural wrapper.
    # If root has no content AND no children, drop it entirely.
    if len(nodes) > 1 and not nodes[0].content:
        # Root is empty — check if it has exactly one child (unwrap it)
        root_children = [n for n in nodes[1:] if n.parent_id == nodes[0].id]
        if len(root_children) == 1:
            # Promote the single child to root
            root_children[0].parent_id = None
            root_children[0].level = 0
            nodes = nodes[1:]
    elif len(nodes) == 1 and not nodes[0].content:
        # Single empty root — drop it
        return []

    # Step 4: Tree thinning — merge small nodes into parents
    # Recover semantic textbook boundaries before thinning: the thinning pass
    # intentionally discards child titles when merging, but those titles are
    # exactly the 1.1/1.2 boundaries needed for a clean K-12 outline.
    nodes = _restructure_textbook_nodes(nodes, course_id, source_file, markdown)
    nodes = _thin_tree(nodes)

    return nodes


_CHAPTER_LINE = re.compile(r"^(第[一二三四五六七八九十百０-９\d]+章)\s*[：:·]?\s*(.{1,40})$")
_UNIT_LINE = re.compile(r"^(第[一二三四五六七八九十百０-９\d]+单元)\s*(.*)$")
# Language/humanities textbook PDFs frequently glue a running header to the
# unit marker (for example ``活动·探究第一单元``).  Keep the marker itself so
# the header does not become a lesson title.
_UNIT_MARKER = re.compile(r"(?P<unit>第[一二三四五六七八九十百０-９\d]+单元)")
_LESSON_LINE = re.compile(
    r"^(?P<number>[０-９\d]{1,2})\s*\*?\s+(?P<title>[\u4e00-\u9fff《“‘A-Za-z].{0,78})$"
)
_TEXTBOOK_SECTION_LINE = re.compile(
    r"^(写作|综合性学习|名著导读|课外古诗词诵读|口语交际|语文园地|活动探究)\s*(.*)$"
)
# Some publisher PDFs put an individual text span around every glyph, so
# ``26.1`` arrives as ``２６ ． １``. Permit whitespace *inside* each part of
# a section number without relaxing the title matching for ordinary prose.
# Middle-school textbook chapter/section identifiers are at most two digits.
# Keeping that bound also lets ``... 2 21.2`` be recovered as ``21.2`` rather
# than incorrectly treating a preceding page number as part of the chapter.
_OUTLINE_NUMBER_PART = r"[０-９\d](?:\s*[０-９\d])?"
_SECTION_LINE = re.compile(
    rf"^({_OUTLINE_NUMBER_PART})\s*[．.]\s*({_OUTLINE_NUMBER_PART})\s*[、：:]?\s*(.{{1,52}})$"
)
_SECTION_TOKEN = re.compile(rf"{_OUTLINE_NUMBER_PART}\s*[．.]\s*{_OUTLINE_NUMBER_PART}")
_SECTION_START = re.compile(
    rf"(?P<major>{_OUTLINE_NUMBER_PART})\s*[．.]\s*(?P<minor>{_OUTLINE_NUMBER_PART})"
)
_DIGIT_TRANSLATION = str.maketrans("０１２３４５６７８９", "0123456789")


def _normalize_outline_number(value: str) -> str:
    """Return an ASCII outline-number part from fragmented PDF glyphs."""
    return re.sub(r"\s+", "", value).translate(_DIGIT_TRANSLATION)


def _clean_toc_title(value: str) -> str:
    """Remove page numbers and non-section inserts from a TOC fragment."""
    value = re.sub(r"\s+", " ", value).strip(" .．…:：")
    # Supplemental entries are valid material, but must not become part of
    # the preceding numbered lesson title when PDF text extraction joins them.
    value = re.split(
        r"(?:信息技术应用|阅读与思考|数学活动|小结|复习题|观察与猜想|实验与探究|课题学习)",
        value,
        maxsplit=1,
    )[0].strip()
    value = re.sub(r"\s*[０-９\d](?:\s*[０-９\d])*\s*$", "", value).strip()
    return value
def _chapter_number_key(raw: str) -> str:
    """Normalize Arabic/full-width/Chinese chapter numbers for matching."""
    normalized = raw.translate(_DIGIT_TRANSLATION)
    if normalized.isdigit():
        return normalized
    digits = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    if "百" in normalized:
        left, right = normalized.split("百", 1)
        value = digits.get(left, 1) * 100
        return str(value + int(_chapter_number_key(right) or "0"))
    if "十" in normalized:
        left, right = normalized.split("十", 1)
        value = digits.get(left, 1) * 10 + digits.get(right, 0)
        return str(value)
    return str(digits.get(normalized, normalized))


def _find_textbook_body_start(lines: list[str]) -> tuple[int | None, int | None]:
    """Locate a real textbook body after its contents pages.

    The contents pages and the first body page often end up in one large PDF
    extraction chunk. A contents block lists each chapter once; the body starts
    when its first chapter appears again. Returning line offsets rather than
    relying on parser chunks prevents the contents tree being treated as course
    content (and prevents duplicate chapters).
    """
    toc_index = next(
        (index for index, line in enumerate(lines) if re.search(r"目\s*录", line)),
        None,
    )
    if toc_index is None:
        return None, None

    seen_structures: set[tuple[str, str]] = set()
    seen_lessons: set[tuple[str, str]] = set()
    for index in range(toc_index + 1, len(lines)):
        match = _CHAPTER_LINE.match(lines[index])
        if match:
            key = ("chapter", _chapter_number_key(match.group(1)[1:-1]))
        else:
            unit_match = _UNIT_MARKER.search(lines[index])
            if unit_match:
                key = ("unit", _chapter_number_key(unit_match.group("unit")[1:-2]))
            else:
                # In language books, the first lesson is often the most
                # stable duplicate marker: the contents page has e.g. ``2
                # 首届诺贝尔奖颁发`` and the body repeats it after the page
                # headers.  Use it only after a formal contents heading so
                # ordinary notes are unaffected.
                lesson_match = _LESSON_LINE.match(lines[index])
                if not lesson_match:
                    continue
                lesson_key = (
                    "lesson",
                    _normalize_outline_number(lesson_match.group("number")),
                )
                if lesson_key in seen_lessons:
                    return toc_index, index
                seen_lessons.add(lesson_key)
                continue
        if key in seen_structures:
            return toc_index, index
        seen_structures.add(key)
    return toc_index, None


def _restructure_unit_textbook_nodes(
    lines: list[str], body_start: int, course_id: uuid.UUID, source_file: str,
) -> list[CourseContentTree]:
    """Build a readable unit/lesson tree for language and humanities books.

    Chinese-language textbooks use ``第一单元`` and numbered reading lessons,
    not ``第一章``/``1.1`` headings. Their PDF text layer also repeats page
    headers, so treating every page as a chapter produces a noisy outline.
    This parser keeps the publisher's unit and lesson order while merging page
    continuations into the canonical lesson node.
    """
    root = CourseContentTree(
        id=uuid.uuid4(), course_id=course_id, parent_id=None, title=source_file,
        level=0, order_index=0, source_file=source_file, source_type="pdf",
    )
    rebuilt = [root]
    front_text = "\n".join(lines[:body_start]).strip()
    if front_text:
        rebuilt.append(CourseContentTree(
            id=uuid.uuid4(), course_id=course_id, parent_id=root.id,
            title="前言与目录", level=1, order_index=1, content=front_text,
            source_file=source_file, source_type="pdf", content_category="reference",
        ))

    unit: CourseContentTree | None = None
    unit_key: str | None = None
    section: CourseContentTree | None = None
    unit_order = 1 if front_text else 0
    section_order = 0
    seen_lessons: dict[tuple[str, str], CourseContentTree] = {}
    seen_sections: dict[tuple[str, str], CourseContentTree] = {}

    def append_content(target: CourseContentTree | None, text: str) -> None:
        if target is None or not text:
            return
        target.content = clean_course_text(f"{target.content or ''}\n{text}")

    for raw_line in lines[body_start:]:
        line = re.sub(r"^(?:/[A-Za-z0-9]+)+", "", raw_line).strip()
        line = re.sub(r"\s+", " ", line).strip()
        if not line or re.fullmatch(r"(?:[IVX]+|\d{1,3})", line):
            continue

        unit_match = _UNIT_LINE.match(line)
        if not unit_match:
            embedded_unit = _UNIT_MARKER.search(line)
            if embedded_unit:
                unit_match = embedded_unit
        if unit_match:
            unit_text = unit_match.group("unit") if "unit" in unit_match.groupdict() else unit_match.group(1)
            next_unit_key = _chapter_number_key(unit_text[1:-2])
            if unit is not None and unit_key == next_unit_key:
                # Repeated page header; do not create a duplicate unit.
                section = None
                continue
            unit_order += 1
            unit = CourseContentTree(
                id=uuid.uuid4(), course_id=course_id, parent_id=root.id,
                title=unit_text, level=1, order_index=unit_order,
                source_file=source_file, source_type="pdf",
            )
            unit_key = next_unit_key
            rebuilt.append(unit)
            section = None
            section_order = 0
            continue

        if unit is None:
            continue

        category_match = _TEXTBOOK_SECTION_LINE.match(line)
        if category_match:
            category = category_match.group(1)
            detail = category_match.group(2).strip()
            # A PDF text layer can join a writing-section heading with the
            # first explanatory sentence (``写作消息时，首先要……``).  That
            # sentence is lesson content, not a directory entry.  Valid
            # writing headings are short labels such as ``学写传记`` or
            # ``说明事物要抓住特征``.
            if (
                category == "写作"
                and (
                    len(detail) > 24
                    or re.search(r"[，。！？；：]", detail)
                    or detail.startswith(("时", "消息时"))
                )
            ):
                append_content(section or unit, line)
                continue
            if detail.startswith("第") and "单元" in detail[:8]:
                append_content(unit, line)
                continue
            title = f"{category} {detail}".strip()
            key = (str(unit.id), title)
            section = seen_sections.get(key)
            if section is None:
                section_order += 1
                section = CourseContentTree(
                    id=uuid.uuid4(), course_id=course_id, parent_id=unit.id,
                    title=clean_course_title(title), level=2, order_index=section_order,
                    source_file=source_file, source_type="pdf",
                )
                seen_sections[key] = section
                rebuilt.append(section)
            continue

        lesson_match = _LESSON_LINE.match(line)
        if lesson_match:
            number = _normalize_outline_number(lesson_match.group("number"))
            title = clean_course_title(lesson_match.group("title"))
            # Page headers repeat the lesson title. A genuine lesson heading is
            # short and has no sentence-ending punctuation.
            if len(title) <= 80 and not re.search(r"[。！？!?；;]$", title):
                key = (str(unit.id), number)
                lesson = seen_lessons.get(key)
                if lesson is None:
                    section_order += 1
                    lesson = CourseContentTree(
                        id=uuid.uuid4(), course_id=course_id, parent_id=unit.id,
                        title=f"{number} {title}", level=2, order_index=section_order,
                        source_file=source_file, source_type="pdf",
                    )
                    seen_lessons[key] = lesson
                    rebuilt.append(lesson)
                section = lesson
                continue

        append_content(section or unit, line)

    # Only use this specialized parser when it found real unit/lesson nodes;
    # otherwise retain the generic parser's safer output for unrelated files.
    if len(rebuilt) <= 2 or not any(node.level == 2 for node in rebuilt):
        return []
    return rebuilt


def _restructure_textbook_nodes(
    nodes: list[CourseContentTree], course_id: uuid.UUID, source_file: str,
    markdown: str | None = None,
) -> list[CourseContentTree]:
    """Turn page-shaped PDF output into front matter → chapter → section.

    Textbook PDFs commonly repeat the chapter name in every page header. Marker
    promotes each page to a heading, producing dozens of sibling nodes. This
    pass recognizes semantic chapter/section lines and merges continuation
    pages into the current section.
    """
    if len(nodes) < 3 and not markdown:
        return nodes
    chunks = [
        clean_course_text(f"{node.title}\n{node.content or ''}") or ""
        for node in nodes if node.level > 0 and (node.title or node.content)
    ]
    if not chunks:
        return nodes

    def chapter_line(line: str):
        return None if _SECTION_TOKEN.search(line) else _CHAPTER_LINE.match(line)

    if markdown:
        # Keep the extractor's original line boundaries. Page-shaped node
        # titles often prepend a page number and running header, which would
        # otherwise turn ``1 春`` into the false title ``3 阅读 1 春``.
        lines = [
            re.sub(r"\s+", " ", raw_line).strip(" #\t")
            for raw_line in (normalize_pdf_markdown(markdown) or "").splitlines()
        ]
    else:
        lines = [
            re.sub(r"\s+", " ", raw_line).strip(" #\t")
            for chunk in chunks for raw_line in chunk.splitlines()
        ]
    toc_index, body_start = _find_textbook_body_start(lines)
    if body_start is not None and any(_UNIT_LINE.match(line) for line in lines[body_start:]):
        unit_nodes = _restructure_unit_textbook_nodes(lines, body_start, course_id, source_file)
        if unit_nodes:
            return unit_nodes
    if body_start is None:
        body_start = next(
            (index for index, line in enumerate(lines) if chapter_line(line)),
            None,
        )
    if body_start is None:
        return [node for node in nodes if node.level == 0 or is_body_content(node.title, node.content)]

    root = CourseContentTree(
        id=uuid.uuid4(), course_id=course_id, parent_id=None, title=source_file,
        level=0, order_index=0, source_file=source_file, source_type="pdf",
    )
    rebuilt = [root]
    front_text = "\n".join(lines[:body_start]).strip()
    if front_text:
        rebuilt.append(CourseContentTree(
            id=uuid.uuid4(), course_id=course_id, parent_id=root.id,
            title="前言与目录", level=1, order_index=1, content=front_text,
            source_file=source_file, source_type="pdf", content_category="reference",
        ))

    chapter = None
    chapter_key = None
    section = None
    chapter_order = 1
    section_order = 0
    sections_in_chapter: dict[str, CourseContentTree] = {}
    for line in lines[body_start:]:
        # pypdf sometimes prefixes a heading with encoded font glyph labels
        # (for example ``/G21/G22...２２．１``). They are presentation noise,
        # not course content, and otherwise prevent an anchored heading match.
        line = re.sub(r"^(?:/[A-Za-z0-9]+)+", "", line).strip()
        if not line or line in {"书书书", "_", "/"}:
            continue
        chapter_match = chapter_line(line)
        if chapter_match:
            title = f"{chapter_match.group(1)} {chapter_match.group(2).strip()}"
            raw_chapter = chapter_match.group(1)[1:-1]
            next_chapter_key = _chapter_number_key(raw_chapter)
            # Repeated page headers can contain nearby diagram labels; the
            # chapter number is the stable identity, so never create a new
            # chapter until that number changes.
            if chapter and chapter_key == next_chapter_key:
                continue
            chapter_order += 1
            section_order = 0
            chapter = CourseContentTree(
                id=uuid.uuid4(), course_id=course_id, parent_id=root.id,
                title=title, level=1, order_index=chapter_order,
                source_file=source_file, source_type="pdf",
            )
            rebuilt.append(chapter)
            chapter_key = next_chapter_key
            section = None
            sections_in_chapter = {}
            continue
        section_match = _SECTION_LINE.match(line)
        if section_match and chapter:
            major = _normalize_outline_number(section_match.group(1))
            minor = _normalize_outline_number(section_match.group(2))
            section_title = section_match.group(3).strip()
            if (
                major != chapter_key
                or not minor.isdigit()
                or int(minor) > 20
                or not re.match(r"[\u4e00-\u9fff]", section_title)
                or re.search(r"[，。．！？；：＝=]", section_title)
            ):
                target = section or chapter
                target.content = clean_course_text(f"{target.content or ''}\n{line}")
                continue
            title = f"{major}.{minor} {section_title}"
            section_key = f"{major}.{minor}"
            if section_key in sections_in_chapter:
                # A lesson title may appear once in an introductory sentence
                # and again at the real lesson boundary. Keep one canonical
                # node and prefer the cleaner/shorter heading.
                section = sections_in_chapter[section_key]
                if len(title) < len(section.title or ""):
                    section.title = title
                continue
            section_order += 1
            section = CourseContentTree(
                id=uuid.uuid4(), course_id=course_id, parent_id=chapter.id,
                title=title, level=2, order_index=section_order,
                source_file=source_file, source_type="pdf",
            )
            rebuilt.append(section)
            sections_in_chapter[section_key] = section
            continue
        target = section or chapter
        if target:
            target.content = clean_course_text(f"{target.content or ''}\n{line}")
    return rebuilt


def assess_textbook_outline_integrity(
    markdown: str, nodes: list[CourseContentTree], minimum_coverage: float = 0.85,
) -> tuple[bool, dict]:
    """Check that sections advertised by a textbook TOC survived parsing.

    The check is deliberately enabled only when a real contents block with at
    least four distinct section numbers is present. This avoids rejecting notes
    and short handouts that legitimately have no formal outline.
    """
    normalized = normalize_pdf_markdown(markdown) or ""
    outline_lines = [
        re.sub(r"\s+", " ", line).strip(" #\t")
        for line in normalized.splitlines()
    ]
    toc_index, body_start = _find_textbook_body_start(outline_lines)
    if toc_index is None:
        return True, {"checked": False, "reason": "no_formal_contents_block"}

    # Only inspect the real contents block. Scanning the body as well makes
    # formulae, exercise numbers and page headers look like phantom sections.
    toc_end = body_start if body_start is not None else min(len(outline_lines), toc_index + 400)
    toc_text = "\n".join(outline_lines[toc_index:toc_end])
    # Restrict section numbers to chapters that are actually advertised in
    # the same contents block.  PDF text extraction frequently joins a page
    # number to the next section (for example page ``6`` + ``1.2`` becomes
    # ``61.2``).  Treating that joined page number as a chapter made valid
    # People's Education Press textbooks fail integrity checks.
    chapter_keys = {
        _chapter_number_key(raw)
        for line in outline_lines[toc_index:toc_end]
        for raw in re.findall(r"第([一二三四五六七八九十百０-９\d]+)章", line)
    }

    def _resolve_major(raw: str) -> str:
        normalized_major = _normalize_outline_number(raw)
        if not chapter_keys or normalized_major in chapter_keys:
            return normalized_major
        suffixes = [key for key in chapter_keys if normalized_major.endswith(key)]
        if suffixes:
            return max(suffixes, key=len)
        return normalized_major

    expected: list[tuple[str, str]] = []
    starts = list(_SECTION_START.finditer(toc_text))
    for index, match in enumerate(starts):
        next_start = starts[index + 1].start() if index + 1 < len(starts) else len(toc_text)
        title = toc_text[match.end():next_start]
        key = f"{_resolve_major(match.group('major'))}.{_normalize_outline_number(match.group('minor'))}"
        clean_title = _clean_toc_title(title)
        if key not in [item[0] for item in expected]:
            expected.append((key, clean_title))
    if len(expected) < 4:
        return True, {"checked": False, "reason": "too_few_numbered_sections"}

    actual: dict[str, tuple[int, str]] = {}
    duplicates: list[str] = []
    for position, node in enumerate(nodes):
        match = re.match(r"^([0-9]+\.[0-9]+)(?:\s+(.+))?$", (node.title or "").strip())
        if match:
            key = match.group(1)
            if key in actual:
                duplicates.append(key)
            else:
                actual[key] = (position, re.sub(r"\s+", " ", match.group(2) or "").strip())
    expected_keys = [key for key, _ in expected]
    missing = [key for key in expected_keys if key not in actual]
    title_mismatches = [
        key for key, title in expected
        if key in actual and title and actual[key][1] and title not in actual[key][1] and actual[key][1] not in title
    ]
    actual_order = [key for key in expected_keys if key in actual]
    order_mismatch = actual_order != sorted(actual_order, key=lambda key: actual[key][0])
    coverage = (len(expected_keys) - len(missing)) / len(expected_keys)
    report = {
        "checked": True, "expected_sections": len(expected_keys), "parsed_sections": len(actual),
        "coverage": round(coverage, 3), "missing_sections": missing,
        "title_mismatches": title_mismatches, "duplicate_sections": duplicates,
        "order_mismatch": order_mismatch,
    }
    complete = coverage >= minimum_coverage and not title_mismatches and not duplicates and not order_mismatch
    return complete, report


def assess_textbook_outline_coverage(
    markdown: str, nodes: list[CourseContentTree], minimum_coverage: float = 0.85,
) -> tuple[bool, list[str]]:
    """Legacy compatibility wrapper for callers only expecting missing IDs."""
    complete, report = assess_textbook_outline_integrity(markdown, nodes, minimum_coverage)
    return complete, list(report.get("missing_sections", []))


def _build_tree_from_paragraphs(
    markdown: str,
    course_id: uuid.UUID,
    source_file: str,
    *,
    semantic: bool = True,
) -> list[CourseContentTree]:
    """Build tree from paragraph splits when no headings are found."""
    para_nodes = _split_into_paragraphs(markdown, semantic=semantic)

    if not para_nodes:
        # Single root node with all content
        root = CourseContentTree(
            id=uuid.uuid4(),
            course_id=course_id,
            parent_id=None,
            title=source_file,
            level=0,
            order_index=0,
            content=clean_course_text(markdown),
            source_file=source_file,
            source_type="pdf",
        )
        return [root]

    nodes: list[CourseContentTree] = []
    root = CourseContentTree(
        id=uuid.uuid4(),
        course_id=course_id,
        parent_id=None,
        title=source_file,
        level=0,
        order_index=0,
        source_file=source_file,
        source_type="pdf",
    )
    nodes.append(root)

    for i, pn in enumerate(para_nodes):
        node = CourseContentTree(
            id=uuid.uuid4(),
            course_id=course_id,
            parent_id=root.id,
            title=pn["title"],
            level=1,
            order_index=i + 1,
            content=pn["text"],
            source_file=source_file,
            source_type="pdf",
        )
        nodes.append(node)

    return nodes


def _thin_tree(nodes: list[CourseContentTree]) -> list[CourseContentTree]:
    """Merge small child nodes into their parent.

    Ported from PageIndex tree_thinning_for_index() (page_index_md.py L135-187).
    Nodes whose subtree has fewer than MIN_NODE_TOKENS get merged upward.
    """
    if len(nodes) <= 2:
        return nodes

    # Build parent→children map
    children_map: dict[str, list[int]] = {}
    for i, node in enumerate(nodes):
        nid = str(node.id)
        pid = str(node.parent_id) if node.parent_id else None
        if pid:
            children_map.setdefault(pid, []).append(i)

    def collect_subtree_indices(root_index: int) -> list[int]:
        """Collect node indices for a subtree in source order."""
        nid = str(nodes[root_index].id)
        result = [root_index]
        for child_index in sorted(children_map.get(nid, [])):
            result.extend(collect_subtree_indices(child_index))
        return result

    # Bottom-up token counting
    token_counts = [0] * len(nodes)
    for i in range(len(nodes) - 1, -1, -1):
        own_text = nodes[i].content or ""
        own_tokens = _count_tokens(own_text) if own_text else 0
        child_tokens = sum(token_counts[ci] for ci in children_map.get(str(nodes[i].id), []))
        token_counts[i] = own_tokens + child_tokens

    # Identify nodes to merge (skip root at index 0)
    indices_to_remove = set()
    for i in range(len(nodes) - 1, 0, -1):
        if i in indices_to_remove:
            continue

        nid = str(nodes[i].id)
        children_indices = children_map.get(nid, [])

        # Numbered textbook sections are navigation boundaries, even when the
        # extracted text is short. Merging them makes valid 1.1/1.2 entries
        # disappear from the course outline.
        has_numbered_section_children = any(
            re.match(r"^[０-９\d]+\s*[．.]\s*[０-９\d]+(?:\s|$)", nodes[ci].title or "")
            for ci in children_indices
        )
        preserve_outline_children = nodes[i].level <= 1 and any(
            (nodes[ci].level or 0) > (nodes[i].level or 0) for ci in children_indices
        )

        if (
            token_counts[i] < MIN_NODE_TOKENS
            and children_indices
            and not has_numbered_section_children
            and not preserve_outline_children
        ):
            # Merge children content into this node
            merged_parts = []
            if nodes[i].content:
                merged_parts.append(nodes[i].content)

            for ci in sorted(children_indices):
                for subtree_index in collect_subtree_indices(ci):
                    if subtree_index not in indices_to_remove and nodes[subtree_index].content:
                        merged_parts.append(nodes[subtree_index].content)
                    indices_to_remove.add(subtree_index)

            if merged_parts:
                nodes[i].content = "\n\n".join(merged_parts)

    # Remove merged nodes
    result = [n for i, n in enumerate(nodes) if i not in indices_to_remove]
    return result


async def parse_pdf_to_tree(
    file_path: str,
    course_id: uuid.UUID,
    source_file: str,
) -> list[CourseContentTree]:
    """Full pipeline: PDF → Marker → Markdown → content tree nodes."""
    loop = asyncio.get_event_loop()

    # Run Marker in a thread (it's CPU-intensive)
    markdown = await loop.run_in_executor(
        None, partial(_marker_pdf_to_markdown, file_path)
    )

    # Build content tree
    nodes = _markdown_to_tree(markdown, course_id, source_file)
    return nodes
