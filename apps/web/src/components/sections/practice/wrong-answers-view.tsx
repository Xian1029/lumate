"use client";

import { t } from "@/lib/i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw, CheckCircle2, AlertTriangle } from "lucide-react";
import { listWrongAnswers, retryWrongAnswer, getWrongAnswerStats, type WrongAnswer } from "@/lib/api";
import { MarkdownRenderer } from "@/components/shared/markdown-renderer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkeletonText } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { questionTypeLabel } from "./question-type-label";

interface WrongAnswersViewProps {
  courseId: string;
}

interface RetryState {
  value: string;
  submitting: boolean;
  feedback: {
    is_correct: boolean;
    correct_answer: string | null;
    explanation: string | null;
  } | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  conceptual: t("wrongAnswer.category.conceptual"),
  procedural: t("wrongAnswer.category.procedural"),
  computational: t("wrongAnswer.category.computational"),
  reading: t("wrongAnswer.category.reading"),
  careless: t("wrongAnswer.category.careless"),
};

const DIAGNOSIS_LABELS: Record<string, string> = {
  fundamental_gap: t("ui.fundamental_gap_lower"),
  trap_vulnerability: t("ui.trap_vuln_lower"),
  carelessness: t("ui.carelessness"),
  mastered: t("ui.mastered"),
};

function formatBadgeLabel(value: string): string {
  // 未知枚举兜底：返回中文占位，避免把内部英文枚举泄露给学生。
  return "待分类";
}

function isChoiceQuestion(item: WrongAnswer): boolean {
  return !!item.options && Object.keys(item.options).length > 0;
}

