"use client";

import { ArrowRight, BookOpen, CalendarCheck2, Clock3, FileClock, Play, Plus, RotateCcw, Settings2, Target, Trash2, TrendingUp } from "lucide-react";
import { useState } from "react";
import type { HomeLearningAction, HomeLearningSpace, HomeProcessingUpload, HomeReviewItem, LearningHomeOverview, LearningPlanSummary } from "@/lib/api";
import { getProcessingStatusLabel } from "@/lib/display-mappers";

function HomeSection({ title, icon: Icon, children, action }: { title: string; icon: typeof BookOpen; children: React.ReactNode; action?: React.ReactNode }) {
  return <section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm"><div className="mb-4 flex items-center justify-between gap-3"><div className="flex items-center gap-2 text-sm font-semibold text-foreground"><span className="grid size-7 place-items-center rounded-lg bg-brand-muted text-brand"><Icon className="size-4" /></span>{title}</div>{action}</div>{children}</section>;
}

export function FirstSpaceEmptyState({ onNavigate }: { onNavigate: (href: string) => void }) {
  return <section className="rounded-3xl border border-dashed border-brand/35 bg-brand-muted/20 px-6 py-12 text-center"><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-card text-brand shadow-sm"><BookOpen className="size-7" /></span><h1 className="mt-5 text-2xl font-bold text-foreground">创建你的第一个学习空间</h1><p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">上传教材、讲义或笔记后，我们会帮你整理课程并给出下一步学习建议。</p><div className="mt-7 flex flex-wrap justify-center gap-3"><button type="button" onClick={() => onNavigate("/new")} className="inline-flex h-11 items-center gap-2 rounded-full bg-brand px-5 text-sm font-semibold text-brand-foreground"><Plus className="size-4" />上传学习资料</button><button type="button" onClick={() => onNavigate("/setup?step=content")} className="inline-flex h-11 items-center rounded-full border border-border bg-card px-5 text-sm font-semibold text-foreground hover:bg-muted">手动创建学习空间</button></div></section>;
}

