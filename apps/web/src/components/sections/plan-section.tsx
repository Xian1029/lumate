"use client";

import Link from "next/link";
import type { LearningMode } from "@/lib/block-system/types";
import { CoursePlanStatus } from "@/components/learning-plans/course-plan-status";

interface PlanSectionProps {
  courseId: string;
  aiActionsEnabled?: boolean;
  learningMode?: LearningMode;
  defaultTab?: "plan" | "calendar" | "tasks" | "timeline";
  exitHref?: string;
}

export function PlanSection({
  courseId,
  exitHref,
}: PlanSectionProps) {
  return (
    <section className="w-full space-y-4 p-4" data-testid="plan-section">
      {exitHref ? <Link href={exitHref} className="text-sm text-brand hover:underline">← 返回学习空间</Link> : null}
      <CoursePlanStatus courseId={courseId} />
      <div className="rounded-2xl border border-border/70 bg-card p-4">
        <p className="font-semibold">管理全部学习计划</p>
        <p className="mt-1 text-sm text-muted-foreground">确认、执行、暂停和查看历史计划，都会在学习计划中心完成。</p>
        <Link href="/learning-plans" className="mt-3 inline-flex rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted">打开学习计划中心</Link>
      </div>
    </section>
  );
}
