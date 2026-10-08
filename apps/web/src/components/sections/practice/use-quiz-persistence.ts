/**
 * useQuizPersistence — localStorage-based quiz session persistence.
 *
 * Saves quiz progress (current index, score, answered questions) so users
 * can resume after browser close or page refresh. Auto-expires after 24h.
 */

import { useCallback, useId } from "react";

const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface QuizSessionState {
  currentIdx: number;
  problemIds?: string[];
  /** Optional for backwards compatibility with persisted pre-batch sessions. */
  batchId?: string | null;
  score: { correct: number; total: number };
  answeredMap: Record<string, string | {
    answer: string;
    is_correct?: boolean | null;
    correct_answer?: string | null;
    explanation?: string | null;
  }>;
  consecutiveWrong: number;
  savedAt: number;
}

function storageKey(courseId: string, scopeId?: string | null): string {
  return `opentutor_quiz_${courseId}_${scopeId || "course"}`;
}

export function useQuizPersistence(courseId: string, scopeId?: string | null) {
  const reactId = useId();
  const instanceId = `quiz-${reactId}`;
  const save = useCallback(
    (state: Omit<QuizSessionState, "savedAt">) => {
      try {
        const data: QuizSessionState = { ...state, savedAt: Date.now() };
        localStorage.setItem(storageKey(courseId, scopeId), JSON.stringify(data));
        window.dispatchEvent(new CustomEvent("opentutor:quiz-session", {
          detail: { courseId, sourceId: instanceId, state: data },
        }));
      } catch {
        // Quota exceeded or SSR — best effort
      }
    },
    [courseId, scopeId, instanceId],
  );

  const load = useCallback((): QuizSessionState | null => {
    try {
      const raw = localStorage.getItem(storageKey(courseId, scopeId));
      if (!raw) return null;
      const data: QuizSessionState = JSON.parse(raw);
      if (Date.now() - data.savedAt > EXPIRY_MS) {
        localStorage.removeItem(storageKey(courseId, scopeId));
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }, [courseId, scopeId]);

  const clear = useCallback(() => {
    try {
      localStorage.removeItem(storageKey(courseId, scopeId));
      window.dispatchEvent(new CustomEvent("opentutor:quiz-session", {
        detail: { courseId, sourceId: instanceId, state: null },
      }));
    } catch {
      // best effort
    }
  }, [courseId, scopeId, instanceId]);

  const subscribe = useCallback((listener: (state: QuizSessionState | null) => void) => {
    const onSession = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        courseId?: string;
        sourceId?: string;
        state?: QuizSessionState | null;
      };
      if (detail.courseId !== courseId || detail.sourceId === instanceId) return;
      listener(detail.state ?? null);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey(courseId, scopeId)) return;
      try {
        listener(event.newValue ? JSON.parse(event.newValue) as QuizSessionState : null);
      } catch {
        listener(null);
      }
    };
    window.addEventListener("opentutor:quiz-session", onSession);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("opentutor:quiz-session", onSession);
      window.removeEventListener("storage", onStorage);
    };
  }, [courseId, scopeId, instanceId]);

  return { save, load, clear, subscribe };
}

/** Flashcard-specific persistence (simpler shape). */
export interface FlashcardSessionState {
  index: number;
  reviewedCount: number;
  cards?: unknown[];
  savedAt: number;
}

function flashcardKey(courseId: string, scopeId?: string | null): string {
  return `opentutor_flashcard_${courseId}_${scopeId || "course"}`;
}

function flashcardScope(scopeId?: string | null): string {
  return scopeId || "course";
}

export function useFlashcardPersistence(courseId: string, scopeId?: string | null) {
  const reactId = useId();
  const instanceId = `flashcards-${reactId}`;
  const save = useCallback(
    (state: Omit<FlashcardSessionState, "savedAt">) => {
      try {
        const data: FlashcardSessionState = { ...state, savedAt: Date.now() };
        localStorage.setItem(flashcardKey(courseId, scopeId), JSON.stringify(data));
        window.dispatchEvent(new CustomEvent("opentutor:flashcard-session", {
          detail: { courseId, scopeId: flashcardScope(scopeId), sourceId: instanceId, state: data },
        }));
      } catch {
        // best effort
      }
    },
    [courseId, scopeId, instanceId],
  );

  const load = useCallback((): FlashcardSessionState | null => {
    try {
      const raw = localStorage.getItem(flashcardKey(courseId, scopeId));
      if (!raw) return null;
      const data: FlashcardSessionState = JSON.parse(raw);
      if (Date.now() - data.savedAt > EXPIRY_MS) {
        localStorage.removeItem(flashcardKey(courseId, scopeId));
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }, [courseId, scopeId]);

  const clear = useCallback(() => {
    try {
      localStorage.removeItem(flashcardKey(courseId, scopeId));
      window.dispatchEvent(new CustomEvent("opentutor:flashcard-session", {
        detail: { courseId, scopeId: flashcardScope(scopeId), sourceId: instanceId, state: null },
      }));
    } catch {
      // best effort
    }
  }, [courseId, scopeId, instanceId]);

  const subscribe = useCallback((listener: (state: FlashcardSessionState | null) => void) => {
    const onSession = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        courseId?: string;
        scopeId?: string;
        sourceId?: string;
        state?: FlashcardSessionState | null;
      };
      if (
        detail.courseId !== courseId ||
        detail.scopeId !== flashcardScope(scopeId) ||
        detail.sourceId === instanceId
      ) return;
      listener(detail.state ?? null);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== flashcardKey(courseId, scopeId)) return;
      try {
        listener(event.newValue ? JSON.parse(event.newValue) as FlashcardSessionState : null);
      } catch {
        listener(null);
      }
    };
    window.addEventListener("opentutor:flashcard-session", onSession);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("opentutor:flashcard-session", onSession);
      window.removeEventListener("storage", onStorage);
    };
  }, [courseId, scopeId, instanceId]);

  return { save, load, clear, subscribe };
}
