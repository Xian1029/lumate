"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n-context";
import { getCourseProgress, type CourseProgress } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { useWorkspaceStore } from "@/store/workspace";

interface ProgressViewProps {
  courseId: string;
}

const BAR_COLORS = {
  mastered: "bg-emerald-500 dark:bg-emerald-400",
  reviewed: "bg-teal-400 dark:bg-teal-500",
  in_progress: "bg-amber-400 dark:bg-amber-500",
  not_started: "bg-slate-200 dark:bg-slate-600",
} as const;

const GAP_BADGE_COLORS: Record<string, string> = {
  conceptual: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/35 dark:text-violet-300",
  procedural: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/35 dark:text-sky-300",
  computational: "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/35 dark:text-cyan-300",
  reading: "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/35 dark:text-indigo-300",
  careless: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/35 dark:text-rose-300",
  carelessness: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/35 dark:text-rose-300",
  factual: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/35 dark:text-amber-300",
  application: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/35 dark:text-emerald-300",
  fundamental_gap: "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950/35 dark:text-orange-300",
  transfer_gap: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-800 dark:bg-fuchsia-950/35 dark:text-fuchsia-300",
  trap_vulnerability: "border-pink-200 bg-pink-50 text-pink-700 dark:border-pink-800 dark:bg-pink-950/35 dark:text-pink-300",
};

const GAP_TRANSLATION_KEYS: Record<string, string> = {
  conceptual: "progress.gap.conceptual",
  procedural: "progress.gap.procedural",
  computational: "progress.gap.computational",
  reading: "progress.gap.reading",
  careless: "progress.gap.careless",
  carelessness: "progress.gap.careless",
  factual: "progress.gap.factual",
  application: "progress.gap.application",
  fundamental_gap: "progress.gap.fundamental",
  transfer_gap: "progress.gap.transfer",
  trap_vulnerability: "progress.gap.trap",
};

function fmtTime(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function ProgressView({ courseId }: ProgressViewProps) {
  const t = useT();
  const [data, setData] = useState<CourseProgress | null>(null);
  const [error, setError] = useState(false);
  const analyticsRefreshKey = useWorkspaceStore((state) => state.sectionRefreshKey.analytics);

  useEffect(() => {
    let cancelled = false;
    getCourseProgress(courseId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, analyticsRefreshKey]);

  if (error) {
    return (
      <div
        className="flex-1 flex items-center justify-center p-8 text-xs text-muted-foreground"
        data-testid="progress-panel"
      >
        {t("progress.loadFailed")}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex-1 flex flex-col gap-3 p-4" data-testid="progress-panel">
        <div className="h-4 w-48 bg-muted animate-pulse rounded" />
        <div className="h-3 w-full bg-muted animate-pulse rounded" />
        <div className="h-3 w-3/4 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  // Use the same server-owned view model as the home cards and knowledge
  // graph. Mastery, parsing and task completion must never become a second
  // definition of "学习进度" in the course outline.
  const learningProgress = data.learning_progress ?? {
    completed_learning_items: data.mastered,
    total_learning_items: data.total_nodes,
    progress_percent: data.completion_percent,
  };
  const total = learningProgress.total_learning_items || 1;
  const progressPercent = learningProgress.progress_percent ?? 0;
  const segments = [
    { key: "mastered", count: data.mastered, color: BAR_COLORS.mastered },
    { key: "reviewed", count: data.reviewed, color: BAR_COLORS.reviewed },
    { key: "in_progress", count: data.in_progress, color: BAR_COLORS.in_progress },
    { key: "not_started", count: data.not_started, color: BAR_COLORS.not_started },
  ];

  const gapEntries = Object.entries(data.gap_type_breakdown).sort(
    ([, a], [, b]) => b - a,
  );

  return (
    <div
      role="region"
      aria-label={t("ui.course_progress")}
      className="flex-1 flex flex-col gap-3 p-4 overflow-y-auto overscroll-contain scrollbar-thin"
      data-testid="progress-panel"
    >
      <h3 className="text-sm font-medium">{t("ui.course_completion")}</h3>

      <div className="grid grid-cols-2 gap-2">
        {[
          { label: t("progress.mastered"), value: `${Math.round(data.average_mastery)}%` },
          { label: t("progress.completion"), value: `${Math.round(progressPercent)}%` },
          { label: t("progress.totalTime"), value: fmtTime(data.total_study_minutes) },
          { label: t("progress.notStarted"), value: `${data.not_started}` },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="rounded-xl border border-border/50 bg-card px-3 py-2.5 flex flex-col gap-0.5"
          >
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="text-lg font-semibold tabular-nums">{value}</span>
          </div>
        ))}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t("progress.topics").replace("{count}", String(learningProgress.total_learning_items))}</span>
          <span>{Math.round(progressPercent)}%</span>
        </div>
        <div role="progressbar" aria-valuenow={Math.round(progressPercent)} aria-valuemin={0} aria-valuemax={100} aria-label={t("ui.course_completion_1")} className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100 ring-1 ring-inset ring-slate-200/70 dark:bg-slate-800 dark:ring-slate-700">
          {segments.map(({ key, count, color }) => {
            const pct = (count / total) * 100;
            if (pct === 0) return null;
            return (
              <div
                key={key}
                className={`${color} transition-all`}
                style={{ width: `${pct}%` }}
                title={`${t(`progress.status.${key}`)} ${count}`}
              />
            );
          })}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {segments.map(({ key, count, color }) => (
            <span key={key} className="flex items-center gap-1">
              <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
              {t(`progress.status.${key}`)} {count}
            </span>
          ))}
        </div>
      </div>

      {gapEntries.length > 0 ? (
        <div className="space-y-2" data-testid="progress-gap-breakdown">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t("progress.gapBreakdown")}
          </h4>
          <ul className="max-h-28 space-y-1 overflow-y-auto overscroll-contain pr-1 scrollbar-thin">
            {gapEntries.map(([type, count]) => (
              <li key={type} className="flex items-center justify-between rounded-xl border border-border/40 bg-card px-3 py-2 text-sm">
                <Badge
                  variant="outline"
                  className={GAP_BADGE_COLORS[type] ?? "bg-muted text-muted-foreground"}
                >
                  {t(GAP_TRANSLATION_KEYS[type] ?? "progress.gap.other")}
                </Badge>
                <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
