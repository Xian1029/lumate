"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useT } from "@/lib/i18n-context";
import {
  generateFlashcards,
  getDueFlashcards,
  getLectorOrderedFlashcards,
  listGeneratedFlashcardBatches,
  reviewFlashcard,
  saveGeneratedFlashcards,
  type Flashcard,
  type LectorFlashcard,
} from "@/lib/api";
import { useBatchManager } from "@/hooks/use-batch-manager";
import { useWorkspaceStore } from "@/store/workspace";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, BookmarkPlus } from "lucide-react";
import { AiFeatureBlocked } from "@/components/shared/ai-feature-blocked";
import { SkeletonCard } from "@/components/ui/skeleton";
import { FlashcardCard } from "./flashcard-card";
import { useFlashcardPersistence } from "./use-quiz-persistence";
import { toast } from "sonner";

function translateLectorReason(reason: string): string {
  if (!reason) return reason;
  const map: Record<string, string> = {
    "low mastery": "掌握度低",
    "not yet practiced": "尚未练习",
    "memory decaying": "记忆衰减中",
    "high semantic interference": "易混淆概念",
    "FSRS overdue": "复习逾期",
    "scheduled review": "计划复习",
  };
  return reason
    .split(", ")
    .map((part) => {
      const prereq = part.match(/^prerequisite '(.+)' is weak$/);
      if (prereq) return `前置知识点「${prereq[1]}」薄弱`;
      return map[part] ?? part;
    })
    .join("、");
}

interface FlashcardViewProps {
  courseId: string;
  aiActionsEnabled?: boolean;
  exitHref?: string;
}

