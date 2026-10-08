"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, CheckCircle2, ChevronRight, CirclePlay, Compass, Flag, GitBranch, LockKeyhole, RefreshCw, Route, Sparkles, Target } from "lucide-react";
import type { ContentNode, KnowledgeGraphEdge, KnowledgeGraphNode, WorkspaceLearningProgress } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { buildLearningPathPlan, type LearningPathNode } from "./learning-path";

interface LearningPathViewProps {
  courseId: string;
  courseName?: string;
  graphNodes: KnowledgeGraphNode[];
  graphEdges: KnowledgeGraphEdge[];
  contentTree: ContentNode[];
  workspaceProgress: WorkspaceLearningProgress | null;
  activeMaterialId?: string | null;
  onShowFullGraph: () => void;
}

function findMatchedContentNode(nodes: ContentNode[], concept: string): ContentNode | null {
  const normalized = concept.replace(/\s+/g, "").toLowerCase();
  let partial: ContentNode | null = null;
  for (const item of nodes) {
    const title = item.title.replace(/\s+/g, "").toLowerCase();
    if (title === normalized) return item;
    if (!partial && (title.includes(normalized) || normalized.includes(title))) partial = item;
    const child = findMatchedContentNode(item.children ?? [], concept);
    if (child) return child;
  }
  return partial;
}

function findContentNodeById(nodes: ContentNode[], nodeId: string): ContentNode | null {
  for (const item of nodes) {
    if (item.id === nodeId) return item;
    const child = findContentNodeById(item.children ?? [], nodeId);
    if (child) return child;
  }
  return null;
}

function learningContext(node: LearningPathNode): string | null {
  const parts = [node.material_title, node.chapter_title].filter((value): value is string => Boolean(value));
  return parts.length ? parts.join(" · ") : null;
}

function statusMeta(node: LearningPathNode) {
  switch (node.statusLabel) {
    case "mastered": return { label: "已掌握", icon: CheckCircle2, tone: "border-emerald-200 bg-emerald-50/70 text-emerald-800" };
    case "learning": return { label: "正在学习", icon: CirclePlay, tone: "border-brand bg-brand-muted/40 text-foreground" };
    case "review": return { label: "建议复习", icon: RefreshCw, tone: "border-amber-200 bg-amber-50/60 text-amber-900" };
    case "locked": return { label: "完成前置后可学", icon: LockKeyhole, tone: "border-border bg-muted/45 text-muted-foreground" };
    default: return { label: "可以开始", icon: Sparkles, tone: "border-border bg-card text-foreground" };
  }
}

