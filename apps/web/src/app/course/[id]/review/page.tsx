"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, BookOpen, Brain, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Link2, LoaderCircle, Target } from "lucide-react";
import {
  getAiNoteForNode,
  getReviewSession,
  submitReviewRating,
  type AiNoteForNode,
  type ReviewItem,
  type ReviewSession,
} from "@/lib/api";
import { trackApiFailure } from "@/lib/error-telemetry";
import { useT, useTF } from "@/lib/i18n-context";
import { useWorkspaceStore } from "@/store/workspace";
import { syncCourseSpaceLayout } from "@/lib/block-system/layout-sync";
import { markReviewSessionCompleted } from "@/lib/review-session-state";
import { MarkdownRenderer } from "@/components/shared/markdown-renderer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Rating = "again" | "hard" | "good" | "easy";

const REASON_KEYS: Record<string, string> = {
  "low mastery": "review.reason.lowMastery",
  "not yet practiced": "review.reason.notPracticed",
  "memory decaying": "review.reason.memoryDecaying",
  "high semantic interference": "review.reason.interference",
  "FSRS overdue": "review.reason.overdue",
  "scheduled review": "review.reason.scheduled",
};

function reviewReason(reason: string | undefined, t: (key: string) => string) {
  if (!reason) return t("review.reason.scheduled");
  const matched = Object.entries(REASON_KEYS)
    .filter(([token]) => reason.includes(token))
    .map(([, key]) => t(key));
  if (reason.includes("prerequisite")) matched.push(t("review.reason.prerequisite"));
  return [...new Set(matched)].join("、") || t("review.reason.scheduled");
}

