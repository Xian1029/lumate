"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n-context";
import { getLocale } from "@/lib/i18n";
import {
  extractQuiz,
  listProblems,
  submitAnswer,
  type QuizProblem,
  type AnswerResult,
} from "@/lib/api";
import { useWorkspaceStore } from "@/store/workspace";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { AiFeatureBlocked } from "@/components/shared/ai-feature-blocked";
import { SkeletonCard } from "@/components/ui/skeleton";
import { updateUnlockContext, getUnlockContext } from "@/lib/block-system/feature-unlock";
import { QuizOptions } from "./quiz-options";
import { QuizResult } from "./quiz-result";
import { useQuizPersistence } from "./use-quiz-persistence";

interface QuizViewProps {
  courseId: string;
  aiActionsEnabled?: boolean;
  modeHint?: "course_following" | "self_paced" | "exam_prep" | "maintenance";
  difficultyHint?: "easy" | "medium" | "hard";
  exitHref?: string;
}

type AnsweredFeedback = {
  answer: string;
  is_correct?: boolean | null;
  correct_answer?: string | null;
  explanation?: string | null;
};

export function calculateQuizScore(
  problems: Array<Pick<QuizProblem, "id">>,
  answeredMap: Record<string, AnsweredFeedback>,
  legacyScore = { correct: 0, total: 0 },
) {
  const activeAnswers = problems
    .map((problem) => answeredMap[problem.id])
    .filter((answer): answer is AnsweredFeedback => Boolean(answer?.answer));
  const total = activeAnswers.length;
  const knownCorrect = activeAnswers.filter((answer) => answer.is_correct === true).length;
  const unknownCount = activeAnswers.filter((answer) => typeof answer.is_correct !== "boolean").length;
  // Old sessions saved only answer strings. Preserve their old correct count,
  // but constrain it to the actual number of answered questions.
  const legacyUnknownCorrect = Math.min(
    unknownCount,
    Math.max(0, legacyScore.correct - knownCorrect),
  );
  return { correct: knownCorrect + legacyUnknownCorrect, total };
}

/**
 * A generated request is persisted as one batch on the server.  Pick the most
 * recently ordered batch rather than mixing old completed questions with a new
 * exercise set.  Legacy questions (without a batch) remain one compatible set.
 */
export function selectLatestExerciseSet(items: QuizProblem[]): { items: QuizProblem[]; batchId: string | null } {
  if (items.length === 0) return { items: [], batchId: null };
  const batchOrders = new Map<string, number>();
  for (const item of items) {
    const key = item.source_batch_id || "__legacy__";
    batchOrders.set(key, Math.max(batchOrders.get(key) ?? Number.NEGATIVE_INFINITY, item.order_index ?? 0));
  }
  const [latestKey] = [...batchOrders.entries()]
    .sort(([, leftOrder], [, rightOrder]) => rightOrder - leftOrder)[0];
  return {
    items: items.filter((item) => (item.source_batch_id || "__legacy__") === latestKey),
    batchId: latestKey === "__legacy__" ? null : latestKey,
  };
}

function layerBadgeClass(layer: number): string {
  if (layer >= 3) return "bg-destructive/10 text-destructive";
  if (layer === 2) return "bg-warning/10 text-warning";
  return "bg-success/10 text-success";
}

function isUsableProblem(problem: QuizProblem): boolean {
  // The list endpoint intentionally omits answers and explanations, so students
  // cannot inspect them in the browser before submitting.  Those fields are
  // validated by the server when a generated question is saved; requiring them
  // here made every valid generated question disappear from the quiz panel.
  if (!problem.question?.trim()) return false;
  if (problem.answer_ready === false || problem.explanation_ready === false) return false;
  if (problem.question_type === "coding") {
    const metadata = (problem.problem_metadata ?? {}) as Record<string, unknown>;
    const sourceSection = String(metadata.source_section ?? "");
    const programmingSection = /python|javascript|typescript|java|c\+\+|编程|程序设计|代码|算法实现|数据结构/i;
    // Legacy models occasionally turned an ordinary mathematics application
    // into a Python exercise. The source section—not the generated question—
    // decides whether a coding answer is appropriate.
    if (!programmingSection.test(sourceSection)) return false;
  }
  if (["mc", "select_all", "matching"].includes(problem.question_type)) {
    const optionCount = Object.keys(problem.options ?? {}).length;
    if (optionCount < (problem.question_type === "mc" ? 4 : 2)) return false;
  }
  if (getLocale() === "zh") {
    const visible = [problem.question, problem.explanation, ...Object.values(problem.options ?? {})].join(" ");
    return /[\u4e00-\u9fff]{2,}/.test(visible);
  }
  return true;
}