function WrongAnswerRow({
  item,
  retryState,
  onRetryInputChange,
  onRetrySubmit,
}: {
  item: WrongAnswer;
  retryState?: RetryState;
  onRetryInputChange: (id: string, value: string) => void;
  onRetrySubmit: (item: WrongAnswer, answer: string) => void;
}) {
  const optionEntries = useMemo(
    () => Object.entries(item.options ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    [item.options],
  );

  const value = retryState?.value ?? "";
  const submitting = retryState?.submitting ?? false;
  const feedback = retryState?.feedback;

  return (
    <article
      className="rounded-2xl card-shadow bg-card p-4 space-y-3"
      data-testid={`wrong-answer-row-${item.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium text-foreground">
            {item.question ?? t("ui.untitled_question")}
          </p>
          <div className="flex flex-wrap gap-2">
            {item.question_type ? <Badge variant="outline">{questionTypeLabel(item.question_type, t)}</Badge> : null}
            {item.error_category ? (
              <Badge variant="secondary">
                {CATEGORY_LABELS[item.error_category] ?? formatBadgeLabel(item.error_category)}
              </Badge>
            ) : null}
            {item.diagnosis ? (
              <Badge variant="secondary">
                {DIAGNOSIS_LABELS[item.diagnosis] ?? formatBadgeLabel(item.diagnosis)}
              </Badge>
            ) : null}
            <Badge variant="outline">已错 {item.wrong_attempt_count} 次</Badge>
            <Badge variant="outline">{t("wrongAnswer.reviewedCount").replace("{count}", String(item.review_count))}</Badge>
          </div>
        </div>
        <Badge variant={item.mastered ? "secondary" : "outline"}>
          {item.mastered ? t("ui.mastered") : t("ui.needs_retry")}
        </Badge>
      </div>

      <div className="rounded-xl bg-muted/30 p-3 text-sm space-y-1">
        <p className="text-muted-foreground">
          {t("wrongAnswer.lastAnswer")}：<span className="text-foreground">{item.user_answer || "—"}</span>
        </p>
        {item.knowledge_points?.length ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {item.knowledge_points.slice(0, 4).map((point) => (
              <Badge key={point} variant="outline" className="text-[10px]">
                {point}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      {isChoiceQuestion(item) ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {optionEntries.map(([key, label]) => (
            <Button
              key={key}
              type="button"
              variant={value === key ? "default" : "outline"}
              className="h-auto justify-start whitespace-normal py-3 text-left"
              disabled={submitting}
              onClick={() => onRetrySubmit(item, key)}
            >
              <span className="mr-2 shrink-0 font-semibold">{key}.</span>
              <span>{label}</span>
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={value}
            disabled={submitting}
            placeholder={t("ui.type_your_retry_answer")}
            onChange={(event) => onRetryInputChange(item.id, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && value.trim()) {
                event.preventDefault();
                onRetrySubmit(item, value);
              }
            }}
          />
          <Button
            type="button"
            disabled={submitting || !value.trim()}
            onClick={() => onRetrySubmit(item, value)}
          >
            {submitting ? t("ui.retrying") : t("graph.retry")}
          </Button>
        </div>
      )}

      {feedback ? (
        <div
          className={`rounded-xl border p-3 space-y-2 ${
            feedback.is_correct
              ? "border-success/40 bg-success-muted/40"
              : "border-warning/40 bg-warning-muted/40"
          }`}
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            {feedback.is_correct ? (
              <CheckCircle2 className="size-4 text-success" />
            ) : (
              <AlertTriangle className="size-4 text-warning-foreground" />
            )}
            <span>{feedback.is_correct ? t("ui.correct_on_retry") : t("ui.still_needs_work")}</span>
          </div>
          {feedback.correct_answer ? (
            <p className="text-sm text-muted-foreground">
              {t("wrongAnswer.correctAnswer")}：<span className="text-foreground">{feedback.correct_answer}</span>
            </p>
          ) : null}
          {feedback.explanation ? (
            <MarkdownRenderer
              content={feedback.explanation}
              className="prose prose-sm max-w-none dark:prose-invert"
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function WrongAnswersView({ courseId }: WrongAnswersViewProps) {
  const [items, setItems] = useState<WrongAnswer[]>([]);
  const [stats, setStats] = useState<{
    total: number;
    mastered: number;
    unmastered: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryStateById, setRetryStateById] = useState<Record<string, RetryState>>({});

  const loadWrongAnswers = useCallback(async () => {
    try {
      const [wrongAnswers, summary] = await Promise.all([
        listWrongAnswers(courseId, { mastered: false }),
        getWrongAnswerStats(courseId),
      ]);
      setItems(wrongAnswers);
      setStats(summary);
    } catch {
      setItems([]);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    void loadWrongAnswers();
  }, [loadWrongAnswers]);

  const onRetryInputChange = useCallback((id: string, value: string) => {
    setRetryStateById((prev) => ({
      ...prev,
      [id]: {
        value,
        submitting: prev[id]?.submitting ?? false,
        feedback: prev[id]?.feedback ?? null,
      },
    }));
  }, []);

  const onRetrySubmit = useCallback(async (item: WrongAnswer, rawAnswer: string) => {
    const answer = rawAnswer.trim();
    if (!answer) return;

    setRetryStateById((prev) => ({
      ...prev,
      [item.id]: {
        value: answer,
        submitting: true,
        feedback: prev[item.id]?.feedback ?? null,
      },
    }));

    try {
      const result = await retryWrongAnswer(item.id, answer);
      setRetryStateById((prev) => ({
        ...prev,
        [item.id]: {
          value: answer,
          submitting: false,
          feedback: result,
        },
      }));

      if (result.is_correct) {
        toast.success(t("ui.wrong_cleared"));
        await loadWrongAnswers();
      } else {
        toast.error(t("ui.still_incorrect"));
      }
    } catch (error) {
      setRetryStateById((prev) => ({
        ...prev,
        [item.id]: {
          value: answer,
          submitting: false,
          feedback: prev[item.id]?.feedback ?? null,
        },
      }));
      toast.error((error as Error).message || t("ui.retry_failed"));
    }
  }, [loadWrongAnswers]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8" data-testid="wrong-answers-panel" role="status">
        <SkeletonText lines={4} className="w-full max-w-2xl" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
        data-testid="wrong-answers-panel"
      >
        <CheckCircle2 className="size-10 text-success" />
        <div>
          <p className="text-sm font-medium">{t("ui.no_active_wrong_answers")}</p>
          <p className="text-xs text-muted-foreground">
            做错的题目会显示在这里，方便你重新练习并清理。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label={t("ui.wrong_answers")}
      className="flex-1 flex flex-col overflow-hidden"
      data-testid="wrong-answers-panel"
    >
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <RotateCcw className="size-4 text-warning-foreground" />
          <span>{t("ui.wrong_answers_1")}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("wrongAnswer.description")}
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-thin p-4 pr-3 space-y-4">
        {stats ? (
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-2xl card-shadow bg-card p-3">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("ui.active")}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{stats.unmastered}</p>
            </div>
            <div className="rounded-2xl card-shadow bg-card p-3">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("ui.mastered")}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{stats.mastered}</p>
            </div>
            <div className="rounded-2xl card-shadow bg-card p-3">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("ui.all_logged")}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{stats.total}</p>
            </div>
          </div>
        ) : null}

        <div className="space-y-3">
          {items.map((item) => (
            <WrongAnswerRow
              key={item.id}
              item={item}
              retryState={retryStateById[item.id]}
              onRetryInputChange={onRetryInputChange}
              onRetrySubmit={onRetrySubmit}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
