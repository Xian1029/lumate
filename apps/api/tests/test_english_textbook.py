import json
import uuid

import pytest

from services.parser.english_textbook import (
    DOCUMENT_MARKER, EnglishTextbookExtractionError, english_markdown_to_tree,
    extract_english_textbook, is_english_textbook, normalize_english_page,
)
from services.parser.pdf import _markdown_to_tree, assess_textbook_outline_integrity


def envelope(pages, expected=None):
    report = {"total": len(pages), "parsed": len(pages), "blank_pages": [],
              "visual_only_pages": [], "ocr_pages": [], "expected_units": expected or ["Unit 1", "Unit 2"]}
    parts = [DOCUMENT_MARKER + json.dumps(report) + " -->"]
    for number, text in enumerate(pages, 1):
        parts.append('<!-- lumate-english-page:' + json.dumps({"page": number, "method": "text"}) + ' -->\n' + text)
    return '\n\n'.join(parts)


def test_english_keeps_body_scripts_words_and_grammar_in_separate_groups():
    markdown = envelope([
        'Units\nTopics Functions\nUnit 1\nUnit 2\nContents table',
        'UNIT 1\nSection A\nCan you swim?\nLanguage Goal: Talk about abilities\n1a Original lesson dialogue.',
        'UNIT 1\n3\nGrammar Focus\nI can swim.\nGrammar exercises.',
        'UNIT 2\nSection A\nWhat time is it?\nLanguage Goal: Talk about time\n1a Second original lesson.',
        'Tapescripts\nUnit 1\nSpeaker: This is the complete listening script.',
        'Words and Expressions in Each Unit\nUnit 1\nswim /swɪm/ 游泳',
        'Grammar\nThis appendix is not lesson Grammar Focus.',
    ])
    nodes = _markdown_to_tree(markdown, uuid.uuid4(), '英语七年级下册.pdf')
    titles = [n.title for n in nodes if n.level == 1]
    assert len([t for t in titles if t.startswith('Unit ')]) == 2
    assert {'听力原文', '单元词汇表', '语法参考'}.issubset(set(titles))
    assert any('complete listening script' in (n.content or '') for n in nodes)
    assert any('swɪm' in (n.content or '') for n in nodes)
    assert any('Original lesson dialogue' in (n.content or '') for n in nodes)
    assigned = [p for n in nodes if n.level == 2 for p in n.metadata_['source_pages']]
    assert sorted(assigned) == list(range(2, 8))
    complete, report = assess_textbook_outline_integrity(markdown, nodes)
    assert complete and report['accounted_pages'] == 7
    assert nodes[0].metadata_['extraction']['primary_units'] == ['Unit 1', 'Unit 2']


def test_missing_final_unit_is_not_hidden_by_complete_page_count():
    markdown = envelope([
        'UNIT 1\nSection A\nLanguage Goal: greetings\n1a Lesson.',
        'Notes on the Text\nUnit 2\nThis is only an appendix, not the missing lesson.',
    ])
    with pytest.raises(EnglishTextbookExtractionError, match='Unit 2'):
        english_markdown_to_tree(markdown, uuid.uuid4(), '英语七年级下册.pdf')


def test_duplicate_page_record_does_not_hide_a_missing_page():
    markdown = envelope([
        'Unit 1\nSection A\nLanguage Goal: learning\n1a Lesson.',
        'Unit 2\nSection A\nLanguage Goal: learning\n1a Lesson.',
    ]).replace('"page": 2', '"page": 1')
    with pytest.raises(EnglishTextbookExtractionError, match='缺页、重复或顺序'):
        english_markdown_to_tree(markdown, uuid.uuid4(), '英语七年级下册.pdf')


def test_english_normalization_repairs_header_and_preserves_ipa():
    result = normalize_english_page('U 1\nNIT\nSection\nA How are you?\nGrammar\nFo c u s\n/\uf053\uf049\uf070/\nI like\napples.')
    assert result.startswith('Unit 1\nSection A\nHow are you?')
    assert 'Grammar Focus' in result and '/ʃɪp/' in result
    assert 'like\napples' in result  # no arbitrary word-fragment concatenation


def test_english_route_is_not_used_for_other_subjects_or_ordinary_handouts():
    assert is_english_textbook('abcdef123456_义务教育教科书_英语_八年级_下册.pdf')
    assert not is_english_textbook('义务教育教科书语文七年级上册.pdf')
    assert not is_english_textbook('人教版初中数学 七年级上册 课本.pdf')
    assert not is_english_textbook('English meeting notes.pdf')


def test_scanned_pages_are_ocr_processed_instead_of_placeholder(monkeypatch, tmp_path):
    import pdfplumber
    from services.parser import english_textbook as module

    class Page:
        images = [object()]
        curves = []
        rects = []
        chars = []
        def dedupe_chars(self, **kwargs): return self
        def extract_text(self, **kwargs): return ''
        def close(self): pass

    class Document:
        pages = [Page(), Page()]
        def __enter__(self): return self
        def __exit__(self, *args): pass

    path = tmp_path / '英语七年级下册.pdf'
    path.write_bytes(b'%PDF-test')
    monkeypatch.setattr(pdfplumber, 'open', lambda _: Document())
    monkeypatch.setattr(module, '_cache_dir', lambda: tmp_path)
    monkeypatch.setattr(module, '_ocr_pages', lambda path, numbers: [
        {'page': n, 'text': f'Unit {n}\nSection A\nLanguage Goal: original content\n1a Real scanned dialogue.', 'confidence': 0.95}
        for n in numbers
    ])
    _, markdown = extract_english_textbook(str(path))
    nodes = _markdown_to_tree(markdown, uuid.uuid4(), path.name)
    assert nodes[0].metadata_['extraction']['ocr_pages'] == [1, 2]
    assert 'Real scanned dialogue' in ''.join(n.content or '' for n in nodes)
    assert '这是一份扫描版教材' not in markdown


def test_ocr_failure_cannot_be_reported_as_complete(monkeypatch, tmp_path):
    import pdfplumber
    from services.parser import english_textbook as module

    class Page:
        images = [object()]
        curves = []
        rects = []
        chars = []
        def dedupe_chars(self, **kwargs): return self
        def extract_text(self, **kwargs): return ''
        def close(self): pass
    class Document:
        pages = [Page()]
        def __enter__(self): return self
        def __exit__(self, *args): pass
    path = tmp_path / '英语八年级下册.pdf'
    path.write_bytes(b'%PDF-test')
    monkeypatch.setattr(pdfplumber, 'open', lambda _: Document())
    monkeypatch.setattr(module, '_cache_dir', lambda: tmp_path)
    monkeypatch.setattr(module, '_ocr_pages', lambda *_: [{'page': 1, 'error': 'OCR process failed'}])
    with pytest.raises(EnglishTextbookExtractionError, match='未完成'):
        extract_english_textbook(str(path))
