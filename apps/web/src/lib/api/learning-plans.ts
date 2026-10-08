import { request } from "./client";

export type LearningPlanStatus = "DRAFT" | "PENDING_APPROVAL" | "CHANGES_REQUESTED" | "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
export type LearningTaskStatus = "PENDING" | "READY" | "IN_PROGRESS" | "COMPLETED" | "POSTPONED" | "MISSED" | "SKIPPED";
export type LearningTaskType = "LEARN" | "PRACTICE" | "FLASHCARD" | "REVIEW" | "REFLECTION" | "ASSESSMENT" | "NOTE";

export interface LearningPlan { id: string; course_id: string; goal_id: string | null; title: string; description: string | null; source: string; status: LearningPlanStatus; version: number; start_date: string | null; target_date: string | null; available_minutes_per_day: number | null; study_days_of_week: number[] | null; total_estimated_minutes: number | null; supersedes_plan_id?: string | null; approved_at: string | null; activated_at: string | null; completed_at: string | null; cancelled_at: string | null; created_at: string | null; }
export interface LearningTask { id: string; plan_id: string; course_id: string; content_node_id: string | null; knowledge_point_id: string | null; task_type: LearningTaskType; title: string; instruction: string | null; action_href: string | null; scheduled_for: string | null; estimated_minutes: number | null; sequence: number; required: boolean; status: LearningTaskStatus; completed_at: string | null; postponed_to: string | null; planning_reason: string | null; }
export interface StartLearningPlanResult { plan: LearningPlan; task: LearningTask; href: string; target_module: string; relocated: boolean; }
export interface HomeLearningTask extends LearningTask { href: string; }
export interface LearningPlanSummary { plan: LearningPlan; task_count: number; completed_task_count: number; remaining_minutes: number; }
export interface LearningPlanDashboard { pending_plans: LearningPlanSummary[]; active_plans: LearningPlanSummary[]; today_tasks: LearningTask[]; current_task: LearningTask | null; next_task: LearningTask | null; }
export interface HomeLearningAction { course_id: string | null; content_node_id: string | null; knowledge_point_id?: string | null; learning_task_id: string | null; plan_id?: string | null; recommendation_id?: string | null; action_type: string; target_module?: string; title: string; instruction?: string | null; action_text: string; reason: string; href: string; }
export type LearningSpaceCardStatus = "NOT_STARTED" | "TASK_READY" | "IN_PROGRESS" | "COMPLETED";
/** Server-owned card view model. `progress_percent` is completed learning
 * content / total learning content — never upload progress or mastery. */
export interface HomeLearningSpace {
  id: string;
  name: string;
  description: string | null;
  status: LearningSpaceCardStatus;
  status_label: string;
  current_node_title: string | null;
  completed_learning_items: number;
  total_learning_items: number;
  progress_percent: number | null;
  action_label: string;
  target_route: string;
  review_count: number;
  today_task_count: number;
}
export interface HomeProcessingUpload { id: string; name: string; course_id: string | null; status: string; phase_label: string; progress_percent: number; href: string; }
export interface HomeReviewItem { course_id: string; course_name: string; count: number; estimated_minutes: number; highest_priority_knowledge: string; priority: number; href: string; }
export interface WorkspaceLearningProgress { completed_learning_items: number; total_learning_items: number; progress_percent: number | null; }
export interface LearningHomeOverview { current_learning_action: HomeLearningAction | null; draft_learning_plans?: LearningPlanSummary[]; pending_learning_plans: LearningPlanSummary[]; today_tasks: HomeLearningTask[]; upcoming_tasks: HomeLearningTask[]; today_summary: { estimated_minutes: number; completed_count: number; total_count: number }; learning_spaces: HomeLearningSpace[]; processing_uploads: HomeProcessingUpload[]; review_queue: HomeReviewItem[]; recent_learning: { course_id: string; course_name: string; content_node_id?: string | null; knowledge_point_id?: string | null; target_module?: string; content_title: string | null; at: string; href: string } | null; learning_summary: { active_workspace_count: number; today_task_count: number; completed_task_count_this_week: number; review_due_count: number; completed_learning_items: number; total_learning_items: number; progress_percent: number | null }; }

