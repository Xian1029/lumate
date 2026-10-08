"use client";

import { useEffect, useMemo, useState } from "react";
import { type StudyGoal } from "@/lib/api";
import { updateUnlockContext } from "@/lib/block-system/feature-unlock";
import type { TranslateFn, TranslateFormatFn } from "./plan-helpers";

interface UpcomingDeadline {
  daysLeft: number;
  count: number;
  titles: string[];
}

export function ExamCountdown({
  courseId,
  goals,
  t,
  tf,
}: {
  courseId: string;
  goals: StudyGoal[];
  t: TranslateFn;
  tf: TranslateFormatFn;
}) {
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setNowMs(Date.now()), 0);
    if (goals.some((goal) => goal.status === "active" && goal.target_date)) {
      updateUnlockContext(courseId, { hasDeadline: true });
    }
    return () => window.clearTimeout(timer);
  }, [courseId, goals]);

  const upcoming = useMemo(() => {
    if (nowMs === null) return [];
    const grouped = new Map<number, UpcomingDeadline>();
    for (const goal of goals) {
      if (goal.status !== "active" || !goal.target_date) continue;
      const daysLeft = Math.ceil((new Date(goal.target_date).getTime() - nowMs) / 86_400_000);
      if (daysLeft < 0 || daysLeft > 30) continue;
      const group = grouped.get(daysLeft) ?? { daysLeft, count: 0, titles: [] };
      group.count += 1;
      group.titles.push(goal.title);
      grouped.set(daysLeft, group);
    }
    return [...grouped.values()].sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 2);
  }, [goals, nowMs]);

  if (upcoming.length === 0) return null;

  return (
    <div className="border-b border-amber-200/70 bg-amber-50/70 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/20">
      <div className="space-y-1.5 rounded-xl border border-amber-200/70 bg-background/70 px-3 py-2 dark:border-amber-900/50">
      {upcoming.map((g) => {
        const urgent = g.daysLeft <= 3;
        return (
          <div
            key={g.daysLeft}
            className={`flex items-center gap-2 text-xs ${urgent ? "font-semibold text-destructive" : "text-amber-800 dark:text-amber-200"}`}
          >
            <span className="tabular-nums">
              {g.daysLeft === 0
                ? t("plan.banner.today")
                : g.daysLeft === 1
                  ? t("plan.banner.oneDay")
                  : tf("plan.banner.manyDays", { days: g.daysLeft })}
            </span>
            <span className="truncate flex-1">{g.count} 项学习任务</span>
            {urgent ? (
              <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                {t("plan.banner.urgent")}
              </span>
            ) : null}
            <a href="#study-goals" className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium underline-offset-2 hover:underline">
              查看任务
            </a>
          </div>
        );
      })}
      </div>
    </div>
  );
}
