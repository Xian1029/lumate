"use client";

import {
  Sparkles,
  RotateCcw,
  CalendarDays,
  GitBranch,
  ArrowRight,
  Sun,
  TrendingUp,
  BookOpen,
  Clock3,
  CircleCheckBig,
  Flame,
  Trophy,
  Sprout,
  Leaf,
  TreePine,
  Target,
} from "lucide-react";
import type { Course, AppNotification, StudyGoal, WeeklyReport, LearningOverview } from "@/lib/api";
import { ModeBadge } from "@/components/course/mode-selector";
import { Button } from "@/components/ui/button";
import { DashSection } from "./dash-section";
import { DigestFallback } from "./digest-fallback";
import {
  getDashboardNowMs,
  getFriendlyTaskType,
  resolveNotificationPath,
  type ReviewSummary,
  type PendingTaskSummary,
  type KnowledgeDensitySummary,
  type ModeRecommendation,
} from "./dashboard-utils";

export function OverviewStats({
  totalActiveGoals,
  totalUrgentReviews,
  courseCount,
  t,
}: {
  totalActiveGoals: number;
  totalUrgentReviews: number;
  courseCount: number;
  t: (key: string) => string;
}) {
  const cards = [
    {
      label: t("dashboard.activeGoals"),
      value: totalActiveGoals,
      unit: t("dashboard.goalUnit"),
      hint: t(totalActiveGoals > 0 ? "dashboard.activeGoals.hint" : "dashboard.activeGoals.empty"),
      Icon: Target,
      shell: "border-emerald-100 bg-gradient-to-br from-emerald-50/90 via-card to-card dark:border-emerald-900/50 dark:from-emerald-950/25",
      icon: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-300",
    },
    {
      label: t("dashboard.urgentReviews"),
      value: totalUrgentReviews,
      unit: t("dashboard.itemUnit"),
      hint: t(totalUrgentReviews > 0 ? "dashboard.urgentReviews.hint" : "dashboard.urgentReviews.empty"),
      Icon: RotateCcw,
      shell: "border-amber-100 bg-gradient-to-br from-amber-50/90 via-card to-card dark:border-amber-900/50 dark:from-amber-950/25",
      icon: "bg-amber-100 text-amber-600 dark:bg-amber-950/60 dark:text-amber-300",
    },
    {
      label: t("dashboard.learningSpaces"),
      value: courseCount,
      unit: t("dashboard.spaceUnit"),
      hint: t("dashboard.learningSpaces.hint"),
      Icon: BookOpen,
      shell: "border-sky-100 bg-gradient-to-br from-sky-50/90 via-card to-card dark:border-sky-900/50 dark:from-sky-950/25",
      icon: "bg-sky-100 text-sky-600 dark:bg-sky-950/60 dark:text-sky-300",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {cards.map(({ label, value, unit, hint, Icon, shell, icon }) => (
        <div key={label} className={`rounded-2xl border p-4 shadow-sm transition-shadow hover:shadow-md ${shell}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground/75">{label}</p>
              <p className="mt-2 text-3xl font-bold tracking-tight text-foreground tabular-nums">
                {value}<span className="ml-1 text-xs font-medium text-muted-foreground">{unit}</span>
              </p>
            </div>
            <span className={`grid size-10 shrink-0 place-items-center rounded-2xl ${icon}`}>
              <Icon className="size-5" aria-hidden="true" />
            </span>
          </div>
          <p className="mt-3 min-h-8 text-[11px] leading-4 text-muted-foreground">{hint}</p>
        </div>
      ))}
    </div>
  );
}

export function TodayDigestSection({
  courses,
  dailyDigest,
  reviewSummaries,
  upcomingDeadlines,
  t,
  tf,
}: {
  courses: Course[];
  dailyDigest: AppNotification | null;
  reviewSummaries: ReviewSummary[];
  upcomingDeadlines: Array<{ title: string; target_date: string | null }>;
  t: (key: string) => string;
  tf: (key: string, vars?: Record<string, string | number | null | undefined>) => string;
}) {
  return (
    <DashSection title={t("home.todayDigest")} icon={Sun}>
      {dailyDigest ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{dailyDigest.title}</p>
          <p className="text-sm text-muted-foreground whitespace-pre-line">{dailyDigest.body}</p>
        </div>
      ) : (
        <DigestFallback courses={courses} reviewSummaries={reviewSummaries} upcomingDeadlines={upcomingDeadlines} t={t} tf={tf} />
      )}
    </DashSection>
  );
}

export function UpcomingDeadlinesSection({
  upcomingDeadlines,
  getDeadlineLabel,
  onNavigate,
  t,
}: {
  upcomingDeadlines: Array<StudyGoal & { courseName: string }>;
  getDeadlineLabel: (daysUntil: number) => string;
  onNavigate: (path: string) => void;
  t: (key: string) => string;
}) {
  return (
    <DashSection title={t("home.upcomingDeadlines")} icon={CalendarDays} badge={upcomingDeadlines.length}>
      {upcomingDeadlines.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("home.upcomingDeadlines.empty")}</p>
      ) : (
        <div className="space-y-2">
          {upcomingDeadlines.map((d) => {
            const daysUntil = Math.ceil((new Date(d.target_date!).getTime() - getDashboardNowMs()) / (1000 * 60 * 60 * 24));
            const urgencyClass = daysUntil <= 0 ? "text-destructive font-semibold" : daysUntil <= 3 ? "text-warning font-medium" : "text-muted-foreground";
            return (
              <button key={d.id} type="button" onClick={() => d.course_id && onNavigate(`/course/${d.course_id}/plan`)} className="w-full flex items-center gap-3 rounded-xl bg-muted/30 p-3.5 text-left hover:bg-muted/50 transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{d.title}</p>
                  <p className="text-xs text-muted-foreground truncate">{d.courseName}</p>
                </div>
                <span className={`text-xs shrink-0 ${urgencyClass}`}>{getDeadlineLabel(daysUntil)}</span>
              </button>
            );
          })}
        </div>
      )}
    </DashSection>
  );
}

export function UrgentReviewsSection({
  reviewSummaries,
  totalUrgentReviews,
  onNavigate,
  t,
  tf,
}: {
  reviewSummaries: ReviewSummary[];
  totalUrgentReviews: number;
  onNavigate: (path: string) => void;
  t: (key: string) => string;
  tf: (key: string, vars?: Record<string, string | number | null | undefined>) => string;
}) {
  return (
    <DashSection title={t("home.urgentReviews")} icon={RotateCcw} badge={totalUrgentReviews}>
      {reviewSummaries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("home.urgentReviews.empty")}</p>
      ) : (
        <div className="space-y-2">
          {reviewSummaries.map((rs) => (
            <button key={rs.courseId} type="button" onClick={() => onNavigate(`/course/${rs.courseId}/review`)} className="w-full flex items-center gap-3 rounded-xl bg-muted/30 p-3.5 text-left hover:bg-muted/50 transition-colors">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{rs.courseName}</p>
                <p className="text-xs text-muted-foreground">
                  {rs.overdueCount > 0 && <span className="text-destructive font-medium">{tf("home.reviews.overdue", { count: rs.overdueCount })}</span>}
                  {rs.overdueCount > 0 && rs.urgentCount > 0 && " · "}
                  {rs.urgentCount > 0 && <span className="text-warning font-medium">{tf("home.reviews.urgent", { count: rs.urgentCount })}</span>}
                  {" · "}{tf("home.reviews.total", { count: rs.totalCount })}
                </p>
              </div>
              <ArrowRight className="size-4 text-muted-foreground shrink-0" />
            </button>
          ))}
        </div>
      )}
    </DashSection>
  );
}

export function KnowledgeDensitySection({
  knowledgeDensity,
  t,
}: {
  knowledgeDensity: KnowledgeDensitySummary | null;
  t: (key: string) => string;
}) {
  return (
    <DashSection title={t("home.knowledgeDensity")} icon={GitBranch}>
      {!knowledgeDensity || knowledgeDensity.totalConcepts === 0 ? (
        <p className="text-sm text-muted-foreground">{t("home.knowledgeDensity.empty")}</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-muted/30 p-3.5">
              <p className="text-[11px] text-muted-foreground">{t("home.knowledgeDensity.shared")}</p>
              <p className="text-base font-semibold text-foreground">{knowledgeDensity.sharedConcepts}</p>
            </div>
            <div className="rounded-xl bg-muted/30 p-3.5">
              <p className="text-[11px] text-muted-foreground">{t("home.knowledgeDensity.total")}</p>
              <p className="text-base font-semibold text-foreground">{knowledgeDensity.totalConcepts}</p>
            </div>
            <div className="rounded-xl bg-muted/30 p-3.5">
              <p className="text-[11px] text-muted-foreground">{t("home.knowledgeDensity.overlap")}</p>
              <p className="text-base font-semibold text-brand">{knowledgeDensity.densityPct}%</p>
            </div>
          </div>
          <div className="h-2.5 rounded-full bg-muted/60 overflow-hidden">
            <div className="h-full bg-brand rounded-full transition-all duration-500" style={{ width: `${knowledgeDensity.densityPct}%` }} />
          </div>
          {knowledgeDensity.topSharedConcepts.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {knowledgeDensity.topSharedConcepts.map((name) => (
                <span key={name} className="text-[11px] px-2 py-0.5 rounded-full bg-brand-muted text-brand">{name}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </DashSection>
  );
}

export function AgentInsightsSection({
  notifications,
  onOpen,
  t,
}: {
  notifications: AppNotification[];
  onOpen: (notification: AppNotification, path: string | null) => void;
  t: (key: string) => string;
}) {
  if (notifications.length === 0) return null;

  return (
    <DashSection title={t("home.agentInsights")} icon={Sparkles} badge={notifications.length}>
        <div className="grid gap-2 sm:grid-cols-2">
          {notifications.map((n) => {
            const path = resolveNotificationPath(n);
            const coursePath = n.course_id ? `/course/${n.course_id}` : null;
            const ctaPath = path ?? coursePath;
            const ctaLabel = ctaPath ? (n.action_label || t("home.agentInsights.open")) : t("home.agentInsights.gotIt");
            return (
              <div key={n.id} className="flex items-start gap-3 rounded-xl border border-brand/10 bg-brand/5 p-3.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand/10">
                  <Sparkles className="size-4 text-brand" />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{n.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{n.body}</p>
                  <button type="button" onClick={() => onOpen(n, ctaPath)} className="mt-1.5 text-[11px] font-medium text-brand hover:underline">
                    {ctaLabel}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
    </DashSection>
  );
}

export function PendingApprovalsSection({
  pendingTasks,
  actingTasks,
  onActOnTask,
  t,
}: {
  pendingTasks: PendingTaskSummary[];
  actingTasks: Set<string>;
  onActOnTask: (taskId: string, action: "approve" | "reject") => void;
  t: (key: string) => string;
}) {
  return (
    <DashSection title={t("home.pendingApprovals.title")} icon={Sparkles} badge={pendingTasks.length}>
      {pendingTasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("home.pendingApprovals.empty")}</p>
      ) : (
        <div className="space-y-2">
          {pendingTasks.map((task) => (
            <div key={task.id} className="rounded-xl bg-muted/30 p-3.5">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{task.title}</p>
                  {task.summary && <p className="text-xs text-muted-foreground mt-0.5">{task.summary}</p>}
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {task.courseName || t("home.pendingApprovals.courseUnknown")} · {getFriendlyTaskType(task.task_type, t)}
                  </p>
                  {task.approval_reason && <p className="text-[11px] text-muted-foreground mt-1">{t("home.pendingApprovals.reason")} {task.approval_reason}</p>}
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button size="sm" variant="outline" disabled={actingTasks.has(task.id)} onClick={() => onActOnTask(task.id, "reject")}>{t("home.pendingApprovals.reject")}</Button>
                  <Button size="sm" disabled={actingTasks.has(task.id)} onClick={() => onActOnTask(task.id, "approve")}>{t("home.pendingApprovals.approve")}</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </DashSection>
  );
}

export function WeeklyStatsSection({ weeklyReport, t, tf }: {
  weeklyReport: WeeklyReport | null;
  t: (key: string) => string;
  tf: (key: string, vars?: Record<string, string | number | null | undefined>) => string;
}) {
  if (!weeklyReport) return null;
  const { this_week, last_week, deltas } = weeklyReport;
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const dailyStudy = this_week.daily_study ?? Array.from({ length: 7 }, (_, index) => ({
    date: "",
    weekday: index + 1,
    study_minutes: 0,
  }));

  const deltaLabel = (value: number, unit: string) => {
    if (value === 0) return t("home.weekly.sameAsLastWeek");
    return tf(value > 0 ? "home.weekly.moreThanLastWeek" : "home.weekly.lessThanLastWeek", { value: Math.abs(value), unit });
  };

  const highlights = this_week.quiz_total === 0 && this_week.study_minutes === 0 && this_week.active_days === 0
    ? [t("home.weekly.emptyEncouragement")]
    : [
        this_week.quiz_total > 0 ? tf("home.weekly.completedQuestions", { count: this_week.quiz_total }) : null,
        deltas.accuracy > 0 ? tf("home.weekly.accuracyImproved", { value: deltas.accuracy }) : null,
        this_week.study_minutes > 0 ? tf("home.weekly.studiedMinutes", { count: this_week.study_minutes }) : null,
        this_week.active_days > 0 ? tf("home.weekly.activeDaysSummary", { count: this_week.active_days }) : null,
      ].filter((item): item is string => Boolean(item));

  const cards = [
    { label: t("home.weekly.studyTime"), value: this_week.study_minutes, unit: t("home.weekly.minutes"), previous: last_week.study_minutes, delta: deltas.study_minutes, deltaUnit: t("home.weekly.minutes"), Icon: Clock3, iconClass: "bg-sky-100 text-sky-600 dark:bg-sky-950/50 dark:text-sky-300" },
    { label: t("home.weekly.accuracy"), value: this_week.accuracy, unit: "%", previous: last_week.accuracy, delta: deltas.accuracy, deltaUnit: "%", Icon: CircleCheckBig, iconClass: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300" },
    { label: t("home.weekly.questions"), value: this_week.quiz_total, unit: t("home.weekly.questionsUnit"), previous: last_week.quiz_total, delta: deltas.quiz_total, deltaUnit: t("home.weekly.questionsUnit"), Icon: Trophy, iconClass: "bg-amber-100 text-amber-600 dark:bg-amber-950/50 dark:text-amber-300" },
    { label: t("home.weekly.activeDays"), value: this_week.active_days, unit: t("home.weekly.days"), previous: last_week.active_days, delta: null, deltaUnit: t("home.weekly.days"), Icon: Flame, iconClass: "bg-orange-100 text-orange-600 dark:bg-orange-950/50 dark:text-orange-300" },
  ];

  return (
    <DashSection title={t("home.weekly.title")} icon={TrendingUp}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map(({ label, value, unit, previous, delta, deltaUnit, Icon, iconClass }) => (
          <div key={label} className="rounded-2xl border border-border/50 bg-gradient-to-br from-card to-muted/25 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">{label}</p>
              <span className={`grid size-8 place-items-center rounded-xl ${iconClass}`}><Icon className="size-4" /></span>
            </div>
            <p className="text-2xl font-bold tracking-tight text-foreground tabular-nums">{value}<span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span></p>
            <p className={`mt-1.5 text-[10px] ${delta != null && delta > 0 ? "text-success" : "text-muted-foreground"}`}>
              {delta == null ? tf("home.weekly.lastWeek", { value: previous, unit }) : deltaLabel(delta, deltaUnit)}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50/80 via-card to-amber-50/60 p-4 dark:border-emerald-900/50 dark:from-emerald-950/20 dark:to-amber-950/10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-xs font-semibold text-foreground">{t("home.weekly.rhythm")}</p>
          <p className="text-[11px] text-muted-foreground">{tf("home.weekly.activeOfSeven", { count: this_week.active_days })}</p>
        </div>
        <div className="grid grid-cols-7 gap-1.5 sm:gap-2" aria-label={tf("home.weekly.activeOfSeven", { count: this_week.active_days })}>
          {dailyStudy.map((day, index) => {
            const minutes = day.study_minutes;
            const reachedGoal = minutes >= 5;
            const Icon = minutes >= 40 ? TreePine : minutes >= 20 ? Leaf : minutes > 0 ? Sprout : null;
            const tone = minutes >= 40
              ? "border-emerald-300 bg-emerald-100 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
              : minutes >= 20
                ? "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300"
                : minutes >= 5
                  ? "border-lime-200 bg-lime-50 text-lime-700 dark:border-lime-800 dark:bg-lime-950/40 dark:text-lime-300"
                  : minutes > 0
                    ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                    : "border-border/60 bg-card/70 text-muted-foreground";
            return (
              <div
                key={day.date}
                className={`flex min-w-0 flex-col items-center rounded-xl border px-1 py-2 ${tone} ${day.date === todayKey ? "ring-2 ring-brand/35 ring-offset-1" : ""}`}
                title={tf(reachedGoal ? "home.weekly.dayReached" : minutes > 0 ? "home.weekly.dayStarted" : "home.weekly.dayEmpty", { count: minutes })}
              >
                <span className="text-[10px] font-medium">{t(`home.weekly.weekday.${day.weekday || index + 1}`)}</span>
                <span className="my-1 grid size-6 place-items-center rounded-full bg-white/70 dark:bg-black/10">
                  {Icon ? <Icon className="size-3.5" aria-hidden="true" /> : <span className="size-1.5 rounded-full bg-current opacity-30" />}
                </span>
                <span className="truncate text-[9px] font-semibold tabular-nums sm:text-[10px]">{minutes > 0 ? tf("home.weekly.dayMinutes", { count: minutes }) : t("home.weekly.notStarted")}</span>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">{t("home.weekly.rhythmHint")}</p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {highlights.slice(0, 3).map((highlight) => (
            <p key={highlight} className="flex items-center gap-1.5 text-xs text-muted-foreground"><Sparkles className="size-3 text-brand" />{highlight}</p>
          ))}
        </div>
      </div>
    </DashSection>
  );
}

export function MasteryOverviewSection({
  masteryOverview,
  onNavigate,
}: {
  masteryOverview: LearningOverview | null;
  onNavigate: (path: string) => void;
}) {
  if (!masteryOverview || masteryOverview.course_summaries.length === 0) return null;

  return (
    <DashSection title="跨课程掌握度" icon={BookOpen}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-muted/30 p-3.5">
            <p className="text-[11px] text-muted-foreground">总体平均掌握度</p>
            <p className="text-xl font-bold text-brand tabular-nums">
              {Math.round(masteryOverview.average_mastery * 100)}%
            </p>
          </div>
          <div className="rounded-xl bg-muted/30 p-3.5">
            <p className="text-[11px] text-muted-foreground">累计学习时长</p>
            <p className="text-xl font-bold text-foreground tabular-nums">
              {masteryOverview.total_study_minutes}<span className="text-xs font-normal text-muted-foreground ml-0.5">分钟</span>
            </p>
          </div>
        </div>
        <div className="space-y-2">
          {masteryOverview.course_summaries.slice(0, 4).map((c) => (
            <button
              key={c.course_id}
              type="button"
              onClick={() => onNavigate(`/course/${c.course_id}/profile`)}
              className="w-full flex items-center gap-3 rounded-xl bg-muted/20 p-3 hover:bg-muted/40 transition-colors text-left"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{c.course_name}</p>
                <div className="mt-1 h-1.5 rounded-full bg-muted/60 overflow-hidden">
                  <div
                    className="h-full bg-brand rounded-full transition-all duration-500"
                    style={{ width: `${Math.round(c.average_mastery * 100)}%` }}
                  />
                </div>
              </div>
              <span className="text-sm font-semibold text-brand tabular-nums shrink-0">
                {Math.round(c.average_mastery * 100)}%
              </span>
            </button>
          ))}
        </div>
      </div>
    </DashSection>
  );
}

export function ModeRecommendationsSection({
  modeRecommendations,
  actingModeCourses,
  onApply,
  onDismiss,
  onNavigate,
  t,
}: {
  modeRecommendations: ModeRecommendation[];
  actingModeCourses: Set<string>;
  onApply: (item: ModeRecommendation) => void;
  onDismiss: (item: ModeRecommendation) => void;
  onNavigate: (path: string) => void;
  t: (key: string) => string;
}) {
  if (modeRecommendations.length === 0) return null;

  return (
    <DashSection title={t("home.modeRecommendations.title")} icon={Sparkles} badge={modeRecommendations.length}>
        <div className="space-y-3">
          {modeRecommendations.map((item) => (
            <div key={item.courseId} className="rounded-2xl border border-sky-100 bg-gradient-to-br from-sky-50/70 via-card to-violet-50/50 p-4 dark:border-sky-900/50 dark:from-sky-950/20 dark:to-violet-950/10">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{item.courseName}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>{t("home.modeRecommendations.current")}</span>
                    <ModeBadge mode={item.currentMode} />
                    <ArrowRight className="size-3.5" />
                    <ModeBadge mode={item.suggestedMode} />
                  </div>
                  <p className="mt-2 text-xs leading-5 text-foreground/80">{item.reason}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{t(`home.modeRecommendations.benefit.${item.suggestedMode}`)}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2 sm:max-w-56 sm:justify-end">
                  <Button size="sm" disabled={actingModeCourses.has(item.courseId)} onClick={() => onApply(item)}>{item.approvalCta}</Button>
                  <Button size="sm" variant="outline" onClick={() => onNavigate(`/course/${item.courseId}`)}>{t("home.modeRecommendations.openCourse")}</Button>
                  <Button size="sm" variant="ghost" disabled={actingModeCourses.has(item.courseId)} onClick={() => onDismiss(item)}>{t("home.modeRecommendations.snooze")}</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
    </DashSection>
  );
}