export const listLearningPlans = (courseId?: string, status?: LearningPlanStatus) => request<LearningPlan[]>(`/learning-plans/${courseId || status ? `?${new URLSearchParams({ ...(courseId ? { course_id: courseId } : {}), ...(status ? { status } : {}) })}` : ""}`, { retry: false });
export const createLearningPlan = (body: { course_id: string; title: string; description?: string | null; target_date?: string | null; available_minutes_per_day?: number | null; source?: "USER" | "AI"; draft_payload?: Record<string, unknown> }) => request<LearningPlan>("/learning-plans/", { method: "POST", body: JSON.stringify(body) });
export const getLearningPlan = (planId: string) => request<LearningPlan>(`/learning-plans/${planId}`);
export const deleteLearningPlan = (planId: string) => request<void>(`/learning-plans/${planId}`, { method: "DELETE" });
export const listLearningPlanTasks = (planId: string) => request<LearningTask[]>(`/learning-plans/${planId}/tasks`);
export type LearningTaskInput = { title: string; task_type: LearningTaskType; sequence: number; content_node_id?: string | null; knowledge_point_id?: string | null; instruction?: string | null; action_href?: string | null; scheduled_for?: string | null; estimated_minutes?: number | null; required?: boolean; planning_reason?: string | null };
export const createLearningTask = (planId: string, body: LearningTaskInput) => request<LearningTask>(`/learning-plans/${planId}/tasks`, { method: "POST", body: JSON.stringify(body) });
export const updateLearningTask = (planId: string, taskId: string, body: Partial<LearningTaskInput>) => request<LearningTask>(`/learning-plans/${planId}/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(body) });
export const updateLearningPlan = (planId: string, body: Partial<Pick<LearningPlan, "title" | "description" | "target_date" | "available_minutes_per_day" | "study_days_of_week">> & { expected_version?: number }) => request<LearningPlan>(`/learning-plans/${planId}`, { method: "PATCH", body: JSON.stringify(body) });
export const planAction = (planId: string, action: "submit" | "approve" | "request-changes" | "cancel" | "pause" | "resume" | "complete", reason?: string, expectedVersion?: number) => request<LearningPlan>(`/learning-plans/${planId}/${action}`, { method: "POST", body: JSON.stringify({ reason, expected_version: expectedVersion }) });
export const startLearningPlan = (planId: string) => request<StartLearningPlanResult>(`/learning-plans/${planId}/start`, { method: "POST" });
export const regenerateLearningPlan = (planId: string) => request<LearningTask[]>(`/learning-plans/${planId}/regenerate`, { method: "POST" });
export const getLearningPlanDashboard = () => request<LearningPlanDashboard>("/learning-plan-dashboard/");
/** One server-owned view model for the personal learning homepage. */
export const getLearningHomeOverview = () => request<LearningHomeOverview>("/learning-plan-dashboard/overview");
export const getCourseLearningPlanDashboard = (courseId: string) => request<{ draft_plan: LearningPlanSummary | null; pending_plan: LearningPlanSummary | null; active_plan: LearningPlanSummary | null; current_task: LearningTask | null; today_tasks: LearningTask[]; workspace_progress: WorkspaceLearningProgress }>(`/learning-plan-dashboard/course/${courseId}`);
export const taskAction = (taskId: string, action: "start" | "complete" | "skip" | "reopen") => request<LearningTask>(`/learning-tasks/${taskId}/${action}`, { method: "POST" });
export const postponeLearningTask = (taskId: string, postponedTo: string) => request<LearningTask>(`/learning-tasks/${taskId}/postpone`, { method: "POST", body: JSON.stringify({ postponed_to: postponedTo }) });

export const planStatusLabel: Record<LearningPlanStatus, string> = { DRAFT: "草稿", PENDING_APPROVAL: "待确认", CHANGES_REQUESTED: "待调整", ACTIVE: "进行中", PAUSED: "已暂停", COMPLETED: "已完成", CANCELLED: "已取消" };
export const taskStatusLabel: Record<LearningTaskStatus, string> = { PENDING: "待开始", READY: "可以开始", IN_PROGRESS: "进行中", COMPLETED: "已完成", POSTPONED: "已延后", MISSED: "待重新安排", SKIPPED: "已跳过" };
export const taskTypeLabel: Record<LearningTaskType, string> = { LEARN: "学习", PRACTICE: "练习", FLASHCARD: "复习卡片", REVIEW: "复习", REFLECTION: "总结", ASSESSMENT: "检测", NOTE: "整理笔记" };
