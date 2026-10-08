"use client";

import { t } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { getMisconceptionDashboard, type MisconceptionDashboard, type MisconceptionItem } from "@/lib/api";
import { Badge } from "@/components/ui/badge";

interface MisconceptionViewProps {
  courseId: string;
}

const DIAGNOSIS_LABELS: Record<string, string> = {
  fundamental_gap: t("ui.fundamental_gap"),
  transfer_gap: t("ui.transfer_gap"),
  trap_vulnerability: t("ui.trap_vulnerability"),
  carelessness: t("ui.carelessness"),
  mastered: t("ui.mastered"),
};

const MISCONCEPTION_TYPE_LABELS: Record<string, string> = {
  surface_memorization: t("ui.surface_memorization"),
  confused_similar: t("ui.confused_similar"),
  missing_prerequisite: t("ui.missing_prereq"),
  procedural_only: t("ui.procedural_only"),
  partial_understanding: t("ui.partial_understanding"),
};

const DIAGNOSIS_COLORS: Record<string, string> = {
  fundamental_gap: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  transfer_gap: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  trap_vulnerability: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  carelessness: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
};

function ResolutionBar({ resolved, total, status }: { resolved: number; total: number; status?: "active" | "resolved" }) {
  const pct = status === "resolved" ? 100 : Math.min(Math.max(resolved / Math.max(total, 1), 0), 1) * 100;
  return (
    <div
      className="h-2 w-20 overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-label={status === "resolved" ? "已全部解决" : `已解决 ${resolved} / ${total}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div className={`h-full rounded-full transition-all ${status === "resolved" ? "bg-emerald-500" : "bg-amber-500"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function MisconceptionCard({ item, rank }: { item: MisconceptionItem; rank: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      role="button"
      aria-expanded={expanded}
      tabIndex={0}
      className="rounded-2xl card-shadow bg-card p-3.5 space-y-2 cursor-pointer hover:bg-accent/50 transition-colors"
      onClick={() => setExpanded(!expanded)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(!expanded); } }}
      data-testid={`misconception-card-${rank}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
            第{rank}项
          </span>
          <span className="text-sm font-medium truncate">{item.concept}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ResolutionBar resolved={item.mastered_errors} total={item.total_errors} status={item.status} />
          <span className={`text-xs tabular-nums ${item.status === "resolved" ? "font-medium text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}`}>
            {item.status === "resolved" ? "已全部解决" : `已解决 ${item.mastered_errors} / ${item.total_errors}`}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {item.dominant_diagnosis ? (
          <Badge
            variant="outline"
            className={`text-[10px] ${DIAGNOSIS_COLORS[item.dominant_diagnosis] ?? "bg-muted text-muted-foreground"}`}
          >
            {DIAGNOSIS_LABELS[item.dominant_diagnosis] ?? item.dominant_diagnosis}
          </Badge>
        ) : null}
        {item.dominant_misconception_type ? (
          <Badge variant="outline" className="text-[10px] bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300">
            {MISCONCEPTION_TYPE_LABELS[item.dominant_misconception_type] ?? item.dominant_misconception_type}
          </Badge>
        ) : null}
        {item.status === "resolved" ? (
          <Badge variant="outline" className="text-[10px] bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
            已解决
          </Badge>
        ) : item.resolution_rate > 0 ? (
          <Badge variant="outline" className="text-[10px] bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
            {item.resolution_rate}% {t("ui.resolved")}
          </Badge>
        ) : null}
      </div>

      {expanded && item.sample_questions.length > 0 ? (
        <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            易错样例
          </span>
          {item.sample_questions.map((q, i) => (
            <div key={i} className="text-xs space-y-0.5 pl-2 border-l-2 border-muted">
              <p className="text-foreground line-clamp-2">{q.question}</p>
              <p className="text-red-600 dark:text-red-400">
                你的答案：{q.user_answer || "—"}
              </p>
              <p className="text-green-600 dark:text-green-400">
                正确答案：{q.correct_answer || "—"}
              </p>
              <p className="text-muted-foreground">
                {q.resolved ? "已在复盘中解决" : "仍需复习"}
                {q.attempt_count && q.attempt_count > 1 ? ` · 共记录 ${q.attempt_count} 次作答` : ""}
                {q.review_count ? ` · 复盘 ${q.review_count} 次` : ""}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MisconceptionView({ courseId }: MisconceptionViewProps) {
  const [data, setData] = useState<MisconceptionDashboard | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMisconceptionDashboard(courseId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  if (error) {
    return (
      <div
        className="flex-1 flex items-center justify-center p-8 text-xs text-muted-foreground"
        data-testid="misconception-panel"
      >
        {t("misconception.loadFailed")}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex-1 flex flex-col gap-3 p-4" data-testid="misconception-panel">
        <div className="h-4 w-48 bg-muted animate-pulse rounded" />
        <div className="h-16 w-full bg-muted animate-pulse rounded" />
        <div className="h-16 w-full bg-muted animate-pulse rounded" />
      </div>
    );
  }

  const { misconceptions, summary } = data;

  if (misconceptions.length === 0) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-2"
        data-testid="misconception-panel"
      >
        <span className="text-2xl">&#10003;</span>
        <p className="text-sm text-muted-foreground">{t("ui.no_active_misconceptions_detected")}</p>
        <p className="text-xs text-muted-foreground">
          {t("misconception.keepPracticing")}
        </p>
      </div>
    );
  }

  const diagEntries = Object.entries(summary.diagnosis_breakdown).sort(
    ([, a], [, b]) => b - a,
  );

  return (
    <div
      role="region"
      aria-label={t("ui.misconception_analysis")}
      className="flex-1 flex flex-col gap-4 p-4 overflow-y-auto"
      data-testid="misconception-panel"
    >
      <div>
        <h3 className="text-sm font-medium">
          你以为自己会了，其实还没掌握
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          根据错题分析，这些知识点可能存在隐藏的理解偏差，按重要程度排序。
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-2xl card-shadow bg-card p-3 flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{t("ui.active")}</span>
          <span className="text-xl font-semibold tabular-nums">{summary.total_active_errors}</span>
        </div>
        <div className="rounded-2xl card-shadow bg-card p-3 flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{t("ui.resolved")}</span>
          <span className="text-xl font-semibold tabular-nums">{summary.total_resolved}</span>
        </div>
        <div className="rounded-2xl card-shadow bg-card p-3 flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{t("ui.rate")}</span>
          <span className="text-xl font-semibold tabular-nums">{summary.resolution_rate}%</span>
        </div>
      </div>

      {/* Diagnosis breakdown badges */}
      {diagEntries.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {diagEntries.map(([diag, count]) => (
            <Badge
              key={diag}
              variant="outline"
              className={`text-[10px] ${DIAGNOSIS_COLORS[diag] ?? "bg-muted text-muted-foreground"}`}
            >
              {DIAGNOSIS_LABELS[diag] ?? diag} ({count})
            </Badge>
          ))}
        </div>
      ) : null}

      {/* Misconception cards */}
      <div className="space-y-2">
        {misconceptions.map((item, i) => (
          <MisconceptionCard key={item.concept} item={item} rank={i + 1} />
        ))}
      </div>
    </div>
  );
}
