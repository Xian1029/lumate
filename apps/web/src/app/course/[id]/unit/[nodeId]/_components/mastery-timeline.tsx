import type { MasterySnapshot } from "@/lib/api";
import { getGapTypeLabel } from "@/lib/display-mappers";
import { buildMasteryTimelinePoints, getNextLearningAction, type MasterySummary, type ErrorTrendSummary, type DifficultyRecommendation } from "./unit-utils";
import { Button } from "@/components/ui/button";

type TranslateFn = (key: string) => string;
type TranslateFormattedFn = (key: string, vars?: Record<string, string | number | null | undefined>) => string;

export function MasteryTimeline({ snapshots, t }: { snapshots: MasterySnapshot[]; t: TranslateFn }) {
  if (snapshots.length === 0) {
    return <p className="rounded-2xl bg-sky-50/70 px-4 py-3 text-sm leading-6 text-sky-900">完成本小节的练习后，这里会按学习日期记录掌握变化，帮助你看见进步，而不是堆叠每一次答题记录。</p>;
  }
  const points = buildMasteryTimelinePoints(snapshots);
  const first = points[0];
  const latest = points[points.length - 1];
  const change = latest.masteryPercent - first.masteryPercent;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2 rounded-2xl bg-sky-50/75 px-4 py-3">
        <div><p className="text-xs font-medium text-sky-800">当前掌握表现</p><p className="mt-0.5 text-2xl font-bold text-sky-950">{latest.masteryPercent}%</p></div>
        <p className="text-xs text-sky-800">{change > 0 ? `比首次记录提高 ${change}%` : change < 0 ? `比首次记录低 ${Math.abs(change)}%，建议复习后再检测` : "与首次记录持平，继续用练习确认"}</p>
      </div>
      <ol className="relative ml-2 space-y-3 border-l border-sky-200 pl-5">
        {points.map((item, i) => (
          <li key={`${item.recordedAt}-${i}`} className="relative">
            <span className="absolute -left-[1.8rem] top-1.5 size-3 rounded-full border-2 border-white bg-sky-500" />
            <div className="rounded-xl bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-3"><p className="text-sm font-medium text-foreground">{new Date(item.recordedAt).toLocaleDateString()}</p><span className="text-sm font-semibold text-sky-800">{item.masteryPercent}%</span></div>
              <p className="mt-1 text-xs text-muted-foreground">{item.gapType ? `${t("unit.errorPattern.type")}: ${getGapTypeLabel(item.gapType)}` : "这次检测没有记录明显的知识缺口"}{item.sampleCount > 1 ? ` · 当天 ${item.sampleCount} 次作答已合并显示` : ""}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function NextActionsSection({
  courseId,
  masterySummary,
  errorTrend,
  difficultyRec,
  quizModeHint,
  aiActionsEnabled,
  generatingFocusedQuiz,
  onGenerateFocusedQuiz,
  onNavigate,
  t,
  tf,
}: {
  courseId: string;
  masterySummary: MasterySummary;
  errorTrend: ErrorTrendSummary;
  difficultyRec: DifficultyRecommendation;
  quizModeHint: string;
  aiActionsEnabled: boolean;
  generatingFocusedQuiz: boolean;
  onGenerateFocusedQuiz: () => void;
  onNavigate: (path: string) => void;
  t: TranslateFn;
  tf: TranslateFormattedFn;
}) {
  const nextAction = getNextLearningAction({
    urgentReviewCount: masterySummary.urgent,
    wrongAnswerCount: errorTrend.recent7d + errorTrend.previous7d,
    errorTrend,
  });
  return (
    <div className="rounded-2xl bg-card card-shadow p-4">
      <h2 className="text-base font-semibold">{t("unit.nextActions.title")}</h2>
      <p className="text-xs text-muted-foreground mt-0.5">{t("unit.nextActions.desc")}</p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-muted/30 p-2.5">
          <p className="text-[11px] text-muted-foreground">{t("unit.masterySummary.avgMastery")}</p>
          <p className="text-base font-semibold">{masterySummary.avgMastery}%</p>
        </div>
        <div className="rounded-xl bg-muted/30 p-2.5">
          <p className="text-[11px] text-muted-foreground">{t("unit.masterySummary.avgRetrievability")}</p>
          <p className="text-base font-semibold">{masterySummary.avgRetrievability}%</p>
        </div>
        <div className="rounded-xl bg-muted/30 p-2.5">
          <p className="text-[11px] text-muted-foreground">{t("unit.masterySummary.warning")}</p>
          <p className="text-base font-semibold">{masterySummary.warning}</p>
        </div>
        <div className="rounded-xl bg-muted/30 p-2.5">
          <p className="text-[11px] text-muted-foreground">{t("unit.masterySummary.stale")}</p>
          <p className="text-base font-semibold">{masterySummary.stale}</p>
        </div>
      </div>

      <div className="mt-2 rounded-xl bg-muted/30 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">{t("unit.errorTrend.title")}</p>
          <span
            className={`text-[11px] font-medium ${
              errorTrend.direction === "up"
                ? "text-destructive"
                : errorTrend.direction === "down"
                  ? "text-success"
                  : "text-muted-foreground"
            }`}
          >
            {tf(`unit.errorTrend.${errorTrend.direction}`, { count: Math.abs(errorTrend.delta) })}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {tf("unit.errorTrend.window", {
            recent: errorTrend.recent7d,
            previous: errorTrend.previous7d,
          })}
        </p>
      </div>

      <div className="mt-2 rounded-xl bg-muted/30 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">{t("unit.difficulty.recommended")}</p>
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
              difficultyRec.level === "hard"
                ? "bg-destructive/15 text-destructive"
                : difficultyRec.level === "medium"
                  ? "bg-warning/15 text-warning"
                  : "bg-success/15 text-success"
            }`}
          >
            {t(`unit.difficulty.${difficultyRec.level}`)}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-1">{t(difficultyRec.reasonKey)}</p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {nextAction === "review" ? <Button
          size="sm"
          variant="outline"
          onClick={() => onNavigate(`/course/${courseId}/review`)}
        >
          {tf("unit.nextActions.review", { count: masterySummary.urgent })}
        </Button> : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => onNavigate(`/course/${courseId}/practice?tab=quiz&mode=${quizModeHint}&difficulty=${difficultyRec.level}`)}
        >
          {nextAction === "targeted_practice" ? "针对本小节薄弱点练习" : t("unit.nextActions.practice")}
        </Button>
        <Button
          size="sm"
          disabled={!aiActionsEnabled || generatingFocusedQuiz}
          onClick={onGenerateFocusedQuiz}
        >
          {generatingFocusedQuiz
            ? t("unit.generating")
            : tf("unit.generateFocusedQuizWithDifficulty", { level: t(`unit.difficulty.${difficultyRec.level}`) })}
        </Button>
      </div>
    </div>
  );
}