export function NextLearningCard({ action, loading, onNavigate, onStartPlan }: { action: HomeLearningAction | null; loading: boolean; onNavigate: (href: string) => void; onStartPlan?: (planId: string) => Promise<string> }) {
  const [starting, setStarting] = useState(false);
  const launch = async () => { if (starting || !action) return; setStarting(true); try { const href = action.learning_task_id && action.plan_id ? await onStartPlan?.(action.plan_id) : action.href; onNavigate(href || action.href); } finally { setStarting(false); } };
  return <section className="overflow-hidden rounded-3xl border border-brand/20 bg-gradient-to-br from-brand-muted via-card to-card p-6 shadow-sm sm:p-7"><p className="text-sm font-semibold text-brand">今日继续学习</p>{loading ? <div className="mt-4 space-y-3 animate-pulse"><div className="h-7 w-2/3 rounded bg-muted" /><div className="h-4 w-full rounded bg-muted" /><div className="h-11 w-32 rounded-full bg-muted" /></div> : !action ? <div className="mt-4"><h1 className="text-xl font-bold text-foreground">先创建一个学习空间</h1><p className="mt-2 text-sm text-muted-foreground">添加资料后，我们会为你准备第一步。</p></div> : <><h1 className="mt-4 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{action.title}</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{action.reason}</p><button type="button" disabled={starting} onClick={() => void launch()} className="mt-6 inline-flex h-11 items-center gap-2 rounded-full bg-brand px-6 text-sm font-semibold text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-60"><Play className="size-4 fill-current" />{starting ? "正在进入…" : action.action_text}</button></>}</section>;
}

export function PendingPlansSection({ plans, onNavigate }: { plans: LearningPlanSummary[]; onNavigate: (href: string) => void }) {
  const plan = plans[0];
  if (!plan) return null;
  return <HomeSection title="待确认计划" icon={Target}><button type="button" onClick={() => onNavigate(`/learning-plans/${plan.plan.id}/review`)} className="w-full rounded-xl bg-brand-muted/35 p-4 text-left hover:bg-brand-muted/55"><p className="font-semibold text-foreground">你有一个学习计划等待确认</p><p className="mt-1 text-sm text-muted-foreground">{plan.plan.title} · 目标日期：{plan.plan.target_date || "暂未设定"} · 每天约 {plan.plan.available_minutes_per_day || "—"} 分钟</p><span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand">查看并确认 <ArrowRight className="size-4" /></span></button></HomeSection>;
}

export function DraftPlansSection({ plans, onNavigate }: { plans: LearningPlanSummary[]; onNavigate: (href: string) => void }) {
  const plan = plans[0]; if (!plan) return null;
  return <HomeSection title="待继续编辑的计划" icon={Target}><button type="button" onClick={() => onNavigate(`/learning-plans/${plan.plan.id}/edit`)} className="w-full rounded-xl bg-sky-50/70 p-4 text-left hover:bg-sky-100/70"><p className="font-semibold text-foreground">继续完善“{plan.plan.title}”</p><p className="mt-1 text-sm text-muted-foreground">计划尚未开始，不会出现在今日任务中。</p><span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand">继续编辑 <ArrowRight className="size-4" /></span></button></HomeSection>;
}

export function TodayTasksSection({ overview, onNavigate, onStartPlan }: { overview: LearningHomeOverview; onNavigate: (href: string) => void; onStartPlan?: (planId: string) => Promise<string> }) {
  const { today_tasks: tasks, today_summary: summary, upcoming_tasks: upcoming } = overview;
  if (!tasks.length && !upcoming.length) return null;
  const launch = async (planId: string, fallback: string) => onNavigate(await onStartPlan?.(planId) || fallback);
  const rows = tasks.length ? tasks : upcoming;
  const title = tasks.length ? `今天要完成 · 预计 ${summary.estimated_minutes} 分钟` : "近期学习安排";
  return <HomeSection title={title} icon={CalendarCheck2}>{tasks.length > 0 && <p className="mb-3 text-xs text-muted-foreground">完成一项，就离目标更近一步。已完成 {summary.completed_count}/{summary.total_count} 项</p>}{!tasks.length && <p className="mb-3 text-xs text-muted-foreground">提前看一看接下来的安排，学习更从容。</p>}<div className="space-y-2">{rows.map((task) => <button key={task.id} type="button" onClick={() => void launch(task.plan_id, task.href)} className="flex w-full items-center gap-3 rounded-xl bg-muted/30 p-3 text-left hover:bg-muted/60"><Target className="size-4 shrink-0 text-brand" /><span className="flex-1 truncate text-sm text-foreground">{task.title}</span><span className="text-xs text-muted-foreground">{tasks.length ? (task.status === "IN_PROGRESS" ? "继续" : "开始") : "查看安排"}</span><ArrowRight className="size-4 text-muted-foreground" /></button>)}</div></HomeSection>;
}

export function ProcessingSection({ uploads, onNavigate }: { uploads: HomeProcessingUpload[]; onNavigate: (href: string) => void }) {
  if (!uploads.length) return null;
  const failed = uploads.filter((upload) => upload.status === "failed");
  return <HomeSection title={failed.length ? `有 ${failed.length} 份资料需要重新处理` : "资料处理中"} icon={FileClock}><div className="space-y-2">{uploads.slice(0, 3).map((upload) => <button key={upload.id} type="button" onClick={() => onNavigate(upload.href)} className="flex w-full items-center gap-3 rounded-xl bg-muted/30 p-3 text-left hover:bg-muted/60"><FileClock className="size-4 shrink-0 text-brand" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-foreground">{upload.name}</span><span className="block truncate text-xs text-muted-foreground">{upload.status === "failed" ? "处理没有完成，点击重新查看" : `${upload.phase_label} · 已完成 ${upload.progress_percent}%`}</span></span><ArrowRight className="size-4 text-muted-foreground" /></button>)}</div></HomeSection>;
}

export function ReviewSection({ reviews, onNavigate }: { reviews: HomeReviewItem[]; onNavigate: (href: string) => void }) {
  if (!reviews.length) return null;
  const total = reviews.reduce((sum, review) => sum + review.count, 0); const top = reviews[0];
  return <HomeSection title={`待复习 · ${total}`} icon={RotateCcw}><button type="button" onClick={() => onNavigate(top.href)} className="flex w-full items-center gap-3 rounded-xl bg-muted/40 p-3 text-left transition-colors hover:bg-muted/70"><span className="flex-1"><span className="block text-sm font-medium text-foreground">{top.course_name}</span><span className="mt-1 block text-xs text-muted-foreground">优先复习：{top.highest_priority_knowledge} · 约 {top.estimated_minutes} 分钟</span></span><span className="text-xs text-warning">开始复习</span><ArrowRight className="size-4 text-muted-foreground" /></button></HomeSection>;
}

function spaceLocationLabel(space: HomeLearningSpace): string {
  if (space.current_node_title) return `${space.status_label}：${space.current_node_title}`;
  if (space.status === "COMPLETED") return "当前学习内容已完成，可以复习巩固。";
  if (space.status === "NOT_STARTED") return "从第一个学习内容开始学习";
  return "已准备好下一步学习内容";
}

export function SpacesSection({ spaces, onNavigate, onDelete }: { spaces: HomeLearningSpace[]; onNavigate: (href: string) => void; onDelete?: (id: string) => Promise<void> }) {
  const [showAll, setShowAll] = useState(false);
  const [managing, setManaging] = useState(false);
  const remove = async (id: string, name: string) => {
    if (!window.confirm(`将学习空间“${name}”移入回收站？之后仍可恢复。`)) return;
    await onDelete?.(id);
  };
  const action = <div className="flex flex-wrap items-center justify-end gap-3"><button type="button" onClick={() => setManaging((value) => !value)} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"><Settings2 className="size-3.5" />{managing ? "完成管理" : "管理空间"}</button><button type="button" onClick={() => onNavigate("/trash")} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"><Trash2 className="size-3.5" />回收站</button><button type="button" onClick={() => onNavigate("/new")} className="inline-flex items-center gap-1 text-xs font-semibold text-brand"><Plus className="size-3.5" />新建学习空间</button></div>;
  const visibleSpaces = showAll ? spaces : spaces.slice(0, 4);
  return <HomeSection title="我的学习空间" icon={BookOpen} action={action}>{managing && <p className="mb-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">管理模式：可将不再使用的学习空间移入回收站，学习数据不会立即永久删除。</p>}<div className="grid gap-4 sm:grid-cols-2">{visibleSpaces.map((space) => <article key={space.id} className="relative min-h-[236px] overflow-hidden rounded-2xl border border-border/75 bg-card shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md"><button type="button" onClick={() => onNavigate(space.target_route)} className={`flex h-full w-full flex-col p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset ${managing ? "pr-12" : ""}`}><div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-muted text-brand"><BookOpen className="size-[18px]" /></span><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><p className="truncate text-[15px] font-semibold text-foreground">{space.name}</p><span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{space.status_label}</span></div><p className="mt-1.5 truncate text-xs text-muted-foreground">{spaceLocationLabel(space)}</p></div></div>{space.total_learning_items > 0 ? <div className="mt-5 rounded-xl bg-muted/45 px-3 py-2.5"><div className="flex items-center justify-between gap-2 text-xs"><span className="text-muted-foreground">已完成 {space.completed_learning_items} / {space.total_learning_items} 个学习内容</span><span className="shrink-0 font-semibold text-foreground">{space.progress_percent ?? 0}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-card"><div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${space.progress_percent ?? 0}%` }} /></div></div> : <p className="mt-5 rounded-xl bg-muted/45 px-3 py-3 text-xs text-muted-foreground">资料正在整理，完成后就可以开始学习。</p>}{space.review_count > 0 ? <p className="mt-3 inline-flex w-fit items-center rounded-full bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning">待复习 {space.review_count} 个知识点</p> : <span className="mt-3 h-7" />}<span className="mt-auto inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-brand px-4 text-sm font-semibold text-brand-foreground transition-colors hover:brightness-95">{space.action_label} <ArrowRight className="size-4" /></span></button>{managing && onDelete && <button type="button" aria-label={`删除学习空间“${space.name}”`} title="移入回收站" onClick={() => void remove(space.id, space.name)} className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="size-4" /></button>}</article>)}</div>{spaces.length > 4 ? <button type="button" onClick={() => setShowAll((value) => !value)} className="mt-3 text-sm font-semibold text-brand hover:underline">{showAll ? "收起学习空间" : `查看全部学习空间（${spaces.length}）`}</button> : null}<button type="button" onClick={() => onNavigate("/new")} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-brand/35 px-4 py-3 text-sm font-semibold text-brand hover:bg-brand-muted/20"><Plus className="size-4" />新建学习空间</button></HomeSection>;
}

export function RecentLearning({ recent, onNavigate }: { recent: LearningHomeOverview["recent_learning"]; onNavigate: (href: string) => void }) {
  if (!recent) return null;
  return <HomeSection title="继续上次学习" icon={Clock3}><button type="button" onClick={() => onNavigate(recent.href)} className="flex w-full items-center gap-3 rounded-xl bg-muted/30 p-3 text-left hover:bg-muted/60"><div className="flex-1"><p className="text-sm font-medium text-foreground">{recent.course_name}</p><p className="mt-1 text-xs text-muted-foreground">{recent.content_title ? `上次学到：${recent.content_title}` : "回到上次的学习位置"}</p></div><span className="text-xs font-medium text-brand">继续学习</span><ArrowRight className="size-4 text-muted-foreground" /></button></HomeSection>;
}

export function LearningSummary({ overview, onNavigate = (href) => window.location.assign(href) }: { overview: LearningHomeOverview; onNavigate?: (href: string) => void }) {
  const summary = overview.learning_summary;
  const [showAll, setShowAll] = useState(false);
  const spaces = showAll ? overview.learning_spaces : overview.learning_spaces.slice(0, 4);
  return <HomeSection title="学习概况" icon={TrendingUp}>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {[[summary.active_workspace_count, "正在学习的空间"], [summary.today_task_count, "今日待完成"], [summary.completed_task_count_this_week, "本周已完成"], [summary.review_due_count, "待复习知识点"]].map(([value, label]) => <div key={label} className="rounded-xl bg-muted/35 px-3 py-3 text-center"><p className="text-xl font-bold text-foreground">{value}</p><p className="mt-1 text-xs text-muted-foreground">{label}</p></div>)}
    </div>
    {summary.total_learning_items > 0 && <div className="mt-4 rounded-xl border border-border/70 p-4"><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-foreground">全部学习空间</p><p className="mt-1 text-xs text-muted-foreground">已完成 {summary.completed_learning_items} / {summary.total_learning_items} 个学习内容，按内容数量加权计算。</p></div><span className="text-lg font-bold text-brand">{summary.progress_percent}%</span></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-brand" style={{ width: `${summary.progress_percent}%` }} /></div></div>}
    <div className="mt-4 space-y-2">
      {spaces.map((space) => <button key={space.id} type="button" onClick={() => onNavigate(space.target_route)} className="flex w-full items-center gap-3 rounded-xl border border-border/70 px-4 py-3 text-left hover:border-brand/35 hover:bg-brand-muted/15"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-muted text-brand"><BookOpen className="size-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-foreground">{space.name}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{space.current_node_title ? `正在学习：${space.current_node_title}` : space.status_label}</span><span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>完成 {space.completed_learning_items}/{space.total_learning_items}</span>{space.today_task_count > 0 && <span>今日 {space.today_task_count} 项</span>}{space.review_count > 0 && <span>待复习 {space.review_count} 个</span>}</span></span><span className="shrink-0 text-sm font-bold text-foreground">{space.progress_percent ?? 0}%</span><ArrowRight className="size-4 shrink-0 text-muted-foreground" /></button>)}
    </div>
    {overview.learning_spaces.length > 4 && <button type="button" onClick={() => setShowAll((value) => !value)} className="mt-3 text-sm font-semibold text-brand hover:underline">{showAll ? "收起" : `查看全部学习空间（${overview.learning_spaces.length}）`}</button>}
  </HomeSection>;
}
