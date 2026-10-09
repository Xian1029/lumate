"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspaceStore } from "@/store/workspace";
import { extractQuiz } from "@/lib/api";
import { ChapterHeader } from "@/components/course/chapter-header";
import { ChatFab } from "@/components/chat/chat-fab";
import { ChatDrawer } from "@/components/chat/chat-drawer";
import { toast } from "sonner";
import { useT, useTF } from "@/lib/i18n-context";

import { ErrorBoundary } from "@/components/shared/error-boundary";
import { useUnitData } from "./_components/use-unit-data";
import { ContentBlock } from "./_components/content-block";
import { ErrorAnalysis, ErrorPatternSection } from "./_components/error-analysis";
import { MasteryTimeline, NextActionsSection } from "./_components/mastery-timeline";
import { resolveChapterNavigationNodes, UnitNavigation, SubsectionsNav } from "./_components/unit-navigation";
import { StatsRow } from "./_components/stats-row";
import { PracticePanel } from "./_components/practice-panel";
import { GraphPanel } from "./_components/graph-panel";
import { getContentNodeMaterialKey, getPreferredLearningNode, isPracticeEligibleContentNode } from "@/lib/content-tree";

export default function UnitPage() {
  const params = useParams();
  const router = useRouter();
  const courseId = params.id as string;
  const nodeId = params.nodeId as string;
  const t = useT();
  const tf = useTF();
  const triggerRefresh = useWorkspaceStore((s) => s.triggerRefresh);
  const [chatOpen, setChatOpen] = useState(false);
  const [generatingFocusedQuiz, setGeneratingFocusedQuiz] = useState(false);

  const {
    course, node, nodePath, parentNode, siblingNodes, focusTerms,
    wrongAnswers, reviewItems, masteryHistory, loadingSignals, aiActionsEnabled,
    errorPatterns, masterySummary, errorTrend, difficultyRec, quizModeHint, urgentReviews,
  } = useUnitData(courseId, nodeId);

  const courseRootNode = nodePath[0] ?? null;
  const currentChapterNode = nodePath.length > 1 ? nodePath[1] : node;
  const chapterNavigationNodes = node ? resolveChapterNavigationNodes(node, parentNode, courseRootNode ?? undefined) : [];
  const chapterLearningTarget = node && nodePath.length === 2 && node.children?.length
    ? getPreferredLearningNode(node)
    : null;
  // Front matter, contents and document containers are navigable reference
  // nodes, not a valid question context.  Do not render an empty practice UI.
  const practiceEligible = node ? isPracticeEligibleContentNode(node) : false;
  const activeMaterialId = getContentNodeMaterialKey(nodePath, nodeId);

  useEffect(() => {
    if (chapterLearningTarget && chapterLearningTarget.id !== nodeId) {
      router.replace(`/course/${courseId}/unit/${chapterLearningTarget.id}`);
    }
  }, [chapterLearningTarget, courseId, nodeId, router]);

  const handleGenerateFocusedQuiz = async () => {
    setGeneratingFocusedQuiz(true);
    try {
      const res = await extractQuiz(courseId, nodeId, quizModeHint, difficultyRec.level);
      triggerRefresh("practice");
      toast.success(tf("unit.focusedQuiz.generated", { count: res.problems_created }));
    } catch (error) {
      toast.error((error as Error).message || t("unit.focusedQuiz.failed"));
    } finally {
      setGeneratingFocusedQuiz(false);
    }
  };

  if (!node) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-sm text-muted-foreground animate-pulse">{t("general.loading")}</p>
      </div>
    );
  }

  if (chapterLearningTarget && chapterLearningTarget.id !== nodeId) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-sm text-muted-foreground animate-pulse">{t("general.loading")}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_8%_10%,rgba(167,243,208,0.22),transparent_24rem),radial-gradient(circle_at_92%_18%,rgba(253,230,138,0.22),transparent_22rem),linear-gradient(to_bottom,#fffdf8,#f8fbf8_45%,#fffdf9)]">
      <ChapterHeader
        courseId={courseId}
        courseName={course?.name ?? t("course.home")}
        chapterTitle={node.title}
        chapters={chapterNavigationNodes}
        currentChapterId={currentChapterNode?.id ?? nodeId}
      />

      <main className="mx-auto max-w-6xl space-y-7 px-4 py-7 sm:px-6 sm:py-9">
        <UnitNavigation courseId={courseId} nodePath={nodePath} parentNode={parentNode} siblingNodes={siblingNodes} focusTerms={focusTerms} wrongAnswerCount={wrongAnswers.length} reviewItemCount={reviewItems.length} t={t} tf={tf} />

        <SubsectionsNav
          courseId={courseId}
          currentNodeId={nodeId}
          subsections={chapterNavigationNodes}
          t={t}
        />

        <StatsRow subsectionCount={node.children?.length ?? 0} wrongAnswerCount={wrongAnswers.length} urgentReviewCount={urgentReviews} t={t} />

        <ErrorBoundary section="error analysis">
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ErrorPatternSection wrongAnswers={wrongAnswers} errorPatterns={errorPatterns} t={t} />
            <NextActionsSection courseId={courseId} masterySummary={masterySummary} errorTrend={errorTrend} difficultyRec={difficultyRec} quizModeHint={quizModeHint} aiActionsEnabled={aiActionsEnabled} generatingFocusedQuiz={generatingFocusedQuiz} onGenerateFocusedQuiz={() => void handleGenerateFocusedQuiz()} onNavigate={(path) => router.push(path)} t={t} tf={tf} />
          </section>
        </ErrorBoundary>

        <ErrorBoundary section="notes">
          <section className="overflow-hidden rounded-3xl border border-emerald-100/80 bg-card shadow-[0_18px_55px_-38px_rgba(16,81,57,0.45)]">
            <div className="border-b border-emerald-100 bg-gradient-to-r from-emerald-50/80 to-amber-50/45 px-6 py-4">
              <p className="text-xs font-medium text-emerald-700">{t("unit.learningStation")}</p>
              <h2 className="mt-0.5 text-xl font-bold text-foreground">{t("course.notes")}</h2>
            </div>
            <div className="p-6">
            <ContentBlock node={node} courseId={courseId} />
            </div>
          </section>
        </ErrorBoundary>

        {practiceEligible ? <ErrorBoundary section="practice">
          <PracticePanel courseId={courseId} difficultyLevel={difficultyRec.level} aiActionsEnabled={aiActionsEnabled} generatingFocusedQuiz={generatingFocusedQuiz} onGenerateFocusedQuiz={() => void handleGenerateFocusedQuiz()} t={t} tf={tf} />
        </ErrorBoundary> : null}

        <ErrorBoundary section="knowledge graph">
          <GraphPanel courseId={courseId} focusTerms={focusTerms} activeMaterialId={activeMaterialId} t={t} />
        </ErrorBoundary>

        <section className="rounded-3xl border border-rose-100 bg-card p-6 shadow-[0_16px_48px_-38px_rgba(120,50,50,0.4)]">
          <h2 className="mb-1 text-xl font-bold">{t("unit.errorAnalysis")}</h2>
          <p className="mb-4 text-sm text-muted-foreground">{t("unit.errorAnalysisFriendly")}</p>
          {loadingSignals ? (
            <p className="text-sm text-muted-foreground animate-pulse">{t("unit.loading.errorSignals")}</p>
          ) : (
            <ErrorAnalysis items={wrongAnswers} t={t} />
          )}
        </section>

        <section className="rounded-3xl border border-sky-100 bg-card p-6 shadow-[0_16px_48px_-38px_rgba(30,90,120,0.4)]">
          <h2 className="mb-1 text-xl font-bold">{t("unit.masteryTimeline")}</h2>
          <p className="mb-4 text-sm text-muted-foreground">{t("unit.masteryFriendly")}</p>
          {loadingSignals ? (
            <p className="text-sm text-muted-foreground animate-pulse">{t("unit.loading.masteryTimeline")}</p>
          ) : (
            <MasteryTimeline snapshots={masteryHistory} t={t} tf={tf} />
          )}
        </section>

      </main>

      <ChatFab open={chatOpen} onToggle={() => setChatOpen((v) => !v)} />
      <ChatDrawer courseId={courseId} open={chatOpen} aiActionsEnabled={aiActionsEnabled} />
    </div>
  );
}
