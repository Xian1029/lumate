"""Page-complete extraction and structure for PEP English textbook PDFs.

This path is explicitly English-textbook scoped. Text-bearing editions use
page coordinates; scanned editions use local OCR. Every physical page is
accounted for, and repeated unit labels in listening scripts/word lists never
replace the lesson body. The unmodified PDF remains the source for pictures
and for checking OCR transcription.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from collections import Counter
from pathlib import Path

from models.content import CourseContentTree
from services.content_text import clean_course_text

logger = logging.getLogger(__name__)
DOCUMENT_MARKER = "<!-- lumate-english-document:"
PAGE_PATTERN = re.compile(r"<!-- lumate-english-page:(\{[^\n]+\}) -->\n")
UNIT_PATTERN = re.compile(r"(?:starter\s+)?unit\s*(\d{1,2})\b", re.I)
_RENDER_LOCK = threading.Lock()
_COMPILE_LOCK = threading.Lock()
_IPA = {"I": "ɪ", "U": "ʊ", "V": "ʌ", "A": "ɑ", "O": "ɔ", "Q": "ɒ",
        "@": "ə", "3": "ɜ", "{": "æ", "N": "ŋ", "S": "ʃ", "Z": "ʒ",
        "T": "θ", "D": "ð", ":": "ː", '"': "ˈ", "%": "ˌ"}
_APPENDICES = (
    (r"tapescripts?|listening\s+(?:scripts?|materials?)", "听力原文"),
    (r"pronunciation", "语音练习"),
    (r"grammar(?!\s+focus)\b|语法参考", "语法参考"),
    (r"notes?\s+on\s+the\s+text|课文注释", "课文注释"),
    (r"words\s+and\s+expressions\s+in\s+each\s+unit|单元词汇表", "单元词汇表"),
    (r"vocabulary\s+index|词汇索引|词汇总表", "词汇总表"),
    (r"irregular\s+verbs?|不规则动词", "不规则动词表"),
)


class EnglishTextbookExtractionError(ValueError):
    """Missing pages or unavailable OCR must not be reported as complete."""


def is_english_textbook(source: str) -> bool:
    return bool(re.search(r"英语|english", source, re.I) and re.search(
        r"教材|课本|教科书|年级|textbook|grade", source, re.I,
    ))


def normalize_english_page(text: str) -> str:
    # PEP's Ipa-samdUclphon font maps real phonemes into ASCII-offset PUA
    # characters. Decode before the shared cleaner removes private glyphs.
    text = "".join(
        _IPA.get(chr(ord(c) - 0xF000), chr(ord(c) - 0xF000))
        if 0xF020 <= ord(c) <= 0xF07E else c for c in text
    )
    for glyph, letters in {"ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl"}.items():
        text = text.replace(glyph, letters)
    for broken, repaired in {
        "Th e": "The", "Th en": "Then", "Th ey": "They", "Th is": "This",
        "Th at": "That", "Th ese": "These", "Th ose": "Those", "Th ere": "There",
        "Y es": "Yes", "Y ou": "You", "Y our": "Your", "Y ork": "York",
        "T om": "Tom", "T ao": "Tao", "lett ers": "letters", "Lett ers": "Letters",
        "aft ernoon": "afternoon", "diff erent": "different", "off er": "offer",
        "oft en": "often",
    }.items():
        text = text.replace(broken, repaired)
    text = re.sub(r"\bfi[ \t]+(ne|rst|ve|nd|fty|fth|nish|nally)\b", r"fi\1", text)
    # Large decorative initial capitals are separate PDF spans/lines.
    text = re.sub(r"(?im)^U\s+(\d+)\s*\nNIT\b", r"Unit \1", text)
    text = re.sub(r"(?im)^S\s+(\d+)\s*\nTARTER\s+UNIT\b", r"Starter Unit \1", text)
    text = re.sub(r"(?im)^S\s*\nTARTER\s+UNIT\s*\n\s*(\d+)\b", r"Starter Unit \1", text)
    text = re.sub(r"(?im)^U\s*\nNIT\s*\n\s*(\d+)\b", r"Unit \1", text)
    text = re.sub(r"(?im)\b(starter\s+unit|unit)\s*\n\s*(\d+)\b", r"\1 \2", text)
    text = re.sub(r"(?im)^section\s*\n\s*([AB])\b", r"Section \1", text)
    text = re.sub(r"(?im)^Section ([AB])[ \t]+(?=[A-Z])", r"Section \1\n", text)
    text = re.sub(r"(?im)\bGrammar\s*\n\s*F\s*o\s*c\s*u\s*s\b", "Grammar Focus", text)
    text = re.sub(r"(?im)\bSelf\s*\n\s*Check\b", "Self Check", text)
    text = re.sub(r"(?<=\w)[ \t]+([.!?,;:])", r"\1", text)
    return clean_course_text(text) or ""


def _cache_dir() -> Path:
    from config import settings
    cache = Path(settings.upload_dir).resolve() / ".english-ocr"
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    return cache


def _native_ocr(path: str, pages: list[int]) -> list[dict]:
    source = Path(__file__).parents[1] / "ingestion" / "english_pdf_ocr.swift"
    version = hashlib.sha256(source.read_bytes()).hexdigest()[:16]
    cache = _cache_dir()
    binary = cache / f"vision-{version}"
    with _COMPILE_LOCK:
        if not binary.exists():
            compiler = shutil.which("swiftc") or "/usr/bin/swiftc"
            compilation = subprocess.run(
                [compiler, "-module-cache-path", str(cache / "swift-modules"), str(source), "-o", str(binary)],
                capture_output=True, text=True, timeout=180,
            )
            if compilation.returncode:
                raise EnglishTextbookExtractionError("本机扫描识别组件无法启动：" + compilation.stderr[-500:])
    result = subprocess.run(
        [str(binary), str(Path(path).resolve()), ",".join(map(str, pages))],
        capture_output=True, text=True, timeout=max(180, len(pages) * 20),
    )
    if result.returncode:
        raise EnglishTextbookExtractionError("扫描页识别失败：" + result.stderr[-500:])
    return json.loads(result.stdout)


def _tesseract_page(path: str, number: int) -> dict:
    import pypdfium2
    with tempfile.TemporaryDirectory(prefix="lumate-english-page-") as temporary:
        image_path = Path(temporary) / "page.png"
        # PDFium is not thread safe. Only its render work is serialized; OCR
        # processes can run concurrently with a bounded worker count.
        with _RENDER_LOCK:
            with pypdfium2.PdfDocument(path) as pdf:
                page = pdf[number - 1]
                bitmap = page.render(scale=3)
                bitmap.to_pil().save(image_path)
                bitmap.close()
                page.close()
        output = Path(temporary) / "ocr"
        result = subprocess.run(
            ["tesseract", str(image_path), str(output), "-l", "eng+chi_sim", "--psm", "3", "txt", "tsv"],
            capture_output=True, text=True, timeout=120,
            env={**os.environ, "OMP_THREAD_LIMIT": "1"},
        )
        if result.returncode:
            return {"page": number, "text": "", "error": result.stderr[-300:]}
        import csv
        with output.with_suffix(".tsv").open() as handle:
            words = [row for row in csv.DictReader(handle, delimiter="\t") if row.get("text", "").strip()]
        confidence = [float(row["conf"]) / 100 for row in words if float(row["conf"]) >= 0]
        return {"page": number, "text": output.with_suffix(".txt").read_text(),
                "confidence": sum(confidence) / len(confidence) if confidence else 0}


def _ocr_pages(path: str, pages: list[int]) -> list[dict]:
    if sys.platform == "darwin":
        return _native_ocr(path, pages)
    if not shutil.which("tesseract"):
        raise EnglishTextbookExtractionError("扫描版英语教材需要本地 OCR；请安装 tesseract-ocr 及 eng、chi_sim 语言包。")
    languages = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, timeout=10).stdout
    if not {"eng", "chi_sim"}.issubset(set(languages.splitlines())):
        raise EnglishTextbookExtractionError("扫描识别缺少 eng 或 chi_sim 语言包，无法完整读取中英文教材。")
    with ThreadPoolExecutor(max_workers=3) as workers:
        return list(workers.map(lambda number: _tesseract_page(path, number), pages))


def extract_english_textbook(path: str) -> tuple[str, str]:
    import pdfplumber
    pages: list[dict] = []
    needs_ocr: list[int] = []
    with pdfplumber.open(path) as pdf:
        for number, page in enumerate(pdf.pages, 1):
            text_page = None
            try:
                text_page = page.dedupe_chars(tolerance=1)
                for character in text_page.chars:
                    font = character.get("fontname", "").lower()
                    if "ipa-samd" in font or "uclphon" in font:
                        character["text"] = "".join(_IPA.get(c, c) for c in character["text"])
                raw = text_page.extract_text(x_tolerance=2, y_tolerance=3) or ""
            except (ValueError, TypeError, KeyError, OSError):
                raw = ""
            finally:
                if text_page is not None:
                    text_page.close()
            text = normalize_english_page(raw)
            blank = not text.strip() and not page.images and not page.curves and not page.rects
            requires_ocr = not blank and len(re.sub(r"\W", "", text)) < 20
            pages.append({"page": number, "text": text, "method": "blank" if blank else "text"})
            if requires_ocr:
                needs_ocr.append(number)
            page.close()
    if needs_ocr:
        fingerprint = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        # Include the native implementation version, so repaired OCR order is
        # never hidden behind a cache from the previous extractor.
        native_source = Path(__file__).parents[1] / "ingestion" / "english_pdf_ocr.swift"
        version = hashlib.sha256(native_source.read_bytes()).hexdigest()[:10]
        cache_path = _cache_dir() / f"{fingerprint}-{sys.platform}-{version}.json"
        try:
            cached = json.loads(cache_path.read_text()) if cache_path.exists() else []
        except (OSError, ValueError):
            cached = []
        cached_map = {row["page"]: row for row in cached if not row.get("error")}
        missing = [number for number in needs_ocr if number not in cached_map]
        if missing:
            logger.info("English textbook OCR: %s, %d pages", Path(path).name, len(missing))
            results = _ocr_pages(path, missing)
            failures = [row["page"] for row in results if row.get("error")]
            if failures or len(results) != len(missing):
                raise EnglishTextbookExtractionError(f"英语教材扫描识别未完成，失败页码：{failures or missing}。原文件已保留，可重试。")
            cached_map.update({row["page"]: row for row in results})
            cache_path.write_text(json.dumps(list(cached_map.values()), ensure_ascii=False))
        for number in needs_ocr:
            row = cached_map[number]
            pages[number - 1].update(text=normalize_english_page(row["text"]), method="ocr", confidence=row.get("confidence", 0))
    report = {
        "total": len(pages), "parsed": sum(bool(row["text"].strip()) for row in pages),
        "blank_pages": [row["page"] for row in pages if row["method"] == "blank"],
        "ocr_pages": needs_ocr, "failed_pages": [], "unit": "pages",
        "visual_only_pages": [row["page"] for row in pages if row["method"] != "blank" and not row["text"].strip()],
        "low_confidence_pages": [row["page"] for row in pages if row.get("confidence", 1) < 0.8],
        "extractor": "english-page-complete-v1",
        "expected_units": sorted({
            f"{'Starter Unit' if match.group().lower().startswith('starter') else 'Unit'} {match.group(1)}"
            for row in pages for match in UNIT_PATTERN.finditer(row["text"])
        }),
    }
    title = re.sub(r"^[a-f0-9]{12,64}_", "", Path(path).stem)
    content = [f"{DOCUMENT_MARKER}{json.dumps(report, ensure_ascii=False)} -->"]
    for row in pages:
        metadata = {key: value for key, value in row.items() if key != "text"}
        content.append(f"<!-- lumate-english-page:{json.dumps(metadata, ensure_ascii=False)} -->\n{row['text']}")
    return title, "\n\n".join(content)


def english_extraction_report(markdown: str) -> dict | None:
    match = re.search(re.escape(DOCUMENT_MARKER) + r"(\{[^\n]+\}) -->", markdown)
    return json.loads(match.group(1)) if match else None


def _page_unit(text: str) -> tuple[str, str] | None:
    header = "\n".join(text.splitlines()[:16])
    if re.search(r"topics\s+functions|target\s+language|vocabulary\s+recycling", header, re.I):
        return None
    match = UNIT_PATTERN.search(header)
    if not match:
        return None
    prefix = "Starter Unit" if match.group().lower().startswith("starter") else "Unit"
    return prefix, match.group(1)


def _unit_title(text: str, key: tuple[str, str]) -> str:
    lines = text.splitlines()[:20]
    title_lines: list[str] = []
    for raw in lines:
        line = UNIT_PATTERN.sub("", raw).strip(" ·•●").lstrip(".")
        line = re.sub(r"\.{2,}$", ".", line).strip()
        if not line or re.fullmatch(r"(?:section\s*[ab]|[ab]|S?\d+|page\s*pb)", line, re.I):
            continue
        if re.search(r"language\s+goals?|^\d+[a-z]?\b|^listen\b|^match\b|^check\b|^write\b", line, re.I):
            break
        if re.search(r"[A-Za-z]", line):
            title_lines.append(line)
            if re.search(r"[.!?]$", line):
                break
    detail = " ".join(title_lines).strip()
    if len(detail) > 100:
        detail = ""
    return f"{key[0]} {key[1]}" + (f" · {detail}" if detail else "")


def english_markdown_to_tree(markdown: str, course_id: uuid.UUID, source: str) -> list[CourseContentTree]:
    matches = list(PAGE_PATTERN.finditer(markdown))
    extraction_report = english_extraction_report(markdown) or {}
    page_numbers = [json.loads(match.group(1))["page"] for match in matches]
    if page_numbers != list(range(1, extraction_report.get("total", len(matches)) + 1)):
        raise EnglishTextbookExtractionError("英语教材页面记录存在缺页、重复或顺序错误，不能标记为解析完成。")
    root = CourseContentTree(id=uuid.uuid4(), course_id=course_id, title=source, level=0,
                             order_index=0, source_file=source, source_type="pdf",
                             metadata_={"extraction": extraction_report})
    nodes = [root]
    groups: dict[str, CourseContentTree] = {}
    sections: dict[tuple[uuid.UUID, str], CourseContentTree] = {}
    current_group: CourseContentTree | None = None
    current_section = "课文与练习"
    appendix: str | None = None
    body_started = False
    primary_units: list[str] = []
    body_pages: list[int] = []
    source_pages: list[int] = []
    title_candidates: dict[str, Counter] = {}
    for position, match in enumerate(matches):
        page = json.loads(match.group(1))
        end = matches[position + 1].start() if position + 1 < len(matches) else len(markdown)
        text = markdown[match.end():end].strip()
        number = page["page"]
        if not text:
            continue
        source_pages.append(number)
        header = "\n".join(text.splitlines()[:12])
        key = _page_unit(text)
        # Appendix markers are running headings in these books. Only use
        # actual page headings, never mentions of Grammar in a contents table.
        for pattern, label in _APPENDICES:
            # A lesson's Grammar Focus is not the book's Grammar appendix,
            # including editions where its decorative lettering was split.
            if label == "语法参考" and not appendix and (key or re.search(r"\bF\s*o\s*c\s*u\s*s\b", header, re.I)):
                continue
            if body_started and re.search(r"(?im)^\s*(?:\d+\s+)?" + pattern + r"\s*$", header):
                if appendix != label:
                    current_group = None
                    current_section = "参考内容"
                appendix = label
                break
        if not body_started:
            # The first teaching page has a real unit heading and activities.
            # Contents tables can mention all units and must remain source-only.
            if key and re.search(r"language\s+goals?|section\s*[ab]|\b1a\b|\b1b\b", text, re.I):
                body_started = True
            else:
                root.content = f"{root.content or ''}\n\n### 原文第 {number} 页\n\n{text}".strip()
                continue
        group_key = f"appendix:{appendix}" if appendix else (f"{key[0]} {key[1]}" if key else None)
        if group_key and (current_group is None or current_group.metadata_["group_key"] != group_key):
            if group_key not in groups:
                title = appendix if appendix else _unit_title(text, key)
                node = CourseContentTree(id=uuid.uuid4(), course_id=course_id, parent_id=root.id,
                    title=title, level=1, order_index=len(groups) + 1, source_file=source,
                    source_type="pdf", content_category="reference" if appendix else "textbook",
                    metadata_={"group_key": group_key, "source_pages": []})
                groups[group_key] = node
                nodes.append(node)
                if not appendix:
                    primary_units.append(group_key)
            current_group = groups[group_key]
            current_section = "参考内容" if appendix else "课文与练习"
        if current_group is None:
            # Even an unrecognized page stays accessible, never dropped.
            root.content = f"{root.content or ''}\n\n### 原文第 {number} 页\n\n{text}".strip()
            continue
        body_pages.append(number)
        current_group.metadata_["source_pages"].append(number)
        if not appendix:
            known_key = current_group.metadata_["group_key"]
            parts = known_key.rsplit(" ", 1)
            candidate = _unit_title(text, (parts[0], parts[1])).partition(" · ")[2]
            if candidate:
                title_candidates.setdefault(known_key, Counter())[candidate.replace("’", "'")] += 1
        if appendix:
            current_section = f"{key[0]} {key[1]}" if key else current_section
        else:
            section_match = re.search(r"(?im)^\s*section\s*([ab])\b", header)
            if section_match:
                current_section = "基础对话与练习" if section_match.group(1).upper() == "A" else "综合阅读与表达"
        section_key = (current_group.id, current_section)
        if section_key not in sections:
            child = CourseContentTree(id=uuid.uuid4(), course_id=course_id, parent_id=current_group.id,
                title=current_section, level=2, order_index=sum(node.parent_id == current_group.id for node in nodes) + 1,
                source_file=source, source_type="pdf", content_category=current_group.content_category,
                metadata_={"source_pages": [], "ocr_pages": []})
            nodes.append(child)
            sections[section_key] = child
        child = sections[section_key]
        child.metadata_["source_pages"].append(number)
        if page["method"] == "ocr":
            child.metadata_["ocr_pages"].append(number)
            child.metadata_["requires_original_review"] = True
        if page.get("confidence", 1) < 0.8:
            child.metadata_.setdefault("low_confidence_pages", []).append(number)
        child.content = f"{child.content or ''}\n\n### 原文第 {number} 页\n\n{text}".strip()
    if not primary_units:
        raise EnglishTextbookExtractionError("英语教材正文单元未识别，不能将空目录标记为解析成功。")
    for group_key, candidates in title_candidates.items():
        detail, count = candidates.most_common(1)[0]
        if count >= 2:
            # Repeated printed headers are evidence for repairing a damaged
            # first-page OCR title (e.g. T'd → I'd), not a guessed syllabus.
            groups[group_key].title = f"{group_key} · {detail}"
            groups[group_key].metadata_["title_source"] = "repeated_page_heading"
    for node in sections.values():
        if node.metadata_["ocr_pages"]:
            node.content = "> 本节为扫描识别文字。题图、表格及音标请结合课本原文阅读。\n\n" + (node.content or "")
    report = root.metadata_["extraction"] or {}
    accounted = len(source_pages) + len(report.get("blank_pages", [])) + len(report.get("visual_only_pages", []))
    if accounted != report.get("total", len(matches)):
        raise EnglishTextbookExtractionError("英语教材页数核对未通过，部分页面尚未处理完成。")
    numbers = [int(key.split()[-1]) for key in primary_units if not key.startswith("Starter")]
    expected = set(report.get("expected_units", []))
    missing = sorted(expected - set(primary_units))
    missing += [f"Unit {n}" for n in sorted(set(range(1, max(numbers, default=0) + 1)) - set(numbers))
                if f"Unit {n}" not in missing]
    if missing:
        raise EnglishTextbookExtractionError(f"英语教材缺少正文单元：{missing}。请重试解析，不能用书后注释代替课文。")
    root.metadata_["extraction"] = {**report, "primary_units": primary_units, "body_pages": body_pages,
        "accounted_pages": accounted, "unit_coverage": 1.0, "appendices": list(dict.fromkeys(
            node.title for node in groups.values() if node.metadata_["group_key"].startswith("appendix:")
        ))}
    return nodes
