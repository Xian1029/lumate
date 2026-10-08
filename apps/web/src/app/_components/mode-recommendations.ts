import type { StudyGoal } from "@/lib/api";
import type { LearningMode } from "@/lib/block-system/types";

export interface GoalDeadlineSnapshot<TGoal extends Pick<StudyGoal, "target_date" | "title"> = StudyGoal> {
  goal: TGoal;
  daysLeft: number;
}

export interface ModeSuggestionDecision {
  suggestedMode: LearningMode;
  recommendationKey: "exam_passed" | "deadline";
  reason: string;
  signals: string[];
  approvalCta: string;
}

interface EvaluateModeSuggestionArgs {
  currentMode: LearningMode;
  deadlines: GoalDeadlineSnapshot<Pick<StudyGoal, "target_date" | "title">>[];
  t: (key: string) => string;
  tf: (key: string, values: Record<string, number | string>) => string;
}

export function buildGoalDeadlineSnapshots<TGoal extends Pick<StudyGoal, "target_date" | "title">>(
  goals: TGoal[],
  nowMs = Date.now(),
): GoalDeadlineSnapshot<TGoal>[] {
  return goals
    .filter((goal) => goal.target_date)
    .map((goal) => ({
      goal,
      daysLeft: Math.ceil((new Date(goal.target_date!).getTime() - nowMs) / (1000 * 60 * 60 * 24)),
    }));
}

export function evaluateModeSuggestion({
  currentMode,
  deadlines,
  t,
  tf,
}: EvaluateModeSuggestionArgs): ModeSuggestionDecision | null {
  const upcoming = deadlines
    .filter((deadline) => deadline.daysLeft >= 0 && deadline.daysLeft <= 7)
    .sort((a, b) => a.daysLeft - b.daysLeft)[0];
  const allDeadlinesPassed = deadlines.length > 0 && deadlines.every((deadline) => deadline.daysLeft < 0);

  if (currentMode === "exam_prep" && allDeadlinesPassed) {
    return {
      suggestedMode: "self_paced",
      recommendationKey: "exam_passed",
      reason: t("course.modeSuggestion.examPassed"),
      signals: [t("course.modeSuggestion.signal.deadlinesPassed")],
      approvalCta: t("course.modeSuggestion.switchSelfPaced"),
    };
  }

  if (currentMode !== "course_following" && currentMode !== "self_paced") {
    return null;
  }

  if (upcoming) {
    return {
      suggestedMode: "exam_prep",
      recommendationKey: "deadline",
      reason: upcoming.daysLeft === 0
        ? tf("course.modeSuggestion.deadlineToday", { title: upcoming.goal.title })
        : tf("course.modeSuggestion.deadline", { title: upcoming.goal.title, days: upcoming.daysLeft }),
      signals: [tf("course.modeSuggestion.signal.deadline", { days: upcoming.daysLeft })],
      approvalCta: t("course.modeSuggestion.switchExamPrep"),
    };
  }

  return null;
}
