"use client";

import type { Course } from "@/lib/api";
import { getPersona } from "@/lib/learner-persona";
import { getDashboardNowMs, type ReviewSummary } from "./dashboard-utils";

/** Client-side digest fallback when backend daily_brief is not available. */
export function DigestFallback({
  courses,
  reviewSummaries,
  upcomingDeadlines,
  t,
  tf,
}: {
  courses: Course[];
  reviewSummaries: ReviewSummary[];
  upcomingDeadlines: Array<{ title: string; target_date: string | null }>;
  t: (key: string) => string;
  tf: (key: string, vars?: Record<string, string | number | null | undefined>) => string;
}) {
  const persona = getPersona();
  if (persona.totalSessions === 0) {
    return <p className="text-sm text-muted-foreground">{t("home.todayDigest.empty")}</p>;
  }

  const totalReviewItems = reviewSummaries.reduce((s, r) => s + r.overdueCount + r.urgentCount, 0);
  const nextDeadline = upcomingDeadlines[0];
  const daysUntilDeadline = nextDeadline?.target_date
    ? Math.ceil((new Date(nextDeadline.target_date).getTime() - getDashboardNowMs()) / (1000 * 60 * 60 * 24))
    : null;

  return (
    <div className="space-y-1.5 text-sm text-muted-foreground">
      <p>
        <span className="text-foreground font-medium">{courses.length}</span>{" "}
        {courses.length === 1 ? t("home.digest.activeSpace") : t("home.digest.activeSpaces")} ·{" "}
        {tf("home.digest.sessionsTracked", { count: persona.totalSessions })}
      </p>
      {totalReviewItems > 0 && (
        <p>
          <span className="text-warning font-medium">{totalReviewItems}</span>{" "}
          {t("home.urgentReviews.conceptsFading")}
        </p>
      )}
      {daysUntilDeadline != null && daysUntilDeadline >= 0 && (
        <p>
          {t("home.digest.nextDeadline")} <span className="text-foreground font-medium">{nextDeadline!.title}</span>{" "}
          {tf("home.digest.inDays", { days: daysUntilDeadline })}
        </p>
      )}
    </div>
  );
}
