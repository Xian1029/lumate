"use client";
import { useT } from "@/lib/i18n-context";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Lightbulb } from "lucide-react";
import type { AnswerResult } from "@/lib/api";

interface QuizResultProps {
  result: AnswerResult;
  /** When set, overrides the user-answer to display (used on review when we only persist a string). */
  userAnswerDisplay?: string;
  /** Question type hint — for MC/select_all we render option keys in uppercase. */
  questionType?: string;
  /** True when rendering a prior submission in review mode without grading result. */
  answeredOnly?: boolean;
}

function _formatUserAnswer(raw: string | null | undefined, questionType?: string): string {
  if (raw == null) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Multi-line (coding): keep raw, caller will render inside pre-like styling via wrapping p
  if (trimmed.includes("\n") || trimmed.includes("\r")) return trimmed;
  const qt = (questionType ?? "").toLowerCase();
  if (["mc", "select_all", "matching"].includes(qt)) {
    // Normalize option keys: sort letters, preserve original text just in case
    const parts = trimmed
      .split(/[,\s，、;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const allLetters = parts.every((p) => /^[A-Za-z]$/.test(p));
    if (allLetters) return parts.map((p) => p.toUpperCase()).sort().join(", ");
  }
  return trimmed;
}


function _formatCorrectAnswer(raw: string | null | undefined, questionType?: string): string {
  if (raw == null) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const qt = (questionType ?? "").toLowerCase();
  // True/False: 中文显示
  if (["tf", "true_false", "boolean", "bool"].includes(qt)) {
    const low = trimmed.toLowerCase();
    if (["true", "t", "yes", "y", "正确", "对", "是的", "是", "没错", "对等", "对的", "真的", "真", "1"].includes(low)) {
      return "正确";
    }
    if (["false", "f", "no", "n", "错误", "不对", "错", "否", "不是", "错的", "假的", "假", "荒谬", "0"].includes(low)) {
      return "错误";
    }
    // Fallback: 先尝试 bool 归一化
    const normCand = trimmed.toLowerCase();
    if (normCand === "true") return "正确";
    if (normCand === "false") return "错误";
    return trimmed;
  }
  // MC / select_all / matching: 大写字母排序展示
  if (["mc", "select_all", "matching"].includes(qt)) {
    const parts = trimmed
      .split(/[,\s，、;；]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    const allLetters = parts.every((p) => /^[A-Za-z]$/.test(p));
    if (allLetters) return parts.map((p) => p.toUpperCase()).sort().join(", ");
  }
  // Coding / short_answer / fill_blank / free_response: preserve raw, multi-line friendly
  return trimmed;
}

export function QuizResult({ result, userAnswerDisplay, questionType, answeredOnly = false }: QuizResultProps) {
  const t = useT();
  const displayedUserAnswer = userAnswerDisplay != null ? userAnswerDisplay : result.user_answer ?? undefined;
  const badgeText = answeredOnly
    ? t("quiz.answerRecorded")
    : result.is_correct
      ? t("quiz.correct")
      : t("quiz.incorrect");
  const fallbackCopy = answeredOnly
    ? t("quiz.answerRecorded")
    : result.is_correct
      ? t("quiz.answerRecorded")
      : result.correct_answer
        ? `${t("quiz.correctAnswerLabel")} ${_formatCorrectAnswer(result.correct_answer, questionType)}`
        : t("quiz.feedbackUnavailable");

  return (
    <>
      <div
        className={`space-y-2 rounded-2xl border p-3.5 ${
          answeredOnly
            ? "border-border/70 bg-muted/20"
            : result.is_correct
              ? "border-emerald-200/80 bg-emerald-50/55 dark:border-emerald-900/60 dark:bg-emerald-950/20"
              : "border-amber-200/80 bg-amber-50/45 dark:border-amber-900/60 dark:bg-amber-950/15"
        }`}
        aria-live="assertive"
      >
        <Badge
          variant="outline"
          className={
            answeredOnly
              ? "bg-background/70"
              : result.is_correct
                ? "gap-1.5 border-emerald-300 bg-emerald-100/80 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-200"
                : "gap-1.5 border-amber-300 bg-amber-100/80 text-amber-800 dark:border-amber-800 dark:bg-amber-950/70 dark:text-amber-200"
          }
        >
          {!answeredOnly && (result.is_correct
            ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            : <Lightbulb className="h-3.5 w-3.5" aria-hidden="true" />)}
          {badgeText}
        </Badge>
        {displayedUserAnswer ? (
          <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
            <span className="font-medium text-foreground/80">你的答案：</span>
            {_formatUserAnswer(displayedUserAnswer, questionType)}
          </p>
        ) : null}
        {/* 正确答案（即时提交 + answeredOnly 回看都显示） */}
        {result.correct_answer ? (
          <p className="text-xs leading-relaxed whitespace-pre-wrap break-words">
            <span className="font-medium text-success/90">正确答案：</span>
            <span className="text-foreground">{_formatCorrectAnswer(result.correct_answer, questionType)}</span>
          </p>
        ) : !answeredOnly && result.is_correct === false ? (
          <p className="text-xs leading-relaxed">
            <span className="font-medium text-success/90">正确答案：</span>
            <span className="text-muted-foreground italic">暂不可用</span>
          </p>
        ) : null}

        {/* 解析说明：无论 answeredOnly / 答对 / 答错，只要 explanation 非空就一定显示 */}
        {result.explanation ? (
          <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
            <span className="font-medium text-foreground/80">解析说明：</span>
            {result.explanation}
          </p>
        ) : !answeredOnly ? (
          <p className="text-xs text-muted-foreground leading-relaxed">{fallbackCopy}</p>
        ) : null}
      </div>

      {result.prerequisite_gaps && result.prerequisite_gaps.length > 0 ? (
        <div className="rounded-2xl border border-warning/30 bg-warning-muted/20 p-3.5 space-y-2">
          <p className="text-xs font-semibold text-warning">
            {t("quiz.prerequisiteGaps") !== "quiz.prerequisiteGaps"
              ? t("quiz.prerequisiteGaps")
              : t("ui.prereq_gaps_detected")}
          </p>
          <div className="space-y-1.5">
            {result.prerequisite_gaps.map((gap) => (
              <div key={gap.concept_id} className="flex items-center justify-between text-xs">
                <span className="text-foreground">{gap.concept}</span>
                <div className="flex items-center gap-2">
                  <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-warning rounded-full"
                      style={{ width: `${Math.round(gap.mastery * 100)}%` }}
                    />
                  </div>
                  <span className="text-muted-foreground w-8 text-right">
                    {Math.round(gap.mastery * 100)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {t("quiz.prerequisiteHint") !== "quiz.prerequisiteHint"
              ? t("quiz.prerequisiteHint")
              : t("ui.strengthen_foundations")}
          </p>
        </div>
      ) : null}
    </>
  );
}