function flashcardFrontKey(front: string): string {
  return front.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function uniqueFlashcards(cards: (Flashcard | LectorFlashcard)[]): (Flashcard | LectorFlashcard)[] {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const key = flashcardFrontKey(`${card.front ?? ""}`);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isUsableFlashcard(card: Flashcard | LectorFlashcard, locale: string): boolean {
  const data = card as Flashcard & { question?: string; answer?: string };
  const text = `${data.front ?? data.question ?? ""} ${data.back ?? data.answer ?? ""}`;
  if (locale !== "zh") return true;

  // A couple of Chinese characters in parentheses do not make an English card
  // suitable for a Chinese learner (for example, "Rational numbers（有理数）").
  // Require Chinese to be the card's primary written language while allowing
  // short formulas, proper nouns, and programming identifiers.
  const hanCount = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinCount = (text.match(/[A-Za-z]/g) ?? []).length;
  return hanCount >= 4 && hanCount >= latinCount * 0.35;
}

export function FlashcardView({
  courseId,
  aiActionsEnabled = true,
  exitHref,
}: FlashcardViewProps) {
  const t = useT();
  const { locale } = useLocale();
  const loadFailedLabel = t("flashcard.loadFailed");
  const reviewFailedLabel = t("flashcard.reviewFailed");
  const refreshKey = useWorkspaceStore((s) => s.sectionRefreshKey["practice"]);
  const selectedNodeId = useWorkspaceStore((s) => s.selectedNodeId);
  const { saving, latestBatch, wrapSave } = useBatchManager({
    courseId,
    refreshSection: "practice",
    listFn: listGeneratedFlashcardBatches,
  });
  const [cards, setCards] = useState<(Flashcard | LectorFlashcard)[]>([]);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [dueCount, setDueCount] = useState(0);
  const [useLector, setUseLector] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const restoredRef = useRef(false);
  const ratingLockRef = useRef(false);
  const { save, load, subscribe } = useFlashcardPersistence(courseId, selectedNodeId);

  useEffect(() => {
    restoredRef.current = false;
    setCards([]);
    setIndex(0);
    setReviewed(0);
    setFlipped(false);
  }, [selectedNodeId]);

  useEffect(() => {
    let cancelled = false;

    if (!selectedNodeId) {
      setCards([]);
      setDueCount(0);
      setLoadError(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      // Helper to apply loaded cards + session restore in one place
      const applyCards = (cards: (Flashcard | LectorFlashcard)[], dueCount: number, isLector: boolean) => {
        if (cancelled) return;
        let usableCards = uniqueFlashcards(cards.filter((card) =>
          isUsableFlashcard(card, locale) &&
          (!selectedNodeId || card.content_node_id === selectedNodeId),
        ));
        setDueCount(dueCount);
        setUseLector(isLector);
        // Restore session from localStorage (only once per mount)
        if (!restoredRef.current) {
          restoredRef.current = true;
          const saved = load();
          if (saved?.cards?.length) {
            usableCards = uniqueFlashcards(
              (saved.cards as (Flashcard | LectorFlashcard)[]).filter((card) => isUsableFlashcard(card, locale)),
            );
          }
          setCards(usableCards);
          if (saved && saved.index < usableCards.length) {
            setIndex(saved.index);
            setReviewed(saved.reviewedCount);
          } else {
            setIndex(0);
            setReviewed(0);
          }
        } else setCards(usableCards);
        setFlipped(false);
      };

      try {
        // Try LECTOR-ordered cards first for semantically-aware review
        const lector = await getLectorOrderedFlashcards(courseId);
        if (cancelled) return;
        if (lector.cards.length > 0) {
          applyCards(lector.cards, lector.count, true);
        } else {
          // Fall back to regular FSRS due cards
          const due = await getDueFlashcards(courseId);
          applyCards(due.cards, due.due_count, false);
        }
      } catch {
        // Fall back to regular due cards on any error
        try {
          const due = await getDueFlashcards(courseId);
          applyCards(due.cards, due.due_count, false);
        } catch {
          if (!cancelled) {
            setCards([]);
            setDueCount(0);
            setLoadError(loadFailedLabel);
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [courseId, refreshKey, retryCount, loadFailedLabel, locale, selectedNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => subscribe((saved) => {
    if (!saved) return;
    if (saved.cards?.length) {
      setCards(uniqueFlashcards(saved.cards as (Flashcard | LectorFlashcard)[]));
    }
    setIndex(saved.index);
    setReviewed(saved.reviewedCount);
    setFlipped(false);
  }), [subscribe]);

  const handleGenerate = useCallback(async () => {
    setLoading(true);
    try {
      const mode = useWorkspaceStore.getState().spaceLayout.mode ?? undefined;
      const selectedNodeId = useWorkspaceStore.getState().selectedNodeId ?? undefined;
      const data = await generateFlashcards(courseId, 5, mode, undefined, selectedNodeId);
      const usableCards = uniqueFlashcards(data.cards.filter((card) => isUsableFlashcard(card, locale)));
      if (usableCards.length === 0) {
        throw new Error(t("flashcard.generateNoUsableCards"));
      }
      setCards(usableCards);
      setIndex(0);
      setFlipped(false);
      setReviewed(0);
      save({ index: 0, reviewedCount: 0, cards: usableCards });
      toast.success(t("flashcard.generateSuccess").replace("{count}", String(usableCards.length)));
    } catch (error) {
      toast.error((error as Error).message || t("flashcard.generateFailed"));
    } finally {
      setLoading(false);
    }
  }, [courseId, t, locale, save]);

  const handleSave = useCallback(
    async (replaceBatchId?: string) => {
      if (cards.length === 0) return;
      await wrapSave(() =>
        saveGeneratedFlashcards(courseId, cards, t("ui.flashcard_set"), replaceBatchId),
      );
    },
    [cards, courseId, t, wrapSave],
  );

  const handleReplaceLatest = useCallback(async () => {
    if (!latestBatch || saving || submitting) return;
    setLoading(true);
    try {
      const mode = useWorkspaceStore.getState().spaceLayout.mode ?? undefined;
      const selectedNodeId = useWorkspaceStore.getState().selectedNodeId ?? undefined;
      const generated = await generateFlashcards(
        courseId,
        Math.max(cards.length, 5),
        mode,
        cards.map((card) => card.front),
        selectedNodeId,
      );
      const unique = generated.cards.filter((card, cardIndex, all) =>
        isUsableFlashcard(card, locale) &&
        !cards.some((old) => old.front.trim() === card.front.trim()) &&
        all.findIndex((candidate) => candidate.front.trim() === card.front.trim()) === cardIndex,
      );
      if (unique.length === 0) throw new Error(t("flashcard.replaceNoNewCards"));

      await wrapSave(async () => {
        const saved = await saveGeneratedFlashcards(
          courseId,
          unique,
          t("ui.flashcard_set"),
          latestBatch.batch_id,
        );
        setCards(unique);
        setIndex(0);
        setFlipped(false);
        setReviewed(0);
        save({ index: 0, reviewedCount: 0, cards: unique });
        return saved;
      });
    } catch (error) {
      toast.error((error as Error).message || t("flashcard.generateFailed"));
    } finally {
      setLoading(false);
    }
  }, [cards, courseId, latestBatch, locale, save, saving, submitting, t, wrapSave]);

  const restartCurrentCards = useCallback(() => {
    setIndex(0);
    setReviewed(0);
    setFlipped(false);
    save({ index: 0, reviewedCount: 0, cards });
    toast.success("已从第一张重新开始");
  }, [cards, save]);

  const handleGenerateReinforcement = useCallback(async () => {
    if (loading || submitting) return;
    setLoading(true);
    try {
      const mode = useWorkspaceStore.getState().spaceLayout.mode ?? undefined;
      const selectedNodeId = useWorkspaceStore.getState().selectedNodeId ?? undefined;
      const generated = await generateFlashcards(
        courseId,
        Math.max(cards.length, 5),
        mode,
        cards.map((card) => card.front),
        selectedNodeId,
      );
      const oldFronts = new Set(cards.map((card) => flashcardFrontKey(card.front)));
      const fresh = uniqueFlashcards(generated.cards.filter((card) => {
        const key = flashcardFrontKey(card.front);
        return isUsableFlashcard(card, locale) && !oldFronts.has(key);
      }));
      if (!fresh.length) throw new Error("暂时没有生成出不重复的强化闪卡，请稍后再试");
      setCards(fresh);
      setIndex(0);
      setReviewed(0);
      setFlipped(false);
      save({ index: 0, reviewedCount: 0, cards: fresh });
      toast.success(`已准备 ${fresh.length} 张新的强化闪卡`);
    } catch (error) {
      toast.error((error as Error).message || "生成强化闪卡失败");
    } finally {
      setLoading(false);
    }
  }, [cards, courseId, loading, locale, save, submitting]);

  const handleFlip = useCallback(() => {
    if (!submitting) setFlipped((value) => !value);
  }, [submitting]);

  const handleRate = useCallback(
    async (value: number) => {
      const card = cards[index];
      if (!card || submitting || ratingLockRef.current) return;
      ratingLockRef.current = true;
      setSubmitting(true);
      try {
        await reviewFlashcard(card, value);
        useWorkspaceStore.getState().triggerRefresh("analytics");
      } catch {
        setReviewError(reviewFailedLabel);
        setTimeout(() => setReviewError(null), 3000);
      }
      setSubmitting(false);
      setFlipped(false);
      const newReviewed = reviewed + 1;
      const newIndex = index + 1;
      setReviewed(newReviewed);
      setIndex(newIndex);
      save({ index: newIndex, reviewedCount: newReviewed, cards });
      ratingLockRef.current = false;
    },
    [cards, index, reviewed, submitting, reviewFailedLabel, save],
  );

  // Keyboard shortcuts: 1-4 for ratings, arrow keys for quick rate when card is flipped
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (flipped && !submitting) {
        const key = parseInt(e.key, 10);
        if (key >= 1 && key <= 4) {
          e.preventDefault();
          void handleRate(key);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          void handleRate(1); // Again
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          void handleRate(3); // Good
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [flipped, submitting, handleRate]);

  if (!selectedNodeId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <h3 className="mb-1 text-sm font-medium">{t("flashcard.chooseChapterTitle")}</h3>
        <p className="max-w-xs text-xs text-muted-foreground">{t("flashcard.chooseChapterHint")}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8" role="status" aria-live="polite">
        <SkeletonCard className="w-full max-w-md" />
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        {dueCount > 0 ? (
          <Badge variant="destructive" className="mb-3">
            {t("flashcard.cardsDueToday").replace("{count}", String(dueCount))}
          </Badge>
        ) : null}
        <h3 className="text-sm font-medium mb-1">{t("flashcard.title")}</h3>
        {loadError ? (
          <div role="alert" className="text-center space-y-2">
            <p className="text-sm text-destructive">{loadError}</p>
            <button type="button" onClick={() => { setLoadError(null); setLoading(true); setRetryCount((c) => c + 1); }}
              className="text-xs text-brand hover:underline">
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground max-w-xs">
              {t("flashcard.empty")}
            </p>
            {!aiActionsEnabled ? <AiFeatureBlocked compact className="mt-3 w-full max-w-sm text-left" /> : null}
            <Button className="mt-3" size="sm" onClick={() => void handleGenerate()} disabled={!aiActionsEnabled}>
              {t("flashcard.generate")}
            </Button>
          </>
        )}
      </div>
    );
  }

  if (index >= cards.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-3">
        <h3 className="text-base font-semibold">这一组闪卡看完啦 🎉</h3>
        <p className="text-xs text-muted-foreground">
          {t("flashcard.allDone").replace("{reviewed}", String(reviewed)).replace("{total}", String(cards.length))}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" size="sm" onClick={restartCurrentCards}>重新看一遍</Button>
          <Button type="button" size="sm" variant="outline" disabled={!aiActionsEnabled} onClick={() => void handleGenerateReinforcement()}>
            生成新的强化闪卡
          </Button>
          {exitHref ? (
            <Button asChild type="button" size="sm" variant="ghost">
              <Link href={exitHref}>退出闪卡</Link>
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const card = cards[index];

  return (
    <div role="region" aria-label={t("flashcard.title")} className="flex min-h-0 flex-1 flex-col items-center justify-start gap-5 overflow-y-auto p-3 sm:p-6">
      {exitHref ? (
        <div className="w-full max-w-lg">
          <Link href={exitHref} className="inline-flex rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
            ← 返回课程
          </Link>
        </div>
      ) : null}
      {/* Top toolbar: progress + lector reason on the left, action buttons on the right */}
      <div className="flex w-full max-w-lg flex-col gap-3 rounded-2xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-3 shadow-sm">
        <div className="space-y-2 border-b border-border/50 pb-2.5">
          <div className="flex items-center justify-between gap-3 text-xs">
            <div>
              <p className="font-semibold text-foreground">{t("flashcard.sessionProgress")}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t("flashcard.sessionPosition").replace("{current}", String(index + 1)).replace("{total}", String(cards.length))}
              </p>
            </div>
            <Badge variant="outline" className="shrink-0 font-normal text-[11px] tabular-nums">
              {t("flashcard.sessionCompleted").replace("{count}", String(reviewed))}
            </Badge>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted" aria-label={t("flashcard.sessionAria").replace("{reviewed}", String(reviewed)).replace("{total}", String(cards.length))}>
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-400 to-emerald-400 transition-[width] duration-300"
              style={{ width: `${Math.min(100, (reviewed / Math.max(1, cards.length)) * 100)}%` }}
            />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {useLector && (card as LectorFlashcard).lector_reason && (card as LectorFlashcard).lector_reason !== "due" ? (
            <Badge variant="secondary" className="h-auto min-w-0 whitespace-normal py-1 font-normal text-[11px] leading-4 text-muted-foreground">
              {translateLectorReason((card as LectorFlashcard).lector_reason!)}
            </Badge>
          ) : null}
          </div>
        </div>
        <div className="grid w-full shrink-0 grid-cols-2 gap-2">
          {latestBatch ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleReplaceLatest()}
              disabled={saving || submitting}
              className="h-9 min-w-0 gap-1.5 rounded-xl px-3 text-xs transition-colors hover:bg-accent"
              aria-label={t("flashcard.replaceLatest")}
              title={t("flashcard.replaceLatestHint")}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              {t("flashcard.replaceLatest")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="default"
            onClick={() => void handleSave()}
            disabled={saving || submitting}
            className={`${latestBatch ? "" : "col-span-2"} h-9 min-w-0 gap-1.5 rounded-xl px-3 text-xs shadow-sm transition-colors`}
            aria-label={t("flashcard.saveNew")}
            title={t("flashcard.saveNewHint")}
          >
            <BookmarkPlus className="h-3.5 w-3.5" aria-hidden />
            {t("flashcard.saveNew")}
          </Button>
        </div>
      </div>

      <FlashcardCard
        card={card}
        flipped={flipped}
        submitting={submitting}
        reviewError={reviewError}
        onFlip={handleFlip}
        onRate={handleRate}
        t={t}
      />
    </div>
  );
}
