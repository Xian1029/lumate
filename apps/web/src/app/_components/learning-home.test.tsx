import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LearningHomeOverview } from "@/lib/api";
import { FirstSpaceEmptyState, LearningSummary, PendingPlansSection, ProcessingSection, ReviewSection, SpacesSection, TodayTasksSection } from "./learning-home";

const navigate = vi.fn();

const overview: LearningHomeOverview = {
  current_learning_action: null,
  pending_learning_plans: [{ plan: { id: "plan-1", course_id: "course-1", goal_id: null, title: "期中复习", description: null, source: "AI", status: "PENDING_APPROVAL", version: 1, start_date: null, target_date: "2026-10-01", available_minutes_per_day: 30, study_days_of_week: null, total_estimated_minutes: null, approved_at: null, activated_at: null, completed_at: null, cancelled_at: null, created_at: null }, task_count: 3, completed_task_count: 0, remaining_minutes: 60 }],
  today_tasks: [{ id: "task-1", plan_id: "plan-1", course_id: "course-1", content_node_id: null, knowledge_point_id: null, task_type: "LEARN", title: "学习相反数", instruction: null, action_href: null, scheduled_for: "2026-09-20T00:00:00Z", estimated_minutes: 15, sequence: 1, required: true, status: "READY", completed_at: null, postponed_to: null, planning_reason: null, href: "/learning-plans/plan-1" }],
  upcoming_tasks: [],
  today_summary: { estimated_minutes: 15, completed_count: 0, total_count: 1 },
  learning_spaces: [{ id: "course-1", name: "七年级数学", description: null, status: "IN_PROGRESS", status_label: "正在学习", current_node_title: "相反数", completed_learning_items: 2, total_learning_items: 8, progress_percent: 25, action_label: "继续学习", target_route: "/course/course-1?node=node-1&module=CONTENT", review_count: 0, today_task_count: 1 }],
  processing_uploads: [{ id: "job-1", name: "数学课本.pdf", course_id: "course-1", status: "extracting", phase_label: "正在提取目录", progress_percent: 30, href: "/new" }],
  review_queue: [{ course_id: "course-1", course_name: "七年级数学", count: 2, estimated_minutes: 6, highest_priority_knowledge: "正数和负数", priority: 0.8, href: "/course/course-1/review" }],
  recent_learning: null,
  learning_summary: { active_workspace_count: 1, today_task_count: 1, completed_task_count_this_week: 0, review_due_count: 2, completed_learning_items: 2, total_learning_items: 8, progress_percent: 25 },
};

describe("learning home protected features", () => {
  it("keeps both first-learning-space creation paths visible", () => {
    render(<FirstSpaceEmptyState onNavigate={navigate} />);
    expect(screen.getByRole("button", { name: "上传学习资料" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "手动创建学习空间" })).toBeInTheDocument();
  });

  it("renders every conditional protected entry when its server data exists", async () => {
    const user = userEvent.setup();
    navigate.mockClear();
    render(<><PendingPlansSection plans={overview.pending_learning_plans} onNavigate={navigate} /><TodayTasksSection overview={overview} onNavigate={navigate} /><ProcessingSection uploads={overview.processing_uploads} onNavigate={navigate} /><ReviewSection reviews={overview.review_queue} onNavigate={navigate} /><SpacesSection spaces={overview.learning_spaces} onNavigate={navigate} /></>);
    expect(screen.getByText("你有一个学习计划等待确认")).toBeInTheDocument();
    expect(screen.getAllByText("学习相反数").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("数学课本.pdf")).toBeInTheDocument();
    expect(screen.getByText("优先复习：正数和负数 · 约 6 分钟")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /新建学习空间/ }).length).toBeGreaterThanOrEqual(1);
    await user.click(screen.getByText("查看并确认"));
    expect(navigate).toHaveBeenCalledWith("/learning-plans/plan-1/review");
    await user.click(screen.getByText("数学课本.pdf"));
    expect(navigate).toHaveBeenCalledWith("/new");
    await user.click(screen.getByText("开始复习"));
    expect(navigate).toHaveBeenCalledWith("/course/course-1/review");
  });

  it("uses the server-provided resume route instead of reopening the course root", async () => {
    const user = userEvent.setup();
    navigate.mockClear();
    render(<SpacesSection spaces={overview.learning_spaces} onNavigate={navigate} />);

    expect(screen.getByText("正在学习：相反数")).toBeInTheDocument();
    expect(screen.getByText("已完成 2 / 8 个学习内容")).toBeInTheDocument();
    await user.click(screen.getByText("继续学习"));
    expect(navigate).toHaveBeenCalledWith("/course/course-1?node=node-1&module=CONTENT");
  });

  it("shows destructive space actions only while management mode is active", async () => {
    const user = userEvent.setup();
    render(<SpacesSection spaces={overview.learning_spaces} onNavigate={navigate} onDelete={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /删除学习空间/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "管理空间" }));
    expect(screen.getByRole("button", { name: /删除学习空间/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成管理" })).toBeInTheDocument();
  });

  it("renders weighted overall progress and per-space progress from the server view model", () => {
    render(<LearningSummary overview={overview} onNavigate={navigate} />);
    expect(screen.getByText("已完成 2 / 8 个学习内容，按内容数量加权计算。")).toBeInTheDocument();
    expect(screen.getByText("完成 2/8")).toBeInTheDocument();
    expect(screen.getByText("今日 1 项")).toBeInTheDocument();
  });
});
