"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useT } from "@/lib/i18n-context";
import { getDueFlashcards, type Flashcard } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SkeletonText } from "@/components/ui/skeleton";

interface FlashcardReviewViewProps {
  courseId: string;
}

function practiceHistoryLabel(count: number, t: (key: string) => string): string {
  if (count <= 0) return t("flashcard.review.firstTime");
  if (count === 1) return t("flashcard.review.once");
  if (count <= 3) return t("flashcard.review.gettingFamiliar").replace("{count}", String(count));
  return t("flashcard.review.veryFamiliar").replace("{count}", String(count));
}

export function FlashcardReviewView({ courseId }: FlashcardReviewViewProps) {
  const t = useT();
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [dueCount, setDueCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const result = await getDueFlashcards(courseId);
      setCards(result.cards);
      setDueCount(result.due_count);
    } catch {
      setCards([]);
      setDueCount(0);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex-1 p-5" role="status" aria-live="polite">
        <SkeletonText lines={4} />
      </div>
    );
  }

  return (
    <div className="min-h-0 w-full min-w-0 max-w-full flex-1 space-y-4 overflow-x-hidden overflow-y-auto p-3 scrollbar-thin sm:p-4" data-testid="flashcard-review-panel">
      <div className="w-full min-w-0 space-y-2 rounded-2xl border border-violet-100 bg-gradient-to-br from-violet-50/80 via-card to-sky-50/50 p-4 shadow-sm dark:border-violet-900/70 dark:from-violet-950/25 dark:to-sky-950/20">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <RotateCcw className="size-4 text-primary" aria-hidden />
            <h3 className="text-sm font-semibold">{t("flashcard.review.title")}</h3>
          </div>
          <Badge variant="outline">
            {t("flashcard.review.dueCount").replace("{count}", String(dueCount))}
          </Badge>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("flashcard.review.countExplanation")}
        </p>
      </div>

      {failed ? (
        <div className="rounded-xl border border-destructive/30 p-4 text-center space-y-3">
          <p className="text-sm text-destructive">{t("flashcard.review.loadFailed")}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
            {t("common.retry")}
          </Button>
        </div>
      ) : cards.length === 0 ? (
        <div className="rounded-xl border border-border/60 bg-muted/20 p-6 text-center">
          <p className="text-sm font-medium">{t("flashcard.review.empty")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("flashcard.review.emptyHint")}</p>
        </div>
      ) : (
        <div className="w-full min-w-0 space-y-3">
          {cards.map((card, index) => (
            <article key={card.id || index} className="w-full min-w-0 max-w-full overflow-hidden rounded-2xl border border-border/60 bg-card p-4 shadow-sm transition-shadow hover:shadow-md">
              <div className="flex items-center justify-between gap-2">
                <Badge variant="secondary" className="shrink-0 rounded-full bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-200">{t("flashcard.review.cardNumber").replace("{number}", String(index + 1))}</Badge>
                <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
                  {practiceHistoryLabel(card.fsrs?.reps ?? 0, t)}
                </span>
              </div>
              <div className="mt-3 min-w-0 rounded-xl bg-muted/35 px-3 py-3">
                <p className="text-xs font-medium text-violet-700 dark:text-violet-300">{t("flashcard.review.front")}</p>
                <p className="mt-1 min-w-0 whitespace-pre-wrap break-words text-sm font-medium leading-6 [overflow-wrap:anywhere]">{card.front}</p>
              </div>
              <div className="mt-2 min-w-0 border-l-2 border-emerald-300 px-3 py-2 dark:border-emerald-700">
                <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">{t("flashcard.review.back")}</p>
                <p className="mt-1 min-w-0 whitespace-pre-wrap break-words text-sm leading-6 text-foreground/80 [overflow-wrap:anywhere]">{card.back}</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