export default function ReviewPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT();
  const tf = useTF();
  const courseId = params.id as string;

  const [sessionByCourse, setSessionByCourse] = useState<Record<string, ReviewSession>>({});
  const [errorByCourse, setErrorByCourse] = useState<Record<string, string>>({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [ratings, setRatings] = useState<Map<string, Rating>>(() => {
    // Restore ratings from sessionStorage for resume support
    if (typeof window === "undefined") return new Map();
    try {
      const saved = sessionStorage.getItem(`review-ratings-${courseId}`);
      return saved ? new Map(JSON.parse(saved) as [string, Rating][]) : new Map();
    } catch { return new Map(); }
  });
  const [submitting, setSubmitting] = useState(false);
  const [ratingError, setRatingError] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [relatedNote, setRelatedNote] = useState<AiNoteForNode | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  const session = sessionByCourse[courseId] ?? null;
  const error = errorByCourse[courseId] ?? null;
  const loading = !session && !error;

  useEffect(() => {
    if (sessionByCourse[courseId] || errorByCourse[courseId]) return;
    let cancelled = false;
    getReviewSession(courseId, 20)
      .then((data) => {
        if (cancelled) return;
        setSessionByCourse((prev) => ({ ...prev, [courseId]: data }));
        if (ratings.size > 0) {
          let startIdx = 0;
          while (startIdx < data.items.length && ratings.has(data.items[startIdx].concept_id)) {
            startIdx++;
          }
          if (startIdx > 0 && startIdx < data.items.length) {
            setCurrentIndex(startIdx);
          }
        }
        if (data.items.length === 0) {
          setErrorByCourse((prev) => ({ ...prev, [courseId]: t("review.noItems") }));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setErrorByCourse((prev) => ({ ...prev, [courseId]: t("review.loadFailed") }));
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, errorByCourse, ratings, sessionByCourse, t]);

  const items = session?.items ?? [];
  const current = items[currentIndex] as ReviewItem | undefined;
  const total = items.length;
  const reviewed = ratings.size;
  const allDone = reviewed === total && total > 0;
  const urgentCount = items.filter((item) => item.urgency === "overdue" || item.urgency === "urgent").length;

  // Save only an unfinished session. Previously the completion screen removed
  // this value during render and this effect immediately wrote it back.
  useEffect(() => {
    try {
      const key = `review-ratings-${courseId}`;
      if (allDone) {
        sessionStorage.removeItem(key);
        return;
      }
      sessionStorage.setItem(key, JSON.stringify(Array.from(ratings.entries())));
    } catch { /* quota exceeded — non-critical */ }
  }, [allDone, courseId, ratings]);

  useEffect(() => {
    if (!allDone) return;
    markReviewSessionCompleted(courseId);

    const originInsightId = searchParams.get("originInsight");
    if (!originInsightId) return;
    const store = useWorkspaceStore.getState();
    const origin = store.spaceLayout.blocks.find((block) => block.id === originInsightId);
    if (origin?.type !== "agent_insight" || origin.config.insightType !== "review_needed") return;

    store.removeBlock(originInsightId);
    void syncCourseSpaceLayout(courseId, useWorkspaceStore.getState().spaceLayout)
      .catch((error) => console.warn("[Review] failed to persist resolved insight:", error));
  }, [allDone, courseId, searchParams]);

  useEffect(() => {
    setNoteOpen(false);
    setRelatedNote(null);
    setNoteError(null);
  }, [current?.concept_id]);

  const openRelatedNote = useCallback(async () => {
    if (!current?.content_node_id) return;
    setNoteOpen(true);
    setNoteLoading(true);
    setNoteError(null);
    try {
      const note = await getAiNoteForNode(courseId, current.content_node_id);
      setRelatedNote(note);
      if (!note?.markdown?.trim()) setNoteError(t("review.relatedNoteEmpty"));
    } catch {
      setRelatedNote(null);
      setNoteError(t("review.relatedNoteFailed"));
    } finally {
      setNoteLoading(false);
    }
  }, [courseId, current, t]);

  const handleRate = useCallback(
    async (rating: Rating) => {
      if (!current) return;
      setSubmitting(true);
      setRatingError(null);

      try {
        await submitReviewRating(courseId, current.concept_id, rating);
      } catch (err) {
        trackApiFailure("rating", err, {
          endpoint: `/progress/courses/${courseId}/review-session/rate`,
          courseId,
          meta: {
            conceptId: current.concept_id,
            rating,
          },
        });
        setRatingError(err instanceof Error ? err.message : t("review.rateFailed"));
        setSubmitting(false);
        return;
      }

      setRatings((prev) => new Map(prev).set(current.concept_id, rating));
      setSubmitting(false);
      setRevealed(false);
      if (currentIndex < total - 1) {
        setCurrentIndex((i) => i + 1);
      }
    },
    [courseId, current, currentIndex, t, total],
  );

  const goBack = () => router.push(`/course/${courseId}`);

  const urgencyColor = (urgency: string) => {
    switch (urgency) {
      case "overdue":
        return "text-destructive";
      case "urgent":
        return "text-warning-foreground bg-warning-muted";
      case "warning":
        return "text-warning-foreground bg-warning-muted/60";
      default:
        return "text-muted-foreground bg-muted";
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground animate-pulse">{t("review.loading")}</p>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">{error || t("review.noData")}</p>
        <button
          type="button"
          onClick={goBack}
          className="text-sm text-brand hover:underline"
        >
          {t("review.backToCourse")}
        </button>
      </div>
    );
  }

  if (allDone) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-6">
        <CheckCircle2 className="size-16 text-success" />
        <h1 className="text-2xl font-bold text-foreground">{t("review.complete")}</h1>
        <p className="text-muted-foreground text-center max-w-md">
          {tf("review.completeMessage", { count: total })}
        </p>
        <button
          type="button"
          onClick={goBack}
          className="px-6 py-2.5 rounded-full bg-brand text-brand-foreground font-medium hover:opacity-90 transition-opacity"
        >
          {t("review.backToCourse")}
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border/60 px-4 py-3 flex items-center gap-4 glass">
        <button type="button" onClick={goBack} className="text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="size-5" />
        </button>
        <h1 className="text-sm font-semibold text-foreground">{t("review.sessionTitle")}</h1>
        <button
          type="button"
          onClick={() => void openRelatedNote()}
          disabled={!current?.content_node_id}
          aria-label={t("review.viewRelatedNote")}
          title={current?.content_node_id ? t("review.viewRelatedNote") : t("review.noRelatedNote")}
          className="flex size-8 items-center justify-center rounded-xl border border-brand/20 bg-brand/8 text-brand transition-colors hover:bg-brand/15 disabled:cursor-not-allowed disabled:opacity-35"
        >
          <BookOpen className="size-4" />
        </button>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">
          {tf("review.reviewed", { reviewed, total })}
        </span>
      </header>

      {/* Progress bar */}
      <div className="h-1 bg-muted">
        <div
          className="h-full bg-brand transition-all duration-300"
          style={{ width: `${total > 0 ? (reviewed / total) * 100 : 0}%` }}
        />
      </div>

      {/* Card area */}
      <main className="flex-1 px-4 py-6 sm:p-8">
        {current && (
          <div className="mx-auto w-full max-w-3xl space-y-5">
            <section className="grid grid-cols-3 gap-2 sm:gap-3" aria-label={t("review.sessionOverview")}>
              <div className="rounded-2xl border border-border/60 bg-card p-3 sm:p-4">
                <Target className="mb-2 size-4 text-brand" />
                <p className="text-lg font-semibold">{total}</p>
                <p className="text-[11px] text-muted-foreground sm:text-xs">{t("review.todayConcepts")}</p>
              </div>
              <div className="rounded-2xl border border-border/60 bg-card p-3 sm:p-4">
                <Clock3 className="mb-2 size-4 text-warning-foreground" />
                <p className="text-lg font-semibold">{urgentCount}</p>
                <p className="text-[11px] text-muted-foreground sm:text-xs">{t("review.priorityConcepts")}</p>
              </div>
              <div className="rounded-2xl border border-border/60 bg-card p-3 sm:p-4">
                <Brain className="mb-2 size-4 text-success" />
                <p className="text-lg font-semibold">{Math.round((current.mastery ?? 0) * 100)}%</p>
                <p className="text-[11px] text-muted-foreground sm:text-xs">{t("review.currentMastery")}</p>
              </div>
            </section>

            {/* Navigation */}
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setRevealed(false);
                  setCurrentIndex((i) => Math.max(0, i - 1));
                }}
                disabled={currentIndex === 0}
                className="p-2 rounded-xl hover:bg-muted disabled:opacity-30 transition-colors"
              >
                <ChevronLeft className="size-5" />
              </button>
              <span className="text-sm text-muted-foreground">
                {tf("review.of", { current: currentIndex + 1, total })}
              </span>
              <button
                type="button"
                onClick={() => {
                  setRevealed(false);
                  setCurrentIndex((i) => Math.min(total - 1, i + 1));
                }}
                disabled={currentIndex === total - 1}
                className="p-2 rounded-xl hover:bg-muted disabled:opacity-30 transition-colors"
              >
                <ChevronRight className="size-5" />
              </button>
            </div>

            {/* Card */}
            <div className="rounded-3xl bg-card card-shadow overflow-hidden">
              <div className="border-b border-border/60 bg-gradient-to-br from-brand/10 via-card to-success/5 p-6 sm:p-8">
                <p className="mb-2 text-xs font-medium text-brand">{t("review.recallChallenge")}</p>
                <h2 className="text-xl font-semibold text-foreground sm:text-2xl">{current.concept_label}</h2>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                  {tf("review.recallPrompt", { concept: current.concept_label })}
                </p>
              </div>

              <div className="space-y-5 p-6 sm:p-8">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${urgencyColor(current.urgency)}`}>
                    {t(`review.urgency.${current.urgency === "scheduled" ? "ok" : current.urgency}`)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {tf("review.mastery", { value: Math.round((current.mastery ?? 0) * 100) })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {tf("review.stability", { value: (current.stability_days ?? 0).toFixed(1) })}
                  </span>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl bg-muted/35 p-4">
                    <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Target className="size-4 text-brand" />{t("review.whyReview")}</div>
                    <p className="text-sm leading-6 text-muted-foreground">{reviewReason(current.reason, t)}</p>
                  </div>
                  <div className="rounded-2xl bg-muted/35 p-4">
                    <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Link2 className="size-4 text-success" />{t("review.relatedKnowledge")}</div>
                    {current.related_concepts?.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {current.related_concepts.map((concept) => <span key={concept} className="rounded-full bg-card px-2.5 py-1 text-xs">{concept}</span>)}
                      </div>
                    ) : <p className="text-sm text-muted-foreground">{t("review.buildConnection")}</p>}
                  </div>
                </div>

                {!revealed ? (
                  <div className="rounded-2xl border border-dashed border-brand/30 p-4 text-center">
                    <p className="mb-3 text-sm text-muted-foreground">{t("review.thinkFirst")}</p>
                    <button type="button" onClick={() => setRevealed(true)} className="px-5 py-2 rounded-full bg-brand text-brand-foreground text-sm font-medium hover:opacity-90 transition-opacity">
                      {t("review.showDetails")}
                    </button>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-brand/15 bg-brand/5 p-4 text-sm">
                    <div className="mb-3 flex items-center gap-2 font-medium"><BookOpen className="size-4 text-brand" />{t("review.reviewGuide")}</div>
                    <ol className="list-decimal space-y-2 pl-5 leading-6 text-muted-foreground">
                      <li>{tf("review.guideDefinition", { concept: current.concept_label })}</li>
                      <li>{t("review.guideExample")}</li>
                      <li>{t("review.guideCheck")}</li>
                    </ol>
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-brand/10 pt-3 text-xs text-muted-foreground">
                      <span>{tf("review.retrievability", { value: Math.round(current.retrievability * 100) })}</span>
                      {current.content_node_id ? <button type="button" onClick={() => void openRelatedNote()} className="inline-flex items-center gap-1 font-medium text-brand hover:underline"><BookOpen className="size-3.5" />{t("review.openRelatedNotes")}</button> : null}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Rating buttons */}
            {revealed && (
              <div className="grid grid-cols-4 gap-2">
                {(
                  [
                    { key: "again", labelKey: "review.again", color: "bg-destructive/10 text-destructive hover:bg-destructive/20" },
                    { key: "hard", labelKey: "review.hard", color: "bg-warning-muted text-warning-foreground hover:bg-warning-muted/80" },
                    { key: "good", labelKey: "review.good", color: "bg-success-muted text-success hover:bg-success-muted/80" },
                    { key: "easy", labelKey: "review.easy", color: "bg-brand-muted text-brand hover:bg-brand-muted/80" },
                  ] as const
                ).map(({ key, labelKey, color }) => (
                  <button
                    type="button"
                    key={key}
                    onClick={() => void handleRate(key)}
                    disabled={submitting}
                    className={`py-2.5 rounded-xl text-sm font-medium transition-colors ${color}`}
                  >
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            )}

            {ratingError ? (
              <p className="text-xs text-center text-destructive">{ratingError}</p>
            ) : null}

            {/* Already rated indicator */}
            {ratings.has(current.concept_id) && (
              <p className="text-xs text-center text-success">
                {tf("review.rated", { value: ratings.get(current.concept_id)! })}
              </p>
            )}
          </div>
        )}
      </main>

      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent className="!left-auto !right-0 !top-0 flex !h-dvh !max-h-dvh w-[min(92vw,680px)] !max-w-none !translate-x-0 !translate-y-0 flex-col gap-0 overflow-hidden !rounded-none border-y-0 border-r-0 p-0 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right">
          <DialogHeader className="border-b border-border/60 bg-gradient-to-r from-brand/10 to-success/5 px-6 py-5 pr-12">
            <DialogTitle className="flex items-center gap-2">
              <span className="flex size-9 items-center justify-center rounded-xl bg-brand/12 text-brand"><BookOpen className="size-5" /></span>
              {relatedNote?.title || current?.concept_label || t("review.relatedNoteTitle")}
            </DialogTitle>
            <DialogDescription>{t("review.relatedNoteDescription")}</DialogDescription>
          </DialogHeader>
          <div className="min-h-48 flex-1 overflow-y-auto overscroll-contain px-6 py-5">
            {noteLoading ? (
              <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />{t("review.relatedNoteLoading")}
              </div>
            ) : noteError ? (
              <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
                <BookOpen className="size-8 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">{noteError}</p>
              </div>
            ) : relatedNote?.markdown ? (
              <MarkdownRenderer content={relatedNote.markdown} />
            ) : null}
          </div>
          {current?.content_node_id ? (
            <div className="border-t border-border/60 bg-background/95 px-6 py-4 backdrop-blur">
              <p className="mb-3 text-xs leading-5 text-muted-foreground">{t("review.continueLearningHint")}</p>
              <Link
                href={`/course/${courseId}?node=${encodeURIComponent(current.content_node_id)}#notes`}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-foreground transition-opacity hover:opacity-90"
              >
                <BookOpen className="size-4" />
                {t("review.goToChapterLearning")}
              </Link>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
