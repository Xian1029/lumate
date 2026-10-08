import uuid
from unittest.mock import patch

import pytest

from services.ingestion.document_loader import _crawl_result_to_extraction
from services.ingestion.pipeline import detect_mime_type
from services.ingestion.pipeline import run_ingestion_pipeline
from services.parser.pdf import _markdown_to_tree, assess_textbook_outline_coverage, assess_textbook_outline_integrity
from services.parser.url import scrape_url_to_tree
from services.content_text import is_non_learning_question
from models.content import CourseContentTree
from models.ingestion import IngestionJob
from routers.upload import _retire_replaced_failed_job


class _FakeDB:
    def __init__(self):
        self.added = []

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        return None

    async def commit(self):
        return None

    async def rollback(self):
        return None

    async def execute(self, _stmt):
        class _Res:
            def scalar_one_or_none(self):
                return None

            def scalars(self):
                class _Scalars:
                    def all(self):
                        return []

                    def __iter__(self):
                        # Some callers iterate scalars() directly instead of
                        # calling .all() — both shapes are valid for a real
                        # SQLAlchemy ScalarResult.
                        return iter([])

                return _Scalars()

        return _Res()


class _ReplacementDB:
    def __init__(self):
        self.deleted = []
        self.commits = 0

    async def delete(self, value):
        self.deleted.append(value)

    async def commit(self):
        self.commits += 1

    async def rollback(self):
        return None

    async def scalar(self, _stmt):
        # No remaining record points at the old file.  The test keeps
        # file_path empty, so no physical filesystem operation is attempted.
        return None


@pytest.mark.asyncio
async def test_successful_replacement_retires_only_the_old_failed_job():
    db = _ReplacementDB()
    failed_job = IngestionJob(status="failed", source_type="file")
    replacement = IngestionJob(
        status="embedding",
        dispatched=True,
        source_type="file",
    )

    retired = await _retire_replaced_failed_job(
        db,
        failed_job=failed_job,
        replacement_job=replacement,
    )

    assert retired is True
    assert db.deleted == [failed_job]
    assert db.commits == 1


@pytest.mark.asyncio
async def test_failed_or_unusable_replacement_never_removes_the_old_failure():
    db = _ReplacementDB()
    failed_job = IngestionJob(status="failed", source_type="file")
    replacement = IngestionJob(
        status="failed",
        dispatched=False,
        source_type="file",
    )

    retired = await _retire_replaced_failed_job(
        db,
        failed_job=failed_job,
        replacement_job=replacement,
    )

    assert retired is False
    assert db.deleted == []


def _assert_no_orphans(nodes):
    ids = {node.id for node in nodes}
    for node in nodes:
        if node.parent_id is not None:
            assert node.parent_id in ids


def test_markdown_tree_parent_ids_are_built_in_memory():
    course_id = uuid.uuid4()
    markdown = "# Chapter\nintro\n## Section\nbody\n### Topic\ndetails"

    nodes = _markdown_to_tree(markdown, course_id, "sample.pdf")

    assert len(nodes) >= 2
    _assert_no_orphans(nodes)


def test_markdown_tree_thinning_keeps_tree_consistent():
    course_id = uuid.uuid4()
    # Small content forces thinning on nested nodes.
    markdown = "# A\nx\n## B\ny\n### C\nz"

    nodes = _markdown_to_tree(markdown, course_id, "sample.pdf")

    assert len(nodes) >= 1
    _assert_no_orphans(nodes)


def test_markdown_tree_no_heading_fallback_keeps_parent_links():
    course_id = uuid.uuid4()
    markdown = "para1\n\npara2\n\npara3"

    nodes = _markdown_to_tree(markdown, course_id, "sample.pdf")

    assert len(nodes) >= 1
    _assert_no_orphans(nodes)


def test_pdf_outline_groups_contents_and_preface_and_keeps_lesson_sections():
    course_id = uuid.uuid4()
    markdown = """# 目录
第一章 有理数 …… 1

# 前言
本书供学生使用。编写说明见后文。

# 第一章 有理数
## 1.1 正数和负数
正数和负数可以表示具有相反意义的量。例如，收入记为正数，支出记为负数。理解它们的关系能帮助我们解决生活中的比较问题。
"""

    nodes = _markdown_to_tree(markdown, course_id, "math.pdf")
    titles = {node.title for node in nodes}

    assert "前言与目录" in titles
    assert "1.1 正数和负数" in titles
    _assert_no_orphans(nodes)


