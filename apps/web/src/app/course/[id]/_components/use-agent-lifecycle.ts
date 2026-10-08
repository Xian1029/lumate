"use client";

import { useEffect } from "react";
import { useWorkspaceStore } from "@/store/workspace";
import { useChatStore } from "@/store/chat";
import type { LearningMode } from "@/lib/block-system/types";
import { updateUnlockContext } from "@/lib/block-system/feature-unlock";
import { useT, useTF } from "@/lib/i18n-context";
import {
  buildGoalDeadlineSnapshots,
  evaluateModeSuggestion,
} from "@/app/_components/mode-recommendations";


const MODE_EVAL_TTL_MS = 10 * 60 * 1000;
const MODE_EVAL_RETRY_MS = 5_000;

interface ModeEvalLatchState {
  successAt?: number;
  retryAt?: number;
  fingerprint?: string;
}

interface ModeEvalGoalSnapshot {
  id: string;
  title: string;
  status: string;
  target_date: string | null;
  next_action: string | null;
}

function readModeEvalLatch(key: string): ModeEvalLatchState {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ModeEvalLatchState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeModeEvalLatch(key: string, value: ModeEvalLatchState): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // no-op
  }
}

function buildModeEvalFingerprint(
  currentMode: LearningMode,
  goals: ModeEvalGoalSnapshot[],
): string {
  const goalsPart = goals
    .map((goal) => `${goal.id}:${goal.status}:${goal.target_date ?? ""}:${goal.next_action ?? ""}`)
    .sort()
    .join("|");
  return `${currentMode}::${goalsPart}`;
}

export function useModeEvaluator(
  courseId: string,
  course: unknown | null,
  aiActionsEnabled: boolean,
  queueModeSuggestion: (payload: {
    suggestedMode: LearningMode;
    reason: string;
    approvalCta: string;
    cooldownKey: string;
    signals?: string[];
  }) => boolean,
) {
  const t = useT();
  const tf = useTF();

  useEffect(() => {
    if (!course || !aiActionsEnabled) return;
    const evalKey = `agent_mode_eval_${courseId}`;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const runEvaluation = async (isRetry = false) => {
      const now = Date.now();
      const latch = readModeEvalLatch(evalKey);
      if (latch.retryAt && now < latch.retryAt) return;

      try {
        const currentMode = useWorkspaceStore.getState().spaceLayout.mode as LearningMode | undefined;
        if (!currentMode) return;

        const { listStudyGoals } = await import("@/lib/api");
        const goals = await listStudyGoals(courseId, "active");
        if (cancelled) return;

        const fingerprint = buildModeEvalFingerprint(
          currentMode,
          goals as unknown as ModeEvalGoalSnapshot[],
        );
        const latestLatch = readModeEvalLatch(evalKey);
        const shouldSkip =
          latestLatch.successAt != null
          && now - latestLatch.successAt < MODE_EVAL_TTL_MS
          && latestLatch.fingerprint === fingerprint;
        if (shouldSkip) return;

        const deadlines = buildGoalDeadlineSnapshots(
          goals as unknown as ModeEvalGoalSnapshot[],
          now,
        );

        if (deadlines.length > 0) {
          updateUnlockContext(courseId, { hasDeadline: true });
        }

        const suggestion = evaluateModeSuggestion({
          currentMode,
          deadlines,
          t,
          tf,
        });
        if (suggestion) {
          queueModeSuggestion({
            suggestedMode: suggestion.suggestedMode,
            reason: suggestion.reason,
            approvalCta: suggestion.approvalCta,
            cooldownKey: suggestion.recommendationKey,
            signals: suggestion.signals,
          });
          writeModeEvalLatch(evalKey, { successAt: Date.now(), fingerprint });
          return;
        }

        writeModeEvalLatch(evalKey, { successAt: Date.now(), fingerprint });
      } catch (e) {
        console.error("[Course] mode evaluator failed:", e);
        writeModeEvalLatch(evalKey, { retryAt: Date.now() + MODE_EVAL_RETRY_MS });
        if (!cancelled && !isRetry) {
          retryTimer = setTimeout(() => {
            void runEvaluation(true);
          }, MODE_EVAL_RETRY_MS);
        }
      }
    };

    void runEvaluation();
    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [course, courseId, aiActionsEnabled, t, tf, queueModeSuggestion]);
}

export function useInitPrompt(courseId: string, setChatOpen: (v: boolean) => void) {
  useEffect(() => {
    const promptKey = `course_init_prompt_${courseId}`;
    const consumedKey = `course_init_prompt_consumed_${courseId}`;
    const initPrompt = localStorage.getItem(promptKey);
    const alreadyConsumed = sessionStorage.getItem(consumedKey) === "true";
    if (initPrompt && !alreadyConsumed) {
      sessionStorage.setItem(consumedKey, "true");
      localStorage.removeItem(promptKey);
      setChatOpen(true);
      const timer = setTimeout(() => {
        void useChatStore.getState().sendMessage(courseId, initPrompt);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [courseId, setChatOpen]);
}