export function QuizView({
  courseId,
  aiActionsEnabled = true,
  modeHint,
  difficultyHint,
  exitHref,
}: QuizViewProps) {
  const t = useT();
  const refreshKey = useWorkspaceStore((s) => s.sectionRefreshKey["practice"]);
  const selectedNodeId = useWorkspaceStore((s) => s.selectedNodeId);
  const [problems, setProblems] = useState<QuizProblem[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [generatingReinforcement, setGeneratingReinforcement] = useState(false);
  const [generatingFresh, setGeneratingFresh] = useState(false);
  const [extractStatus, setExtractStatus] = useState<string | null>(null);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState<string>("");
  const [textAnswer, setTextAnswer] = useState<string>("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [persistedScore, setPersistedScore] = useState({ correct: 0, total: 0 });
  const [answeredMap, setAnsweredMap] = useState<Record<string, AnsweredFeedback>>({});
  const score = useMemo(
    () => calculateQuizScore(problems, answeredMap, persistedScore),
    [answeredMap, persistedScore, problems],
  );
  // Always-up-to-date mirror, read by effects that intentionally don't depend
  // on `answeredMap` to avoid triggering on every single submit.
  const answeredMapRef = useRef<Record<string, AnsweredFeedback>>({});
  answeredMapRef.current = answeredMap;
  const consecutiveWrongRef = useRef(0);
  const questionStartTimeRef = useRef(Date.now());
  const restoredRef = useRef(false);
  const freshSessionRequestedRef = useRef(false);
  const [sessionBatchId, setSessionBatchId] = useState<string | null>(null);
  const { save, load, clear, subscribe } = useQuizPersistence(courseId, selectedNodeId);

  const fetchData = useCallback(async () => {
    setLoading(true);
    if (!selectedNodeId) {
      setProblems([]);
      setLoading(false);
      return;
    }
    try {
      const items = await listProblems(courseId, selectedNodeId);
      const usableItems = items.filter(isUsableProblem);
      let sessionItems = usableItems;
      let nextBatchId: string | null = null;

      // Restore session from localStorage (only once per mount)
      if (!restoredRef.current) {
        restoredRef.current = true;
        const saved = load();
        const savedIds = new Set(saved?.problemIds ?? []);
        const restoredItems = savedIds.size
          ? usableItems.filter((item) => savedIds.has(item.id))
          : [];
        const completedSavedSession = savedIds.size > 0
          && restoredItems.length === savedIds.size
          && restoredItems.every((item) => item.is_answered === true);

        // Server submission records are authoritative.  A browser cache can
        // resume an unfinished set only; it must never revive a completed set.
        if (saved && !completedSavedSession && restoredItems.length) {
          sessionItems = restoredItems;
          nextBatchId = saved.batchId ?? selectLatestExerciseSet(restoredItems).batchId;
          if (saved.currentIdx < restoredItems.length) {
            setCurrentIdx(saved.currentIdx);
            setPersistedScore(saved.score);
            // Upgrade legacy Record<string,string> (pure answer strings, possibly
            // persisted before this change) into AnsweredFeedback shape.
            const normalized: Record<string, AnsweredFeedback> = {};
            for (const [k, v] of Object.entries(saved.answeredMap || {})) {
              if (v == null) continue;
              if (typeof v === "string") {
                normalized[k] = { answer: v };
              } else if (
                typeof v === "object" &&
                typeof (v as unknown as AnsweredFeedback).answer === "string"
              ) {
                normalized[k] = v as unknown as AnsweredFeedback;
              } else if (typeof v === "object" && (v as { answer?: unknown }).answer != null) {
                normalized[k] = { answer: String((v as { answer: unknown }).answer) };
              }
            }
            setAnsweredMap(normalized);
            consecutiveWrongRef.current = saved.consecutiveWrong;
          }
        } else {
          const latest = selectLatestExerciseSet(usableItems);
          const latestIsComplete = latest.items.length > 0 && latest.items.every((item) => item.is_answered === true);
          if (completedSavedSession) clear();

          if (latestIsComplete) {
            // A completed set has no resume path. Generate a deduplicated next
            // set from the same selected lesson, then store it as a fresh session.
            if (aiActionsEnabled && !freshSessionRequestedRef.current) {
              freshSessionRequestedRef.current = true;
              setGeneratingFresh(true);
              try {
                const response = await extractQuiz(
                  courseId,
                  selectedNodeId,
                  modeHint ?? useWorkspaceStore.getState().spaceLayout.mode ?? undefined,
                  difficultyHint,
                  true,
                );
                const freshIds = new Set(response.problem_ids ?? []);
                const updatedItems = (await listProblems(courseId, selectedNodeId)).filter(isUsableProblem);
                const freshItems = updatedItems.filter((item) => freshIds.has(item.id));
                if (freshItems.length) {
                  sessionItems = freshItems;
                  nextBatchId = response.batch_id ?? selectLatestExerciseSet(freshItems).batchId;
                  save({
                    currentIdx: 0,
                    problemIds: freshItems.map((item) => item.id),
                    batchId: nextBatchId,
                    score: { correct: 0, total: 0 },
                    answeredMap: {},
                    consecutiveWrong: 0,
                  });
                  setExtractStatus(`已为你准备 ${freshItems.length} 道新的练习题`);
                } else {
                  sessionItems = [];
                  setExtractStatus("当前练习已完成，暂时没有生成出新的练习题，请稍后重试。");
                }
              } catch {
                sessionItems = [];
                setExtractStatus("当前练习已完成，暂时无法生成新题，请稍后重试。");
              } finally {
                setGeneratingFresh(false);
              }
            } else {
              sessionItems = [];
              setExtractStatus("当前练习已完成，请生成下一组练习题。");
            }
          } else {
            sessionItems = latest.items;
            nextBatchId = latest.batchId;
          }
        }
      }
      setProblems(sessionItems);
      setSessionBatchId(nextBatchId);
      setCurrentIdx((index) => Math.min(index, Math.max(sessionItems.length - 1, 0)));
    } catch {
      setProblems([]);
    } finally {
      setLoading(false);
    }
  }, [aiActionsEnabled, clear, courseId, difficultyHint, load, modeHint, save, selectedNodeId]);

  useEffect(() => {
    restoredRef.current = false;
    setProblems([]);
    setCurrentIdx(0);
    setPersistedScore({ correct: 0, total: 0 });
    setAnsweredMap({});
    setSessionBatchId(null);
    freshSessionRequestedRef.current = false;
  }, [selectedNodeId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData, refreshKey]);

  useEffect(() => subscribe((saved) => {
    if (!saved) return;
    const normalized: Record<string, AnsweredFeedback> = {};
    for (const [key, value] of Object.entries(saved.answeredMap || {})) {
      if (typeof value === "string") normalized[key] = { answer: value };
      else if (value && typeof value.answer === "string") normalized[key] = value;
    }
    setAnsweredMap(normalized);
    setPersistedScore(saved.score);
    setCurrentIdx(Math.max(0, Math.min(saved.currentIdx, Math.max(problems.length - 1, 0))));
    consecutiveWrongRef.current = saved.consecutiveWrong;
  }), [problems.length, subscribe]);

  useEffect(() => {
    const currentProblem = problems[currentIdx];
    const pid = currentProblem?.id;
    const savedAnswer = pid ? answeredMapRef.current[pid]?.answer : undefined;
    setResult(null);
    questionStartTimeRef.current = Date.now();

    // For MC / select_all: restore the option key so the radio/checkbox shows selection
    const isOptionBased = currentProblem
      ? ["mc", "select_all", "matching"].includes(currentProblem.question_type)
      : false;
    setSelectedOption(isOptionBased && savedAnswer ? savedAnswer : null);

    // For coding: restore the multi-line user answer
    if (currentProblem?.question_type === "coding") {
      setCodeInput(savedAnswer ?? "");
      setTextAnswer("");
    } else if (isOptionBased) {
      setCodeInput("");
      setTextAnswer("");
    } else {
      // Text input types (tf / short_answer / fill_blank / free_response):
      // restore the raw answer the learner typed so they can see it on review.
      setCodeInput("");
      setTextAnswer(savedAnswer ?? "");
    }
    // Note: persistence is handled in handleOptionClick with fresh values
  }, [currentIdx, problems]);

  const handleExtract = async () => {
    setExtracting(true);
    setExtractStatus(null);
    try {
      const layoutMode = useWorkspaceStore.getState().spaceLayout.mode ?? undefined;
      const selectedNodeId = useWorkspaceStore.getState().selectedNodeId ?? undefined;
      const mode = modeHint ?? layoutMode;
      const res = await extractQuiz(courseId, selectedNodeId, mode, difficultyHint, true);
      let status = t("quiz.extract.success").replace("{count}", String(res.problems_created));
      if (res.discarded_count > 0) {
        status += `（已略过 ${res.discarded_count} 道不合适的题目）`;
      }
      if (res.warnings?.length) {
        status += `（${res.warnings[0]}）`;
      }
      setExtractStatus(status);
      const generatedIds = new Set(res.problem_ids ?? []);
      const generatedItems = (await listProblems(courseId, selectedNodeId))
        .filter((item) => generatedIds.has(item.id))
        .filter(isUsableProblem);
      if (generatedItems.length) {
        resetQuizState(generatedItems, res.batch_id ?? selectLatestExerciseSet(generatedItems).batchId);
      } else {
        setExtractStatus("暂时没有生成出可用的新题，请稍后重试。");
      }
    } catch (error) {
      setExtractStatus(t("quiz.extract.failed"));
    } finally {
      setExtracting(false);
    }
  };

  const handleOptionClick = async (option: string) => {
    if (result || submitting) return;

    const problemId = problems[currentIdx].id;

    // Idempotency: if already answered (e.g. after refresh), don't re-submit
    if (answeredMap[problemId]?.answer) return;

    setSubmitError(null);
    setSelectedOption(option);
    setSubmitting(true);
    try {
      const answerTimeMs = Date.now() - questionStartTimeRef.current;
      const rawRes = await submitAnswer(problemId, option, answerTimeMs);
      // Final fallback: if any of the grading feedback keys are still missing
      // after API normalization, merge from `problem` for rendering.
      // This handles rare cases where fetch-middleware / caching strips them.
      const fallbackCorrect = problem.correct_answer ?? null;
      const fallbackExplanation = problem.explanation ?? null;
      const res = {
        ...rawRes,
        correct_answer: rawRes.correct_answer ?? fallbackCorrect,
        explanation: rawRes.explanation ?? fallbackExplanation,
        user_answer: rawRes.user_answer ?? option,
      };
      setResult(res);
      // Show toast if backend reported warnings (e.g. progress tracking failed)
      if (res.warnings && res.warnings.length > 0) {
        toast.warning(t("quiz.progressWarning"));
      } else if (!res.explanation || (!res.is_correct && !res.correct_answer)) {
        toast.warning(t("quiz.feedbackWarning"));
      }
      const newScore = {
        correct: score.correct + (res.is_correct ? 1 : 0),
        total: score.total + 1,
      };
      setPersistedScore(newScore);
      // Cache submission feedback (correct_answer/explanation) inside the answered
      // map — the answered-only rendering branch reads this cache directly and
      // therefore never relies on the stale pre-submit `problem` object, where
      // correct_answer / explanation intentionally remain NULL as an anti-spoiler
      // measure until the next full page reload re-fetches list_problems.
      const feedback: AnsweredFeedback = {
        answer: option,
        is_correct: res.is_correct,
        correct_answer: res.correct_answer,
        explanation: res.explanation,
      };
      const newAnswered: Record<string, AnsweredFeedback> = { ...answeredMap, [problemId]: feedback };
      setAnsweredMap(newAnswered);

      // Persist immediately after answer. Downgrade the feedback map to a plain
      // Record<string, string> (answer strings only) to keep the storage layer
      // stable/small and compatible with any pre-existing legacy restores.
      save({
        currentIdx,
        problemIds: problems.map((item) => item.id),
        batchId: sessionBatchId,
        score: newScore,
        answeredMap: newAnswered,
        consecutiveWrong: consecutiveWrongRef.current,
      });

      // Track feature-unlock context
      const ctx = getUnlockContext(courseId, 0);
      updateUnlockContext(courseId, {
        practiceAttempts: ctx.practiceAttempts + 1,
        hasWrongAnswer: ctx.hasWrongAnswer || !res.is_correct,
      });
      useWorkspaceStore.getState().triggerRefresh("analytics");
      // Track consecutive wrong answers to surface wrong_answers block
      if (!res.is_correct) {
        consecutiveWrongRef.current += 1;
        if (consecutiveWrongRef.current >= 3) {
          const store = useWorkspaceStore.getState();
          const blocks = store.spaceLayout.blocks;
          const hasWrongAnswersBlock = blocks.some(b => b.type === "wrong_answers");
          if (!hasWrongAnswersBlock) {
            store.addBlock("wrong_answers", {}, "agent");
          }
          consecutiveWrongRef.current = 0;
        }
      } else {
        consecutiveWrongRef.current = 0;
      }
    } catch {
      setSelectedOption(null);
      setSubmitError(t("quiz.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  };
  const handleRetryCurrent = useCallback(() => {
    const problemId = problems[currentIdx]?.id;
    if (!problemId) return;
    setSelectedOption(null);
    setCodeInput("");
    setTextAnswer("");
    setResult(null);
    setSubmitError(null);
    questionStartTimeRef.current = Date.now();
    setAnsweredMap((prevMap) => {
      if (!(problemId in prevMap)) return prevMap;
      const wasCorrect = prevMap[problemId]?.is_correct === true;
      const next: Record<string, AnsweredFeedback> = { ...prevMap };
      delete next[problemId];
      setPersistedScore((prevScore) => {
        const correct = Math.max(0, prevScore.correct - (wasCorrect ? 1 : 0));
        const total = Math.max(0, prevScore.total - 1);
        const nextScore = { correct, total };
        // Persist answer-only strings (storage contract stable)
        save({
          currentIdx,
          problemIds: problems.map((item) => item.id),
          batchId: sessionBatchId,
          score: nextScore,
          answeredMap: next,
          consecutiveWrong: consecutiveWrongRef.current,
        });
        return nextScore;
      });
      return next;
    });
    toast.success("已重置本题，可重新作答");
  }, [currentIdx, problems, save, sessionBatchId]);

  const resetQuizState = useCallback((nextProblems?: QuizProblem[], nextBatchId?: string | null) => {
    if (nextProblems) setProblems(nextProblems);
    const activeBatchId = nextBatchId ?? sessionBatchId;
    setSessionBatchId(activeBatchId);
    setPersistedScore({ correct: 0, total: 0 });
    setAnsweredMap({});
    setCurrentIdx(0);
    setResult(null);
    setSelectedOption(null);
    setCodeInput("");
    setTextAnswer("");
    setSubmitError(null);
    consecutiveWrongRef.current = 0;
    const activeProblems = nextProblems ?? problems;
    save({
      currentIdx: 0,
      problemIds: activeProblems.map((item) => item.id),
      batchId: activeBatchId,
      score: { correct: 0, total: 0 },
      answeredMap: {},
      consecutiveWrong: 0,
    });
  }, [problems, save, sessionBatchId]);

  const handleGenerateReinforcement = useCallback(async () => {
    if (generatingReinforcement) return;
    setGeneratingReinforcement(true);
    try {
      const nodeId = useWorkspaceStore.getState().selectedNodeId ?? undefined;
      if (!nodeId) throw new Error("请先选择要强化的小节");
      const response = await extractQuiz(courseId, nodeId, "maintenance", difficultyHint, true);
      const generatedIdSet = new Set(response.problem_ids ?? []);
      const latest = (await listProblems(courseId, nodeId))
        .filter((item) => generatedIdSet.has(item.id))
        .filter(isUsableProblem);
      if (latest.length === 0) throw new Error("强化题已生成，但暂时无法载入");
      resetQuizState(latest, response.batch_id ?? selectLatestExerciseSet(latest).batchId);
      toast.success(`已生成 ${latest.length} 道错题强化练习`);
    } catch (error) {
      toast.error((error as Error).message || "生成错题强化练习失败");
    } finally {
      setGeneratingReinforcement(false);
    }
  }, [courseId, difficultyHint, generatingReinforcement, resetQuizState]);

  const handleGenerateFresh = useCallback(async () => {
    if (generatingFresh) return;
    setGeneratingFresh(true);
    try {
      const selectedNodeId = useWorkspaceStore.getState().selectedNodeId ?? undefined;
      if (!selectedNodeId) throw new Error("请先选择要练习的小节");
      const previousIds = new Set((await listProblems(courseId, selectedNodeId)).map((item) => item.id));
      const response = await extractQuiz(
        courseId,
        selectedNodeId,
        modeHint ?? useWorkspaceStore.getState().spaceLayout.mode ?? undefined,
        difficultyHint,
        true,
      );
      const returnedIds = new Set(response.problem_ids ?? []);
      const allProblems = await listProblems(courseId, selectedNodeId);
      const freshProblems = allProblems.filter((item) =>
        returnedIds.size ? returnedIds.has(item.id) : !previousIds.has(item.id),
      ).filter(isUsableProblem);
      if (!freshProblems.length) {
        toast.warning("暂时没有生成出不重复的新题，请稍后再试");
        return;
      }
      resetQuizState(freshProblems, response.batch_id ?? selectLatestExerciseSet(freshProblems).batchId);
      toast.success(`已换成 ${freshProblems.length} 道不重复的新题`);
    } catch (error) {
      toast.error((error as Error).message || "生成新题失败，请稍后再试");
    } finally {
      setGeneratingFresh(false);
    }
  }, [courseId, difficultyHint, generatingFresh, modeHint, resetQuizState]);

  if (!selectedNodeId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center" data-testid="quiz-panel">
        <h3 className="mb-1 text-sm font-medium">{t("quiz.chooseChapterTitle")}</h3>
        <p className="max-w-xs text-xs text-muted-foreground">{t("quiz.chooseChapterHint")}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8" data-testid="quiz-panel" role="status" aria-live="polite">
        <SkeletonCard className="w-full max-w-md" />
      </div>
    );
  }

  if (problems.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center" data-testid="quiz-panel">
        <h3 className="text-sm font-medium mb-1">{t("quiz.title")}</h3>
        <p className="text-xs text-muted-foreground max-w-xs">{t("quiz.empty")}</p>
        {!aiActionsEnabled ? <AiFeatureBlocked compact className="mt-3 w-full max-w-sm text-left" /> : null}
        <Button className="mt-3" size="sm" onClick={() => void handleExtract()} disabled={!aiActionsEnabled || extracting}>
          {extracting ? `${t("quiz.generating")}...` : t("quiz.generate")}
        </Button>
        {extractStatus ? (
          <p role="status" aria-live="polite" className="mt-3 text-xs text-muted-foreground" data-testid="quiz-extract-status">
            {extractStatus}
          </p>
        ) : null}
      </div>
    );
  }

  const problem = problems[currentIdx];
  if (!problem) {
    // A refresh may replace a stale question set while a learner is viewing it.
    // Avoid rendering an undefined item; the next fetch supplies a valid set.
    return null;
  }
  const optionKeys = problem.options ? Object.keys(problem.options).sort() : [];
  const accuracy = score.total > 0 ? Math.round((score.correct / score.total) * 100) : null;
  const difficultyLayer = problem.difficulty_layer ?? null;
  const metadata = (problem.problem_metadata ?? {}) as Record<string, unknown>;
  const coreConcept = typeof metadata.core_concept === "string" ? metadata.core_concept : null;
  const bloomLevel = typeof metadata.bloom_level === "string" ? metadata.bloom_level : null;
  const answeredProblemCount = problems.reduce(
    (count, item) => count + (answeredMap[item.id]?.answer ? 1 : 0),
    0,
  );
  const isQuizComplete = problems.length > 0 && problems.every(
    (item) => Boolean(answeredMap[item.id]?.answer),
  );

  return (
    <div role="form" aria-label={t("quiz.ariaLabel")} className="flex-1 flex flex-col overflow-hidden" data-testid="quiz-panel">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 shrink-0">
        <Badge variant="outline" className="text-muted-foreground">
          完成进度 {Math.round((answeredProblemCount / Math.max(1, problems.length)) * 100)}%
        </Badge>
        {accuracy !== null ? <Badge variant="outline">正确率 {accuracy}%</Badge> : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {t("quiz.question")} {currentIdx + 1} {t("quiz.of")} {problems.length}
        </span>
        {aiActionsEnabled ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs h-6 px-2"
            disabled={extracting}
            onClick={() => void handleExtract()}
          >
            {extracting ? "..." : "+"}
          </Button>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
        {exitHref ? (
          <Link
            href={exitHref}
            className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            ← 返回课程
          </Link>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          {difficultyHint ? (
            <Badge variant="outline" className="text-[10px]">
              {t("quiz.strategy")}: {t(`quiz.difficulty.${difficultyHint}`)}
            </Badge>
          ) : null}
          {difficultyLayer ? (
            <Badge variant="outline" className={`text-[10px] ${layerBadgeClass(difficultyLayer)}`}>
              {t("quiz.layer").replace("{layer}", String(difficultyLayer))}
            </Badge>
          ) : null}
          {coreConcept ? (
            <Badge variant="outline" className="text-[10px]">
              {coreConcept}
            </Badge>
          ) : null}
          {bloomLevel ? (
            <Badge variant="outline" className="text-[10px]">
              {t("quiz.bloom").replace("{level}", bloomLevel)}
            </Badge>
          ) : null}
        </div>

        <p id="quiz-question-text" className="text-sm font-medium leading-relaxed" data-testid="quiz-question">
          {problem.question}
        </p>

        {problem.question_type === "coding" ? (
          <div className="space-y-2">
            <textarea
              className="w-full rounded-lg border border-border bg-muted/30 font-mono text-sm p-3 min-h-[140px] resize-y focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              placeholder={t("quiz.coding.placeholder")}
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              disabled={!!result || submitting || !!answeredMap[problem.id]?.answer}
              aria-label={t("quiz.coding.ariaLabel")}
              spellCheck={false}
            />
            {!result && !answeredMap[problem.id]?.answer && (
              <Button
                type="button"
                size="sm"
                disabled={submitting || codeInput.trim().length === 0}
                onClick={() => void handleOptionClick(codeInput.trim())}
              >
                {submitting ? `${t("quiz.coding.submitting")}...` : t("quiz.coding.submit")}
              </Button>
            )}
          </div>
        ) : problem.question_type === "mc" ? (
          <QuizOptions
            optionKeys={optionKeys}
            options={problem.options ?? {}}
            selectedOption={selectedOption}
            result={result}
            submitting={submitting}
            onOptionClick={handleOptionClick}
          />
        ) : (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              const answer = textAnswer.trim();
              if (!answer || result || submitting || answeredMap[problem.id]?.answer) return;
              void handleOptionClick(answer);
            }}
          >
            <textarea
              rows={3}
              className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm leading-relaxed shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
              value={textAnswer}
              onChange={(event) => setTextAnswer(event.target.value)}
              placeholder={t("quiz.textAnswerPlaceholder")}
              disabled={!!result || submitting || !!answeredMap[problem.id]?.answer}
              aria-label={t("quiz.textAnswerLabel")}
              onKeyDown={(event) => {
                // A plain Enter adds a new line so children can finish a full
                // explanation. Ctrl/Cmd + Enter is the optional quick-submit.
                if (
                  event.key === "Enter" &&
                  (event.ctrlKey || event.metaKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              {t("quiz.textAnswerHint")}
            </p>
            {!result && !answeredMap[problem.id]?.answer && (
              <Button
                type="submit"
                size="sm"
                disabled={submitting || !textAnswer.trim()}
              >
                {submitting ? `${t("quiz.coding.submitting")}...` : t("quiz.submitAnswer")}
              </Button>
            )}
          </form>
        )}

        {submitError && (
          <p role="alert" className="text-xs text-destructive mt-2">{submitError}</p>
        )}

        {result || answeredMap[problem.id]?.answer ? (
          <div className="space-y-3">
            {result ? (
              <QuizResult
                result={result}
                userAnswerDisplay={result.user_answer ?? undefined}
                questionType={problem.question_type}
              />
            ) : (
              (() => {
                const fb = answeredMap[problem.id];
                // Prefer submission feedback cached inside answeredMap at submit time.
                // This is the whole point of AnsweredFeedback shape: even if
                // `problem.correct_answer`/`problem.explanation` are still NULL
                // (pre-submit anti-spoiler ProblemResponse cache), the user can
                // still see the full 4-row result without a page reload.
                const cachedCorrect = fb?.correct_answer;
                const cachedExplanation = fb?.explanation;
                const effectiveCorrect =
                  cachedCorrect != null && String(cachedCorrect).trim() !== ""
                    ? cachedCorrect
                    : (problem.correct_answer ?? null);
                const effectiveExplanation =
                  cachedExplanation != null && String(cachedExplanation).trim() !== ""
                    ? cachedExplanation
                    : (problem.explanation ?? null);
                return (
                  <QuizResult
                    result={{
                      is_correct: fb?.is_correct ?? true,
                      correct_answer: effectiveCorrect,
                      user_answer: fb?.answer ?? null,
                      explanation: effectiveExplanation,
                    }}
                    userAnswerDisplay={fb?.answer}
                    questionType={problem.question_type}
                    answeredOnly
                  />
                );
              })()
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleRetryCurrent()}
              >
                重新答题
              </Button>
            </div>
          </div>
        ) : null}
        {/* 全部答完：答题概览 + 学习建议 */}
        {isQuizComplete ? (
          <div className="mt-6 rounded-2xl border border-border/80 bg-card p-4 space-y-3" data-testid="quiz-overview">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">答题情况概览</h3>
              <Badge variant="outline">{Math.round((score.correct / Math.max(1, score.total)) * 100)}% 正确率</Badge>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-border/60 bg-muted/30 py-2">
                <div className="text-xs text-muted-foreground">总题数</div>
                <div className="text-base font-semibold">{problems.length}</div>
              </div>
              <div className="rounded-lg border border-success/30 bg-success/10 py-2">
                <div className="text-xs text-success/90">答对</div>
                <div className="text-base font-semibold text-success">{score.correct}</div>
              </div>
              <Link
                href={`/course/${courseId}/wrong-answers`}
                className="rounded-lg border border-destructive/30 bg-destructive/10 py-2 transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="查看错题集"
              >
                <div className="text-xs text-destructive/90">答错</div>
                <div className="text-base font-semibold text-destructive">{Math.max(0, score.total - score.correct)}</div>
              </Link>
            </div>
            <div className="space-y-1.5 rounded-lg border border-border/60 bg-muted/20 p-3">
              <p className="text-xs font-semibold text-foreground/90">学习建议</p>
              <ul className="list-disc pl-4 space-y-1 text-xs text-muted-foreground leading-relaxed">
                {(() => {
                  const rate = score.total ? score.correct / score.total : 0;
                  const tips: React.ReactNode[] = [];
                  if (rate >= 0.8) {
                    tips.push(<li key="1">掌握良好（正确率 {'>='} 80%），可以继续推进下一章节或提高测验难度挑战自己。</li>);
                    tips.push(<li key="2">错题（如果有）建议 3 天后再复习一次，用间隔重复巩固长期记忆。</li>);
                    tips.push(<li key="3">尝试用自己的话讲解每道题的核心概念，确保真正理解而非凭印象答题。</li>);
                  } else if (rate >= 0.5) {
                    tips.push(<li key="1">掌握中等（正确率 50% {"–"} 80%），先用“重新答题”按钮重做错题，再继续新内容。</li>);
                    tips.push(<li key="2">回到课程原文，重点标注答错题目涉及的概念与推理步骤，尤其关注难度 2 / 3 的题。</li>);
                    tips.push(<li key="3">切换到闪卡标签，对核心概念做一次间隔重复记忆，降低下次犯错概率。</li>);
                  } else {
                    tips.push(<li key="1">基础需加强（正确率 {'<'} 50%），建议暂停测验，回到课程原文段落精读。</li>);
                    tips.push(<li key="2">先使用闪卡标签把基础概念全部答对后再来做题。</li>);
                    tips.push(<li key="3">每道错题认真阅读上方的“正确答案 / 解析说明”，并用自己的话重写解题步骤后再提交。</li>);
                  }
                  tips.push(
                    <li key="4">如果连续答错 3 题以上，系统会自动出现“错题本”区块，可以针对薄弱点专项练习。</li>,
                  );
                  return tips;
                })()}
              </ul>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="default"
                onClick={() => {
                  resetQuizState();
                  toast.success("已重置全部答题记录");
                }}
              >
                重新做一遍全部题目
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!aiActionsEnabled || generatingReinforcement}
                onClick={() => void handleGenerateReinforcement()}
              >
                {generatingReinforcement ? "正在生成强化题…" : "生成错题强化练习"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!aiActionsEnabled || generatingFresh}
                onClick={() => void handleGenerateFresh()}
              >
                {generatingFresh ? "正在准备新题…" : "换一组不重复的新题"}
              </Button>
              {exitHref ? (
                <Button asChild type="button" size="sm" variant="ghost">
                  <Link href={exitHref}>退出测验</Link>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

      </div>

      <div className="flex items-center justify-between px-3 py-2 border-t border-border/60 shrink-0">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={currentIdx === 0}
          onClick={() => setCurrentIdx((i) => i - 1)}
        >
          {t("quiz.prev")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={currentIdx >= problems.length - 1}
          onClick={() => setCurrentIdx((i) => i + 1)}
        >
          {t("quiz.next")}
        </Button>
      </div>
    </div>
  );
}
