"use client";

import { t } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getLearningOverview,
  getGlobalTrends,
  getMemoryStats,
  triggerConsolidation,
  type LearningOverview,
  type LearningTrends,
  type MemoryStats,
} from "@/lib/api";
import { MetricCard } from "./metric-card";
import { StudyTimeChart } from "./study-time-chart";
import { QuizActivityChart } from "./quiz-activity-chart";
import { GapDistributionChart } from "./gap-distribution-chart";
import { ErrorBreakdownChart } from "./error-breakdown-chart";
import { DiagnosedPatterns } from "./diagnosed-patterns";
import { MemoryHealthSection } from "./memory-health-section";
import { CourseSummaries } from "./course-summaries";

export default function AnalyticsPage() {
  const router = useRouter();
  const [overview, setOverview] = useState<LearningOverview | null>(null);
  const [trends, setTrends] = useState<LearningTrends | null>(null);
  const [memStats, setMemStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [consolidating, setConsolidating] = useState(false);

  useEffect(() => {
    let cancelled = false;

    Promise.allSettled([getLearningOverview(), getGlobalTrends(30), getMemoryStats()])
      .then(([overviewResult, trendsResult, memoryResult]) => {
        if (cancelled) return;
        if (overviewResult.status === "fulfilled") {
          setOverview(overviewResult.value);
        }
        if (trendsResult.status === "fulfilled") {
          setTrends(trendsResult.value);
        }
        if (memoryResult.status === "fulfilled") {
          setMemStats(memoryResult.value);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleConsolidate = async () => {
    setConsolidating(true);
    try {
      await triggerConsolidation();
      const ms = await getMemoryStats();
      setMemStats(ms);
    } catch {
      // ignore
    } finally {
      setConsolidating(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <span className="text-muted-foreground animate-pulse">{t("ui.loading")}</span>
      </div>
    );
  }

  const totalMinutes = overview?.total_study_minutes ?? 0;
  const trendData = trends?.trend ?? [];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60 px-6 py-3 flex items-center gap-3 glass">
        <button
          type="button"
          onClick={() => router.push("/")}
          className="text-sm text-muted-foreground hover:text-foreground"
          title={t("ui.back_to_dashboard")}
        >
          &larr; {t("nav.back")}
        </button>
        <h1 className="text-lg font-semibold text-foreground">我的学习进步</h1>
        <div className="ml-auto" />
      </header>

      <div className="max-w-6xl mx-auto p-6 space-y-6" data-testid="analytics-page">
        <section className="rounded-2xl border border-brand/20 bg-brand-muted/25 p-5">
          <p className="text-sm font-semibold text-brand">学习小结</p>
          <h2 className="mt-1 text-xl font-bold text-foreground">看看这段时间的努力，下一步更有方向。</h2>
          <p className="mt-2 text-sm text-muted-foreground">这里的学习时长、练习和掌握情况都来自你的真实学习记录。</p>
        </section>
        {/* Key Metrics */}
        <div className="grid md:grid-cols-4 gap-4">
          <MetricCard
            label="学习空间"
            value={String(overview?.total_courses ?? 0)}
          />
          <MetricCard
            label="知识掌握情况"
            value={`${((overview?.average_mastery ?? 0) * 100).toFixed(0)}%`}
          />
          <MetricCard
            label="累计学习时间"
            value={totalMinutes >= 60 ? `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m` : `${totalMinutes}m`}
          />
          <MetricCard
            label="完成练习题"
            value={String(trendData.reduce((sum, d) => sum + d.quiz_total, 0))}
          />
        </div>

        {/* Charts Row */}
        <div className="grid lg:grid-cols-2 gap-6">
          <StudyTimeChart data={trendData} />
          <QuizActivityChart data={trendData} />
        </div>

        {/* Pie Charts Row */}
        <div className="grid lg:grid-cols-2 gap-6">
          <GapDistributionChart gapBreakdown={overview?.gap_type_breakdown ?? {}} />
          <ErrorBreakdownChart errorBreakdown={overview?.error_category_breakdown ?? {}} />
        </div>

        <DiagnosedPatterns diagnosisBreakdown={overview?.diagnosis_breakdown ?? {}} />

        {/* Memory Health */}
        {memStats && memStats.total > 0 && (
          <MemoryHealthSection
            memStats={memStats}
            consolidating={consolidating}
            onConsolidate={handleConsolidate}
          />
        )}

        {/* Course Summaries */}
        <CourseSummaries courseSummaries={overview?.course_summaries ?? []} />
      </div>
    </div>
  );
}
