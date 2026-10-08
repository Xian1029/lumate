"""Contract tests for the exam-prep request schema.

A normal exam-prep request must never 422 on UUID/optional-field parsing.
The frontend sends ``content_node_id`` (possibly ``""`` or ``null``) and
``exam_topic`` (possibly ``""``); the schema normalizes both to ``None``.
"""

import uuid

from routers.workflows import ExamPrepRequest


def _cid() -> str:
    return str(uuid.uuid4())


def test_normal_request_parses():
    body = ExamPrepRequest(course_id=_cid(), days_until_exam=7)
    assert body.content_node_id is None
    assert body.exam_topic is None
    assert body.days_until_exam == 7
    assert body.language == "zh"


def test_empty_content_node_id_becomes_none():
    body = ExamPrepRequest(course_id=_cid(), content_node_id="")
    assert body.content_node_id is None


def test_null_content_node_id_becomes_none():
    body = ExamPrepRequest(course_id=_cid(), content_node_id=None)
    assert body.content_node_id is None


def test_valid_content_node_id_preserved():
    node_id = uuid.uuid4()
    body = ExamPrepRequest(course_id=_cid(), content_node_id=node_id)
    assert body.content_node_id == node_id


def test_empty_exam_topic_becomes_none():
    body = ExamPrepRequest(course_id=_cid(), exam_topic="")
    assert body.exam_topic is None


def test_chinese_input_preserved():
    body = ExamPrepRequest(course_id=_cid(), exam_topic="期中考试", language="zh")
    assert body.exam_topic == "期中考试"
    assert body.language == "zh"


def test_optional_omitted_fields_default():
    body = ExamPrepRequest(course_id=_cid())
    assert body.content_node_id is None
    assert body.exam_topic is None
    assert body.language == "zh"
    assert body.days_until_exam == 7


def test_days_until_exam_range_is_validated():
    # Out-of-range values must still be rejected by Pydantic (not silently
    # accepted); the fix must not loosen validation.
    from pydantic import ValidationError

    try:
        ExamPrepRequest(course_id=_cid(), days_until_exam=0)
    except ValidationError:
        pass
    else:
        raise AssertionError("days_until_exam=0 should be rejected")