def test_textbook_outline_coverage_rejects_missing_sections():
    markdown = """# 目录
1.1 正数和负数
1.2 数轴
1.3 相反数
1.4 绝对值

# 第一章 有理数
## 1.1 正数和负数
正文内容。
## 1.2 数轴
正文内容。
"""
    nodes = _markdown_to_tree(markdown, uuid.uuid4(), "math.pdf")

    complete, missing = assess_textbook_outline_coverage(markdown, nodes)

    assert not complete
    assert missing == ["1.3", "1.4"]


def test_textbook_outline_coverage_accepts_complete_sections_without_chapter_spacing():
    markdown = """# 目录
1.1 正数和负数
1.2 数轴
1.3 相反数
1.4 绝对值

# 第一章有理数
## 1.1 正数和负数
正文内容。
## 1.2 数轴
正文内容。
## 1.3 相反数
正文内容。
## 1.4 绝对值
正文内容。
"""
    nodes = _markdown_to_tree(markdown, uuid.uuid4(), "math.pdf")

    complete, missing = assess_textbook_outline_coverage(markdown, nodes)

    assert complete
    assert missing == []


def test_textbook_outline_integrity_flags_title_or_order_changes():
    markdown = """# 目录
1.1 正数和负数
1.2 数轴
1.3 相反数
1.4 绝对值

# 第一章 有理数
## 1.1 正数和负数
## 1.3 相反数
## 1.2 被改写的标题
## 1.4 绝对值
"""
    nodes = _markdown_to_tree(markdown, uuid.uuid4(), "math.pdf")

    complete, report = assess_textbook_outline_integrity(markdown, nodes)

    assert not complete
    assert report["order_mismatch"] is True
    assert report["title_mismatches"] == ["1.2"]


def test_textbook_outline_recovers_fragmented_publisher_toc_and_glyph_prefixes():
    """Regression: PEP PDFs split digits and join page numbers to the next ID."""
    markdown = """目 录
第二十六章 反比例函数
２６ ． １ 反比例函数 ２信息技术应用 探索性质 １０２６ ． ２ 实际问题与反比例函数 １２
第二十七章 相似
２７ ． １ 图形的相似 ２４２７ ． ２ 相似三角形 ２９

第二十六章 反比例函数
/G21/G22/G23２６ ． １反比例函数
正文内容。
２６ ． ２实际问题与反比例函数
正文内容。
第二十七章 相似
/G21/G22/G23２７ ． １图形的相似
正文内容。
２７ ． ２相似三角形
正文内容。
"""
    # Force paragraph fallback to produce multiple page-shaped chunks, matching
    # a real extracted textbook rather than a tiny hand-written sample.
    markdown += "\n\n" + "补充学习内容。" * 500
    nodes = _markdown_to_tree(markdown, uuid.uuid4(), "pep-grade-nine.pdf")
    complete, report = assess_textbook_outline_integrity(markdown, nodes)
    sections = {node.title for node in nodes if node.level == 2}

    assert complete, report
    assert {
        "26.1 反比例函数",
        "26.2 实际问题与反比例函数",
        "27.1 图形的相似",
        "27.2 相似三角形",
    } <= sections


def test_textbook_outline_ignores_page_number_joined_to_section_number():
    """Regression: page 6 followed by 1.2 must not become section 61.2."""
    markdown = """目 录
第一章 有理数 １１ ． １ 正数和负数 ２
阅读与思考 用正负数表示允许偏差 ６１ ． ２ 有理数及其大小比较 ７
第二章 有理数的运算 ２４２ ． １ 有理数的加法与减法 ２５
阅读与思考 数学史 ３７２ ． ２ 有理数的乘法与除法 ３８

第一章 有理数
１ ． １ 正数和负数
正文内容。
１ ． ２ 有理数及其大小比较
正文内容。
第二章 有理数的运算
２ ． １ 有理数的加法与减法
正文内容。
２ ． ２ 有理数的乘法与除法
正文内容。
""" + ("补充学习内容。" * 500)

    nodes = _markdown_to_tree(markdown, uuid.uuid4(), "pep-grade-seven.pdf")
    complete, report = assess_textbook_outline_integrity(markdown, nodes)

    assert complete, report
    assert report["missing_sections"] == []
    assert report["expected_sections"] == 4


