"""Regression coverage for the learner-facing home-space card model."""

import uuid

from models.content import CourseContentTree
from models.course import Course
from models.learning_task import LearningTask
from models.progress import LearningProgress
from routers.learning_plan_dashboard import _workspace_progress_view_model
from services.learning_progress import aggregate_course_progress_views, course_progress_snapshot, course_progress_view


def _course() -> Course:
    return Course(id=uuid.uuid4(), name="七年级数学上册")


def _node(course: Course, title: str, order_index: int = 1) -> CourseContentTree:
    return CourseContentTree(
        id=uuid.uuid4(), course_id=course.id, title=title,
        level=2, order_index=order_index, content_category="textbook",
    )


def test_new_space_starts_at_first_real_learning_node_with_zero_progress():
    course = _course()
    first = _node(course, "正数和负数")
    later = _node(course, "数轴", order_index=2)

    card = _workspace_progress_view_model(
        course=course, nodes=[first, later], progress_rows=[], task=None,
        task_href=None, recent_session=None,
    )

    assert card["status"] == "NOT_STARTED"
    assert card["progress_percent"] == 0
    assert card["action_label"] == "开始学习"
    assert card["target_route"].endswith(f"/unit/{first.id}")


def test_started_space_resumes_the_last_real_learning_node():
    course = _course()
    node = _node(course, "数轴")
    progress = LearningProgress(
        course_id=course.id, content_node_id=node.id, status="in_progress",
    )

    card = _workspace_progress_view_model(
        course=course, nodes=[node], progress_rows=[progress], task=None,
        task_href=None, recent_session=None,
    )

    assert card["status"] == "IN_PROGRESS"
    assert card["current_node_title"] == "数轴"
    assert card["action_label"] == "继续学习"
    assert card["target_route"].endswith(f"/unit/{node.id}")


def test_active_task_overrides_first_node_fallback_and_keeps_its_route():
    course = _course()
    node = _node(course, "相反数")
    task = LearningTask(
        id=uuid.uuid4(), course_id=course.id, content_node_id=node.id,
        title="完成相反数练习", status="READY",
    )

    card = _workspace_progress_view_model(
        course=course, nodes=[node], progress_rows=[], task=task,
        task_href="/course/example/unit/task-node", recent_session=None,
    )

    assert card["status"] == "TASK_READY"
    assert card["current_node_title"] == "相反数"
    assert card["target_route"] == "/course/example/unit/task-node"


def test_mastery_score_is_never_reused_as_completion_progress():
    course = _course()
    node = _node(course, "正数和负数")
    progress = LearningProgress(
        course_id=course.id, content_node_id=node.id,
        status="not_started", mastery_score=0.65,
    )

    card = _workspace_progress_view_model(
        course=course, nodes=[node], progress_rows=[progress], task=None,
        task_href=None, recent_session=None,
    )

    assert card["status"] == "NOT_STARTED"
    assert card["progress_percent"] == 0


def test_home_card_and_graph_progress_use_the_same_course_progress_view():
    course = _course()
    mastered = _node(course, "正数和负数")
    pending = _node(course, "数轴", order_index=2)
    rows = [LearningProgress(course_id=course.id, content_node_id=mastered.id, status="mastered")]

    card = _workspace_progress_view_model(
        course=course, nodes=[mastered, pending], progress_rows=rows, task=None,
        task_href=None, recent_session=None,
    )
    graph_view = course_progress_view(course_progress_snapshot([mastered, pending], rows))

    assert {key: card[key] for key in graph_view} == graph_view


def test_learning_summary_weights_the_same_workspace_progress_views_by_content_count():
    summary = aggregate_course_progress_views([
        {"completed_learning_items": 1, "total_learning_items": 2, "progress_percent": 50},
        {"completed_learning_items": 1, "total_learning_items": 8, "progress_percent": 12},
    ])

    assert summary == {
        "completed_learning_items": 2,
        "total_learning_items": 10,
        "progress_percent": 20,
    }
