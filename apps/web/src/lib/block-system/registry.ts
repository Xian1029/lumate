import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { BlockType, BlockSize } from "./types";

export interface BlockComponentProps {
  courseId: string;
  blockId: string;
  config: Record<string, unknown>;
  aiActionsEnabled: boolean;
}

export interface BlockRegistryEntry {
  type: BlockType;
  label: string;
  labelZh: string;
  labelKey: string;
  icon: string;
  description: string;
  descriptionKey: string;
  defaultSize: BlockSize;
  defaultConfig: Record<string, unknown>;
  component: LazyExoticComponent<ComponentType<BlockComponentProps>>;
}

const entry = (
  type: BlockType,
  label: string,
  labelZh: string,
  labelKey: string,
  icon: string,
  description: string,
  descriptionKey: string,
  defaultSize: BlockSize,
  defaultConfig: Record<string, unknown>,
  loader: () => Promise<{ default: ComponentType<BlockComponentProps> }>,
): BlockRegistryEntry => ({
  type,
  label,
  labelZh,
  labelKey,
  icon,
  description,
  descriptionKey,
  defaultSize,
  defaultConfig,
  component: lazy(loader),
});

export const BLOCK_REGISTRY: Record<BlockType, BlockRegistryEntry> = {
  chapter_list: entry(
    "chapter_list", "Chapters", "章节目录", "ui.course_outline", "BookOpen",
    "Course content outline", "ui.course_outline",
    "full", {},
    () => import("@/components/blocks/blocks/chapter-list-block"),
  ),
  notes: entry(
    "notes", "Notes", "笔记", "ui.ai_notes", "FileText",
    "AI-generated study notes", "ui.ai_study_notes",
    "large", {},
    () => import("@/components/blocks/blocks/notes-block"),
  ),
  quiz: entry(
    "quiz", "Quiz", "测验", "ui.quiz", "CircleHelp",
    "Practice questions and quizzes", "ui.practice_quizzes",
    "medium", { difficulty: "adaptive" },
    () => import("@/components/blocks/blocks/quiz-block"),
  ),
  flashcards: entry(
    "flashcards", "Flashcards", "闪卡", "ui.flashcards", "Layers",
    "Spaced repetition flashcards", "ui.spaced_flashcards",
    "medium", {},
    () => import("@/components/blocks/blocks/flashcards-block"),
  ),
  progress: entry(
    "progress", "Progress", "学习进度", "ui.course_progress", "BarChart3",
    "Mastery and completion stats", "ui.mastery_stats",
    "small", {},
    () => import("@/components/blocks/blocks/progress-block"),
  ),
  knowledge_graph: entry(
    "knowledge_graph", "Knowledge graph", "知识图谱", "ui.knowledge_graph", "GitBranch",
    "Knowledge map", "ui.loom_map",
    "medium", {},
    () => import("@/components/blocks/blocks/knowledge-graph-block"),
  ),
  review: entry(
    "review", "Review", "复习", "ui.lector_review", "RotateCcw",
    "LECTOR-driven spaced review", "ui.lector_review",
    "medium", {},
    () => import("@/components/blocks/blocks/review-block"),
  ),
  plan: entry(
    "plan", "Study plan", "学习计划", "ui.study_plan", "CalendarDays",
    "Goals, tasks, and deadlines", "ui.goals_tasks_deadlines",
    "medium", {},
    () => import("@/components/blocks/blocks/plan-block"),
  ),
  wrong_answers: entry(
    "wrong_answers", "Weak spots", "薄弱点", "ui.weak_spots", "AlertTriangle",
    "Error patterns", "ui.error_patterns",
    "medium", {},
    () => import("@/components/blocks/blocks/wrong-answers-block"),
  ),
  forecast: entry(
    "forecast", "Forecast", "预测", "ui.trajectory_forecast", "TrendingUp",
    "Learning trajectory forecast", "ui.trajectory_forecast",
    "small", {},
    () => import("@/components/blocks/blocks/forecast-block"),
  ),
  agent_insight: entry(
    "agent_insight", "Agent insight", "助手洞察", "ui.agent_insight", "Sparkles",
    "Proactive suggestions", "ui.proactive_suggestions",
    "full", { insightType: "learning_companion" },
    () => import("@/components/blocks/blocks/agent-insight-block"),
  ),
  summary: entry(
    "summary", "Daily digest", "学习摘要", "ui.daily_digest", "Newspaper",
    "Today's learning snapshot: mastery, quiz accuracy, review due", "summary.description",
    "small", {},
    () => import("@/components/blocks/blocks/summary-block"),
  ),
};

/** Block types available for learners to add manually. */
export const USER_ADDABLE_BLOCKS: BlockType[] = [
  // Practice is a core capability: users may not remove the protected default
  // cards, but must be able to restore a missing quiz or flashcard entry.
  "notes", "quiz", "flashcards", "review", "plan",
  "knowledge_graph", "progress", "wrong_answers", "forecast", "summary", "agent_insight",
];