def test_chinese_chapter_numbers_above_ten_keep_arabic_sections():
    markdown = """# 第十一章不等式与不等式组
## 11.1 不等式
定义与性质。
## 11.2 一元一次不等式
解法与应用。
# 第十二章数据的收集、整理与描述
## 12.1 统计调查
全面调查与抽样调查。
## 12.2 用统计图描述数据
统计图的选择。
"""

    nodes = _markdown_to_tree(markdown, uuid.uuid4(), "math.pdf")
    titles = {node.title for node in nodes}

    assert {"11.1 不等式", "11.2 一元一次不等式", "12.1 统计调查", "12.2 用统计图描述数据"} <= titles


def test_structural_recall_questions_are_not_learning_questions():
    assert is_non_learning_question("七年级上册数学课本中，第一章的标题是什么？")
    assert not is_non_learning_question("正数和负数分别怎样表示相反意义的量？")


def test_detect_mime_type_fallback_on_detector_errors():
    class _BadFiletype:
        @staticmethod
        def guess(_data):
            raise RuntimeError("boom")

    class _BadMagic:
        @staticmethod
        def from_buffer(_data, mime=True):
            raise RuntimeError("boom")

    with patch.dict("sys.modules", {"filetype": _BadFiletype, "magic": _BadMagic}):
        assert detect_mime_type("doc.pdf", b"%PDF-1.7 content") == "application/pdf"


def test_crawl_result_to_extraction_handles_missing_markdown():
    class _Result:
        markdown = None

    extraction = _crawl_result_to_extraction(_Result(), "https://example.com")
    assert extraction.title == "https://example.com"
    assert extraction.content == ""


@pytest.mark.asyncio
async def test_scrape_url_to_tree_returns_empty_on_extraction_error():
    with patch("services.ingestion.document_loader.extract_content", side_effect=RuntimeError("x")):
        nodes = await scrape_url_to_tree("https://example.com", uuid.uuid4())
    assert nodes == []


@pytest.mark.asyncio
async def test_run_ingestion_pipeline_file_sets_source_fields():
    db = _FakeDB()
    user_id = uuid.uuid4()
    course_id = uuid.uuid4()

    with patch(
        "services.ingestion.pipeline.extract_content_with_title",
        return_value=(
            "lecture01.pdf",
            "# Chapter 1\nSection 1.1 overview with enough descriptive text to exceed fifty characters.",
        ),
    ):
        job = await run_ingestion_pipeline(
            db=db,
            user_id=user_id,
            file_path="/tmp/test.pdf",
            filename="lecture01.pdf",
            course_id=course_id,
            file_bytes=None,
        )

    nodes = [x for x in db.added if isinstance(x, CourseContentTree)]
    assert job.status == "completed"
    assert job.progress_percent == 100
    assert job.embedding_status == "pending"
    assert job.nodes_created == len(nodes)
    assert nodes
    assert all(n.source_type == "file" for n in nodes)
    assert all(n.source_file == "lecture01.pdf" for n in nodes)


@pytest.mark.asyncio
async def test_run_ingestion_pipeline_url_sets_source_fields():
    db = _FakeDB()
    user_id = uuid.uuid4()
    course_id = uuid.uuid4()
    target_url = "https://example.com/lesson"

    with patch(
        "services.ingestion.pipeline.extract_content_with_title",
        return_value=(
            target_url,
            "# Chapter 1\n"
            "Section 1.1 overview with enough descriptive text to exceed fifty characters.",
        ),
    ):
        job = await run_ingestion_pipeline(
            db=db,
            user_id=user_id,
            url=target_url,
            filename="",
            course_id=course_id,
            file_bytes=None,
        )

    nodes = [x for x in db.added if isinstance(x, CourseContentTree)]
    assert job.status == "completed"
    assert job.progress_percent == 100
    assert job.embedding_status == "pending"
    assert job.nodes_created == len(nodes)
    assert nodes
    assert all(n.source_type == "url" for n in nodes)
    assert all(n.source_file == target_url for n in nodes)


@pytest.mark.asyncio
async def test_run_ingestion_pipeline_preserves_original_error_when_setup_fails_early():
    db = _FakeDB()

    with patch(
        "services.ingestion.pipeline.detect_mime_type",
        side_effect=RuntimeError("mime detection broke"),
    ):
        job = await run_ingestion_pipeline(
            db=db,
            user_id=uuid.uuid4(),
            file_path="/tmp/test.pdf",
            filename="lecture01.pdf",
            course_id=uuid.uuid4(),
            file_bytes=b"%PDF-1.7 test",
        )

    assert job.status == "failed"
    assert job.error_message == "mime detection broke"
    assert getattr(job, "_canvas_file_urls", []) == []
    assert getattr(job, "_canvas_quiz_questions", []) == []
    assert getattr(job, "_canvas_assignments_data", []) == []