export function LearningPathView({ courseId, courseName, graphNodes, graphEdges, contentTree, workspaceProgress, activeMaterialId, onShowFullGraph }: LearningPathViewProps) {
  const router = useRouter();
  const plan = useMemo(() => buildLearningPathPlan(graphNodes, graphEdges, { activeMaterialId }), [graphNodes, graphEdges, activeMaterialId]);
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(plan.recommended?.id ?? null);
  const nodeById = useMemo(() => new Map(plan.nodes.map((node) => [node.id, node])), [plan.nodes]);

  const openLearningNode = (node: LearningPathNode) => {
    // Content-backed fallback nodes must always open their exact textbook
    // section.  Label matching remains only for legacy AI concepts that were
    // extracted before content_node_id was stored.
    const contentNode = node.content_node_id
      ? findContentNodeById(contentTree, node.content_node_id)
      : findMatchedContentNode(contentTree, node.label);
    if (!contentNode || node.statusLabel === "locked") {
      setExpandedNodeId(node.id);
      return;
    }
    router.push(`/course/${courseId}/unit/${contentNode.id}`);
  };

  if (plan.emptyReason === "missing") {
    return (
      <div className="flex min-h-72 flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-muted/20 px-6 text-center">
        <Route className="mb-3 size-8 text-brand" />
        <h2 className="font-semibold">学习路径正在准备</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">上传并解析课程资料后，这里会显示知识点之间的学习顺序。</p>
      </div>
    );
  }

  const recommended = plan.recommended;
  return (
    <div
      role="region"
      aria-label="推荐学习路径"
      className="h-full min-h-0 space-y-5 overflow-y-auto overscroll-contain bg-[#f7f8f6] p-4 pr-3 scrollbar-thin sm:p-6 sm:pr-5"
    >
      <header className="rounded-2xl border border-border bg-card px-4 py-4 shadow-[0_12px_26px_-24px_rgba(45,59,69,0.45)] sm:px-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-muted text-brand"><Compass className="size-5" /></span>
            <div>
              <p className="text-xs font-semibold text-brand">学习路线</p>
              <h1 className="mt-0.5 text-xl font-bold tracking-tight">{courseName || "本课程"}的学习计划</h1>
              <p className="mt-1 text-sm text-muted-foreground">按真实前置关系安排，清楚知道现在学什么、完成后学什么。</p>
            </div>
          </div>
          <div className="inline-flex rounded-xl bg-muted p-1" role="tablist" aria-label="知识图谱视图">
            <button type="button" role="tab" aria-selected className="rounded-lg bg-card px-3 py-2 text-sm font-semibold shadow-sm">推荐学习路径</button>
            <button type="button" role="tab" aria-selected={false} onClick={onShowFullGraph} className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground">完整知识图谱</button>
          </div>
        </div>
        <div className="mt-4 rounded-xl bg-muted/45 p-3">
          <div className="mb-2 flex items-center justify-between text-sm"><span className="font-medium">本学习空间进度</span><span className="font-bold text-brand tabular-nums">{workspaceProgress?.progress_percent ?? 0}%</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full bg-brand transition-all" style={{ width: `${workspaceProgress?.progress_percent ?? 0}%` }} /></div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-center sm:max-w-xs">
            <div className="rounded-lg bg-card py-2"><p className="text-lg font-bold tabular-nums">{workspaceProgress?.completed_learning_items ?? 0}</p><p className="text-xs text-muted-foreground">已完成学习内容</p></div>
            <div className="rounded-lg bg-card py-2"><p className="text-lg font-bold tabular-nums">{workspaceProgress?.total_learning_items ?? 0}</p><p className="text-xs text-muted-foreground">学习内容总数</p></div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">与首页使用同一口径：已掌握的可学习内容 ÷ 全部可学习内容；资料解析进度和计划任务不计入。</p>
        </div>
      </header>

      {recommended ? (
        <section className="relative overflow-hidden rounded-2xl border-2 border-brand/45 bg-card p-4 shadow-[0_12px_28px_-22px_rgba(45,59,69,0.45)] sm:p-5" aria-labelledby="current-learning-title">
          <div className="absolute -right-5 -top-5 size-24 rounded-full bg-brand-muted" aria-hidden="true" />
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative min-w-0">
              <p id="current-learning-title" className="flex items-center gap-1 text-xs font-semibold text-brand"><Target className="size-3.5" />当前建议学习</p>
              <h2 className="mt-1 text-xl font-bold">{recommended.label}</h2>
              {learningContext(recommended) ? <p className="mt-1 text-xs font-medium text-brand">学习范围：{learningContext(recommended)}</p> : null}
              <p className="mt-1 text-sm text-muted-foreground">当前掌握度：{Math.round(recommended.mastery * 100)}%</p>
              {recommended.prerequisiteIds.length ? (
                <p className="mt-2 text-sm text-foreground">前置知识：{recommended.prerequisiteIds.every((id) => nodeById.get(id)?.statusLabel === "mastered") ? "已经准备好了，可以开始学习。" : "还有前置内容需要先完成。"}</p>
              ) : <p className="mt-2 text-sm text-foreground">这一步不需要前置学习，可以直接开始。</p>}
              <p className="mt-1 text-sm text-muted-foreground">推荐原因：{recommended.statusLabel === "learning" ? "你已经开始学习这个内容，建议接着完成。" : recommended.statusLabel === "review" ? "它已有学习记录，先巩固能让后续学习更顺畅。" : recommended.prerequisiteIds.length ? "前置知识已满足，可以自然衔接下一步。" : activeMaterialId && recommended.material_id === activeMaterialId ? "这是当前教材中可以开始的学习内容。" : "这是当前可开始的学习内容。"}</p>
              {recommended.successorIds.length ? <p className="mt-1 text-sm text-muted-foreground">完成后解锁：{recommended.successorIds.map((id) => nodeById.get(id)?.label).filter(Boolean).join("、")}</p> : null}
              {plan.alternatives.length ? <p className="mt-1 text-sm text-muted-foreground">同一前置后的可选方向：{plan.alternatives.map((node) => node.label).join("、")}</p> : null}
            </div>
            <Button size="lg" onClick={() => openLearningNode(recommended)} className="w-full sm:w-auto">
              <BookOpen />继续学习<ChevronRight />
            </Button>
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-border bg-card p-5 text-center">
          <CheckCircle2 className="mx-auto size-8 text-brand" />
          <h2 className="mt-2 font-semibold">{plan.emptyReason === "complete" ? "本课程的知识点已学完" : "暂时还不能开始新的知识点"}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{plan.emptyReason === "complete" ? "可以进入复习，巩固已经学过的内容。" : "先完成已解锁的前置知识，新的内容就会自动开放。"}</p>
        </section>
      )}

      <section className="space-y-4" aria-label="阶段式学习路径">
        {plan.stages.map((stage, stageIndex) => (
          <article key={stage.id} className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_10px_22px_-24px_rgba(45,59,69,0.5)]">
            <header className="flex flex-col gap-3 border-b border-border bg-muted/25 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-muted text-sm font-bold text-brand">{stageIndex + 1}</span>
                <div>
                  <p className="text-xs font-semibold text-brand">阶段 {stageIndex + 1} · {stage.unlocked ? "已解锁" : "等待解锁"}</p>
                  <h2 className="mt-0.5 font-bold">{stage.title}</h2>
                  <p className="text-xs text-muted-foreground">{stage.goal}</p>
                </div>
              </div>
              <div className="sm:text-right"><p className="text-sm font-medium tabular-nums">{stage.completedCount}/{stage.nodes.length} 已掌握</p><div className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full bg-brand" style={{ width: `${stage.nodes.length ? (stage.completedCount / stage.nodes.length) * 100 : 0}%` }} /></div></div>
            </header>
            <ol className="divide-y divide-border px-4">
              {stage.nodes.map((node, index) => {
                const meta = statusMeta(node);
                const Icon = meta.icon;
                const expanded = expandedNodeId === node.id;
                const isCurrentMaterial = Boolean(activeMaterialId && node.material_id === activeMaterialId);
                return (
                  <li key={node.id} className="py-3">
                    <div className="flex items-start gap-3">
                      <div className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-muted text-xs font-bold text-brand"><Flag className="size-3.5" /><span className="sr-only">知识点 {index + 1}</span></div>
                      <button type="button" onClick={() => openLearningNode(node)} className={`min-w-0 flex-1 rounded-xl border p-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${meta.tone} ${node.statusLabel === "locked" ? "cursor-not-allowed" : "hover:-translate-y-0.5 hover:shadow-sm"}`} aria-expanded={expanded}>
                        <div className="flex flex-wrap items-center gap-2">
                          <Icon className="size-4 shrink-0" aria-hidden="true" />
                          <span className="font-semibold">{node.label}</span>
                          {isCurrentMaterial ? <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">当前教材</span> : null}
                          <span className="rounded-full bg-background/80 px-2 py-0.5 text-xs font-medium">{meta.label}</span>
                        </div>
                        {learningContext(node) ? <p className="mt-1 text-xs text-muted-foreground">{learningContext(node)}</p> : null}
                        {node.statusLabel === "mastered" || node.statusLabel === "learning" || node.statusLabel === "review" ? <p className="mt-1 text-xs">掌握度：{Math.round(node.mastery * 100)}%</p> : null}
                        {node.lockReason ? <p className="mt-1 text-xs font-medium">{node.lockReason}</p> : null}
                        {node.relationHint ? <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><GitBranch className="size-3" />{node.relationHint}</p> : null}
                        {expanded ? <div className="mt-2 border-t border-current/15 pt-2 text-xs">
                          <p>前置知识：{node.prerequisiteIds.length ? node.prerequisiteIds.map((id) => nodeById.get(id)?.label).filter(Boolean).join("、") : "无"}</p>
                          <p className="mt-1">后续知识：{node.successorIds.length ? node.successorIds.map((id) => nodeById.get(id)?.label).filter(Boolean).join("、") : "无"}</p>
                        </div> : null}
                      </button>
                    </div>
                    {node.successorIds.length === 1 ? <div className="ml-3.5 mt-1 h-3 border-l border-dashed border-brand/60" aria-hidden="true" /> : null}
                    {node.successorIds.length > 1 ? <p className="ml-10 mt-2 text-xs font-medium text-brand">完成后会解锁多个后续知识点</p> : null}
                  </li>
                );
              })}
            </ol>
          </article>
        ))}
      </section>
    </div>
  );
}
