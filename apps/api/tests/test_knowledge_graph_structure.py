import uuid
from types import SimpleNamespace

from services.knowledge.graph import _structural_prerequisite_pairs
from services.loom_extraction import _select_extraction_chunks


def node(title: str, parent_id=None, order_index: int = 0):
    return SimpleNamespace(
        id=uuid.uuid4(), title=title, parent_id=parent_id, order_index=order_index,
    )


def test_formally_numbered_sibling_lessons_get_prerequisites():
    chapter = uuid.uuid4()
    first = node("1.1 正数和负数", chapter, 1)
    second = node("1.2 有理数及其大小比较", chapter, 2)
    third = node("1.3 有理数的加法", chapter, 3)

    assert _structural_prerequisite_pairs([first, second, third]) == [
        (second.id, first.id),
        (third.id, second.id),
    ]


def test_document_order_without_formal_numbering_is_not_a_prerequisite():
    parent = uuid.uuid4()
    first = node("项目背景", parent, 1)
    second = node("实施计划", parent, 2)

    assert _structural_prerequisite_pairs([first, second]) == []


def test_extraction_chunk_selection_covers_the_whole_material():
    items = list(range(100))
    selected = _select_extraction_chunks(items, limit=8)

    assert len(selected) == 8
    assert selected[0] == 0
    assert selected[-1] == 99
    assert selected != items[:8]
