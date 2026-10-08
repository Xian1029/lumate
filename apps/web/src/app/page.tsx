"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Plus } from "lucide-react";
import { deleteCourse, startLearningPlan } from "@/lib/api";
import { useLearningHome } from "./_hooks/use-learning-home";
import { DraftPlansSection, FirstSpaceEmptyState, LearningSummary, NextLearningCard, PendingPlansSection, ProcessingSection, RecentLearning, ReviewSection, SpacesSection, TodayTasksSection } from "./_components/learning-home";

export default function LearningHomePage() {
  const router = useRouter();
  const { overview, loading, error, reload } = useLearningHome();
  const navigate = (href: string) => router.push(href);
  // Await the authoritative task mutation before navigating.  The endpoint is
  // idempotent for IN_PROGRESS, so a retried click never turns into a 409.
  const startTask = async (planId: string) => (await startLearningPlan(planId)).href;
  const deleteSpace = async (courseId: string) => { await deleteCourse(courseId); await reload(); };

  // The overview already carries the server-resolved task location.  Prefetch
  // it while the learner is reading the card, so the first click only waits
  // for the tiny authoritative start mutation rather than a route compile.
  useEffect(() => {
    const href = overview?.current_learning_action?.href;
    if (href) router.prefetch(href);
  }, [overview?.current_learning_action?.href, router]);

  const empty = !loading && overview?.learning_spaces.length === 0;
  return <main className="min-h-screen bg-background"><div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-8 sm:px-6 md:py-12"><header className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm text-muted-foreground">我的学习首页</p><p className="mt-1 text-lg font-semibold text-foreground">今天，先完成一个小目标。</p></div><div className="flex items-center gap-3"><button type="button" onClick={() => navigate("/learning-plans")} className="rounded-full bg-brand-muted px-3 py-2 text-sm font-semibold text-brand">我的学习计划</button><button type="button" onClick={() => navigate("/new")} className="inline-flex h-10 items-center gap-2 rounded-full bg-brand px-4 text-sm font-semibold text-brand-foreground"><Plus className="size-4" />新建学习空间</button></div></header>{error && <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">加载学习数据失败：{error}<button type="button" onClick={reload} className="ml-3 font-medium underline">重试</button></div>}{empty ? <FirstSpaceEmptyState onNavigate={navigate} /> : <><NextLearningCard action={overview?.current_learning_action ?? null} loading={loading} onNavigate={navigate} onStartPlan={startTask} />{overview && <TodayTasksSection overview={overview} onNavigate={navigate} onStartPlan={startTask} />}{overview && <RecentLearning recent={overview.recent_learning} onNavigate={navigate} />}{<DraftPlansSection plans={overview?.draft_learning_plans ?? []} onNavigate={navigate} />}<PendingPlansSection plans={overview?.pending_learning_plans ?? []} onNavigate={navigate} />{overview && <ReviewSection reviews={overview.review_queue} onNavigate={navigate} />}{overview && <ProcessingSection uploads={overview.processing_uploads} onNavigate={navigate} />}{overview && <SpacesSection spaces={overview.learning_spaces} onNavigate={navigate} onDelete={deleteSpace} />}{overview && <LearningSummary overview={overview} />}</>}</div></main>;
}
