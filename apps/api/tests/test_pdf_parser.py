import uuid

from services.content_text import clean_course_text, normalize_pdf_markdown
from services.ingestion.classification import classify_by_content_heuristics, classify_by_filename
from services.parser.pdf import _markdown_to_tree
from services.parser.notes import build_fallback_notes


def test_pdf_cleanup_keeps_line_boundaries_and_removes_font_garbage() -> None:
    value = "第一单元\n春 天\n૫ે໓ྍJOEE\n第二单元"

    cleaned = clean_course_text(value)

    assert cleaned == "第一单元\n春天\n第二单元"
    assert "第一单元第二单元" not in cleaned


def test_language_textbook_uses_units_and_numbered_lessons() -> None:
    markdown = normalize_pdf_markdown(
        """I\n目录\n第一单元\n第二单元\n\n第一单元\n\n1 春\n春天的正文。\n\n2 济南的冬天\n冬天的正文。\n\n第二单元\n\n3 秋天的怀念\n秋天的正文。"""
    ) or ""

    nodes = _markdown_to_tree(markdown, uuid.uuid4(), "语文七年级上册.pdf")
    titles = [node.title for node in nodes]

    assert "第一单元" in titles
    assert "第二单元" in titles
    assert "1 春" in titles
    assert "2 济南的冬天" in titles
    assert "3 秋天的怀念" in titles
    assert all("૫" not in (node.title or "") for node in nodes)


def test_language_textbook_does_not_promote_joined_writing_prose_to_outline() -> None:
    # Real PEP language PDFs glue running headers to unit markers and may
    # concatenate a writing heading with its first explanatory sentence.
    markdown = normalize_pdf_markdown(
        """目录
第一单元
2 首届诺贝尔奖颁发

第一单元活动·探究
1 消息二则
消息正文。
2 首届诺贝尔奖颁发
课文正文。
写作消息时，首先要确定一个恰当的标题。标题要准确概括消息的主要内容，如
《首届诺贝尔奖颁发》。
第二单元
6 藤野先生
课文正文。"""
    ) or ""

    nodes = _markdown_to_tree(markdown, uuid.uuid4(), "语文八年级上册.pdf")
    titles = [node.title for node in nodes]

    assert "第一单元" in titles
    assert "1 消息二则" in titles
    assert "2 首届诺贝尔奖颁发" in titles
    assert not any("写作消息时" in (title or "") for title in titles)


def test_unheaded_material_is_split_into_readable_sections() -> None:
    nodes = _markdown_to_tree(
        "第一段内容。这里有完整的说明。\n\n第二段内容。这里还有一个知识点。",
        uuid.uuid4(),
        "学习资料.pdf",
    )

    assert len(nodes) >= 2
    assert all((node.title or "").strip() for node in nodes)


def test_unheaded_notes_do_not_promote_inline_toc_words_links_or_tables() -> None:
    nodes = _markdown_to_tree(
        """PBLWorks内容梳理

一、基本信息与成立背景
PBLWorks是一家教育机构。服务与产品目录中有更多说明。

https://www.pblworks.org/about

| 维度 | 介绍 |
| --- | --- |
| 成立时间 | 1987年 |

二、合作方式
企业可以先核实授权范围。""",
        uuid.uuid4(),
        "PBLWorks相关内容梳理.docx",
    )
    titles = [node.title for node in nodes]

    assert "一、基本信息与成立背景" in titles
    assert "二、合作方式" in titles
    assert not any(title.startswith("http") for title in titles)
    assert not any(title.startswith("|") for title in titles)
    assert not any("服务与产品目录中" in title for title in titles)


def test_formal_toc_hint_without_body_boundary_uses_topic_titles() -> None:
    nodes = _markdown_to_tree(
        """调研报告

调研时间：2026年9月14日

目录

一、摘要
这是摘要正文。

二、学院概况
这是概况正文。""",
        uuid.uuid4(),
        "调研报告.docx",
    )
    titles = [node.title for node in nodes]

    assert "一、摘要" in titles
    assert "二、学院概况" in titles
    assert "调研时间：2026年9月14日" not in titles


def test_chinese_textbook_names_and_directory_markers_are_classified_locally() -> None:
    assert classify_by_filename("人教版初中数学 七年级上册 课本.pdf") == "textbook"
    assert classify_by_filename("义务教育教科书语文七年级下册.pdf") == "textbook"
    assert classify_by_filename("京版7上_opt.pdf") == "textbook"
    assert classify_by_content_heuristics("义务教育教科书\n目录\n第一章 有理数\n1.1 正数和负数") == "textbook"


def test_fallback_notes_are_structured_instead_of_raw_source_wall() -> None:
    note = build_fallback_notes(
        "春天来了。小草从土里钻出来，嫩嫩的。\n\n春风像母亲的手。",
        "1 春",
    )

    assert "# 1 春" in note
    assert "## 本节学什么" in note
    assert "## 核心内容" in note
    assert "## 自测一下" in note
    assert "小草从土里钻出来" in note
