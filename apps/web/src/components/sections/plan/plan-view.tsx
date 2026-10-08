"use client";

import type { LearningMode } from "@/lib/block-system/types";
import { PlanSection } from "@/components/sections/plan-section";

/**
 * Deprecated compatibility export for persisted layouts that still reference
 * ``PlanView``. The old Markdown/StudyGoal UI was removed: all plan actions
 * now lead to the authoritative LearningPlan Center.
 */
export function PlanView({
  courseId,
  exitHref,
}: {
  courseId: string;
  aiActionsEnabled?: boolean;
  learningMode?: LearningMode;
  exitHref?: string;
}) {
  return <PlanSection courseId={courseId} exitHref={exitHref} />;
}
