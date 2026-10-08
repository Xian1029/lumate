"use client";

import { getLocale, t, tf } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { getForgettingForecast, getFeatureFlags, type ForgettingForecast, type ForgettingPrediction } from "@/lib/api";

interface ForecastViewProps {
  courseId: string;
}

const URGENCY_STYLES: Record<string, { bg: string; text: string; labelKey: string }> = {
  overdue: { bg: "bg-red-100 dark:bg-red-900/30", text: "text-red-700 dark:text-red-400", labelKey: "forecast.reviewNow" },
  urgent: { bg: "bg-orange-100 dark:bg-orange-900/30", text: "text-orange-700 dark:text-orange-400", labelKey: "forecast.reviewToday" },
  warning: { bg: "bg-yellow-100 dark:bg-yellow-900/30", text: "text-yellow-700 dark:text-yellow-400", labelKey: "forecast.reviewSoon" },
  ok: { bg: "bg-emerald-50 dark:bg-emerald-900/20", text: "text-emerald-700 dark:text-emerald-400", labelKey: "forecast.rememberWell" },
};

function RetrievabilityBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    pct >= 90 ? "bg-emerald-500" :
    pct >= 70 ? "bg-yellow-500" :
    pct >= 50 ? "bg-orange-500" :
    "bg-red-500";

  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t("ui.retrievability")} className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground w-8 text-right">{pct}%</span>
    </div>
  );
}

function PredictionRow({ prediction }: { prediction: ForgettingPrediction }) {
  const style = URGENCY_STYLES[prediction.urgency] ?? URGENCY_STYLES.ok;
  const daysText =
    prediction.days_until_threshold <= 0
      ? t("ui.now")
      : prediction.days_until_threshold < 1
        ? t("ui.less_than_1d")
        : tf("forecast.daysLater", { count: Math.round(prediction.days_until_threshold) });

  const lastReviewed = prediction.last_reviewed
    ? new Date(prediction.last_reviewed).toLocaleDateString(getLocale() === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric" })
    : t("forecast.notReviewedYet");

  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl bg-muted/30 hover:bg-muted/50 transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">{prediction.title}</p>
        <p className="text-[10px] text-muted-foreground">
          {tf("forecast.lastPracticed", { date: lastReviewed })} · {tf("forecast.memoryCanLast", { count: Math.max(1, Math.round(prediction.stability_days)) })}
        </p>
      </div>
      <RetrievabilityBar value={prediction.current_retrievability} />
      <span
        className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${style.bg} ${style.text}`}
      >
        {prediction.urgency === "ok" ? tf("forecast.reviewAfter", { time: daysText }) : t(style.labelKey)}
      </span>
    </div>
  );
}

export function ForecastView({ courseId }: ForecastViewProps) {
  const [data, setData] = useState<ForgettingForecast | null>(null);
  const [error, setError] = useState(false);
  const [featureEnabled, setFeatureEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    getFeatureFlags()
      .then((flags) => setFeatureEnabled(flags.loom))
      .catch(() => setFeatureEnabled(false));
  }, []);

  useEffect(() => {
    if (featureEnabled === false) return;
    let cancelled = false;
    getForgettingForecast(courseId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [courseId, featureEnabled]);

  if (featureEnabled === false) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        <p className="text-sm">{t("ui.forgetting_forecast_requires_loom_experimental")}</p>
        <p className="text-xs mt-1">{t("ui.set")}<code className="bg-muted px-1 rounded">ENABLE_EXPERIMENTAL_LOOM=true</code>{t("ui.to_enable")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-xs text-muted-foreground">
        {t("ui.failed_load_forecast")}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex-1 flex flex-col gap-3 p-4">
        <div className="h-4 w-48 bg-muted animate-pulse rounded" />
        <div className="h-3 w-full bg-muted animate-pulse rounded" />
        <div className="h-3 w-3/4 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  if (data.total_items === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <p className="text-sm text-muted-foreground">{t("ui.no_review_data_yet")}</p>
        <p className="text-xs text-muted-foreground mt-1">
          {t("ui.complete_quizzes_for_forecast")}
        </p>
      </div>
    );
  }

  const needsAttention = data.predictions.filter((p) => p.urgency !== "ok");
  const okItems = data.predictions.filter((p) => p.urgency === "ok");

  return (
    <div role="region" aria-label={t("ui.forgetting_forecast")} className="flex-1 flex flex-col overflow-y-auto" data-testid="forecast-panel">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-2 p-4 pb-2">
        <div className="rounded-2xl card-shadow bg-card p-3.5 flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">{t("forecast.learnedItems")}</span>
          <span className="text-xl font-semibold tabular-nums">{data.total_items}</span>
        </div>
        <div className="rounded-2xl card-shadow bg-red-50 dark:bg-red-900/20 p-3.5 flex flex-col gap-0.5">
          <span className="text-xs text-red-600 dark:text-red-400">{t("forecast.reviewNow")}</span>
          <span className="text-xl font-semibold tabular-nums text-red-700 dark:text-red-400">
            {data.urgent_count}
          </span>
        </div>
        <div className="rounded-2xl card-shadow bg-yellow-50 dark:bg-yellow-900/20 p-3.5 flex flex-col gap-0.5">
          <span className="text-xs text-yellow-600 dark:text-yellow-400">{t("forecast.reviewSoon")}</span>
          <span className="text-xl font-semibold tabular-nums text-yellow-700 dark:text-yellow-400">
            {data.warning_count}
          </span>
        </div>
      </div>

      {/* Needs attention section */}
      {needsAttention.length > 0 && (
        <div className="px-4 pb-2">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
            {t("forecast.firstReviewThese")} ({needsAttention.length})
          </h4>
          <div className="space-y-0.5">
            {needsAttention.map((p, i) => (
              <PredictionRow key={p.content_node_id ?? i} prediction={p} />
            ))}
          </div>
        </div>
      )}

      {/* OK section */}
      {okItems.length > 0 && (
        <div className="px-4 pb-4">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
            {t("forecast.rememberWellGroup")} ({okItems.length})
          </h4>
          <div className="space-y-0.5">
            {okItems.map((p, i) => (
              <PredictionRow key={p.content_node_id ?? i} prediction={p} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
