import uuid

from services.content_text import clean_course_text, normalize_pdf_markdown
from services.parser.pdf import _markdown_to_tree


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


def test_unheaded_material_is_split_into_readable_sections() -> None:
    nodes = _markdown_to_tree(
        "第一段内容。这里有完整的说明。\n\n第二段内容。这里还有一个知识点。",
        uuid.uuid4(),
        "学习资料.pdf",
    )

    assert len(nodes) >= 2
    assert all((node.title or "").strip() for node in nodes)
