"use client";

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { BookOpen, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Loader2 } from "lucide-react";
import { getContentTree, type ContentNode, type UploadPlan, type ProcessingWorkflowState } from "@/lib/api";
import type { FileItem, ParseLog, ParseStep } from "./types";
import { StepIndicator } from "./step-indicator";

interface Props {
  projectName: string; url: string; files: FileItem[]; parseSteps: ParseStep[]; parseProgress: number; parseLogs: ParseLog[];
  canContinueToFeatures: boolean; allJobsFailed: boolean; hasFailedJobs: boolean; processingState: ProcessingWorkflowState; readyCourseIds: string[]; createdCourseId: string | null; createdCourseIds: string[];
  uploadPlan: UploadPlan | null; onConfirmParsedSpaces: () => void; onEnterWorkspace: (courseId?: string) => void; onReturnToUpload: () => void; t: (key: string) => string;
}

/** Uses the saved ContentNode tree, which is also the tree used in the space. */
export function ParsingProgressStep(props: Props) {
  const { createdCourseIds, createdCourseId, canContinueToFeatures } = props;
  const ids = useMemo(() => createdCourseIds.length ? createdCourseIds : createdCourseId ? [createdCourseId] : [], [createdCourseId, createdCourseIds]);
  const [trees, setTrees] = useState<Record<string, ContentNode[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!canContinueToFeatures || !ids.length) return;
    let alive = true;
    void Promise.all(ids.map(async (id) => [id, await getContentTree(id)] as const)).then((entries) => {
      if (alive) setTrees(Object.fromEntries(entries));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [canContinueToFeatures, ids]);

  const successful = props.processingState === "READY" || props.processingState === "PARTIALLY_READY";
  // On partial completion only show trees that are actually ready.  Rendering
  // every provisional course creates blank panels and the misleading spinner
  // shown in the old flow.
  const previewIds = props.processingState === "PARTIALLY_READY" ? props.readyCourseIds : ids;
  const stateTitle: Record<ProcessingWorkflowState, string> = {
    UPLOADED: "正在接收资料", CLASSIFYING: "正在识别资料类型", NEEDS_CLASSIFICATION_CONFIRMATION: "等待确认资料归属", CLASSIFIED: "已完成资料分类", DETECTING_STRUCTURE: "正在读取教材目录", PARSING: "正在整理章节", PARTIALLY_READY: "部分学习空间已准备好", READY: "请确认教材目录", FAILED_RETRYABLE: "资料需要重新处理", FAILED_FINAL: "资料暂时无法处理", CANCELLED: "本次创建已取消",
  };
  return <div className="min-h-screen bg-muted/30 animate-in fade-in duration-300">
    <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-border bg-background/95 px-6 py-3 backdrop-blur">
      <BookOpen className="size-5 text-brand" /><div><p className="text-sm font-semibold">教材识别结果</p><p className="text-xs text-muted-foreground">{props.projectName || "新学习空间"}</p></div>
      <div className="ml-auto"><StepIndicator currentStep="parsing" t={props.t} /></div>
    </header>
    <main className="mx-auto max-w-6xl space-y-5 px-5 py-7">
      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><h1 className="text-xl font-bold">{stateTitle[props.processingState]}</h1><p className="mt-1 text-sm text-muted-foreground">目录按上传资料原始结构保存；AI 只会在章节下补充学习内容，不会重排教材章节。</p></div>
          <div className="min-w-44"><div className="flex justify-between text-xs text-muted-foreground"><span>解析进度</span><span>{props.parseProgress}%</span></div><div className="mt-2 h-2 rounded-full bg-muted"><div className="h-2 rounded-full bg-brand transition-all" style={{ width: `${props.parseProgress}%` }} /></div></div>
        </div>
        <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{props.parseSteps.map((step) => <div key={step.label} className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm"><StatusIcon status={step.status} /><span>{step.label}</span></div>)}</div>
      </section>
      {props.hasFailedJobs ? <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive"><span><CircleAlert className="mr-2 inline size-4" />有资料未完成解析；已准备好的学习内容仍可先使用。请重新上传失败资料。</span><button type="button" onClick={props.onReturnToUpload} className="rounded-lg border border-destructive/40 bg-background px-3 py-2 text-xs font-semibold">重新上传失败资料</button></section> : null}
      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm"><div className="border-b border-border px-5 py-4"><h2 className="font-semibold">教材目录与章节预览</h2><p className="mt-1 text-xs text-muted-foreground">可展开查看章、节和学习内容。较长目录可在此区域滚动。</p></div><div className="max-h-[54vh] overflow-y-auto p-4">{!successful ? <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在读取目录…</div> : previewIds.map((id) => <DirectoryPreview key={id} title={props.projectName || "学习空间"} nodes={trees[id] ?? []} expanded={expanded} setExpanded={setExpanded} />)}</div></section>
      {props.processingState === "READY" && <section className="flex flex-col gap-3 rounded-2xl border border-brand/25 bg-brand-muted/20 p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">解析结果已准备好</p><p className="text-sm text-muted-foreground">确认后将创建并发布 {ids.length || 1} 个学习空间。</p></div><button data-testid="confirm-create-spaces" type="button" onClick={props.onConfirmParsedSpaces} className="h-11 rounded-lg bg-brand px-5 text-sm font-semibold text-brand-foreground hover:opacity-90">确认解析结果，创建学习空间</button></section>}
      {props.processingState === "PARTIALLY_READY" && <section className="rounded-2xl border border-brand/25 bg-brand-muted/20 p-5"><p className="font-semibold">已有学习空间可以开始使用</p><p className="mt-1 text-sm text-muted-foreground">其余资料仍会保留处理状态，不会阻止你先学习已准备好的内容。</p><div className="mt-3 flex flex-wrap gap-2">{props.readyCourseIds.map((id, index) => <button key={id} type="button" onClick={() => props.onEnterWorkspace(id)} className="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-brand-foreground">先进入{props.uploadPlan?.groups[index]?.suggested_name ?? "已准备好的学习空间"}</button>)}<button type="button" onClick={props.onReturnToUpload} className="h-10 rounded-lg border border-border px-4 text-sm">继续处理剩余资料</button></div></section>}
      {props.parseLogs.length > 0 && <details className="rounded-xl border border-border bg-card px-4 py-3 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">查看解析记录</summary><div className="mt-3 space-y-1">{props.parseLogs.map((log, index) => <p className={log.color} key={index}>{log.text}</p>)}</div></details>}
    </main></div>;
}
function StatusIcon({ status }: { status: ParseStep["status"] }) { return status === "done" ? <CheckCircle2 className="size-4 text-success" /> : status === "active" ? <Loader2 className="size-4 animate-spin text-brand" /> : <span className="size-4 rounded-full border border-border" />; }
function DirectoryPreview({ title, nodes, expanded, setExpanded }: { title: string; nodes: ContentNode[]; expanded: Record<string, boolean>; setExpanded: Dispatch<SetStateAction<Record<string, boolean>>> }) { return <div className="mb-5 rounded-xl border border-border bg-background last:mb-0"><div className="border-b border-border px-4 py-3 text-sm font-semibold">{title}</div>{nodes.length ? <div className="p-2">{nodes.map((node) => <TreeNode key={node.id} node={node} depth={0} expanded={expanded} setExpanded={setExpanded} />)}</div> : <p className="p-5 text-sm text-muted-foreground">目录尚在整理中；完成前不会发布该学习空间。</p>}</div>; }
function TreeNode({ node, depth, expanded, setExpanded }: { node: ContentNode; depth: number; expanded: Record<string, boolean>; setExpanded: Dispatch<SetStateAction<Record<string, boolean>>> }) { const hasChildren = node.children.length > 0; const open = expanded[node.id] ?? depth < 1; return <div><button type="button" onClick={() => hasChildren && setExpanded((current) => ({ ...current, [node.id]: !open }))} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted" style={{ paddingLeft: `${8 + depth * 20}px` }}><span className="w-4 text-muted-foreground">{hasChildren ? open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" /> : "·"}</span><span className="font-medium">{node.title}</span><span className="ml-auto text-[11px] text-muted-foreground">{node.content_category === "textbook" ? "教材" : ""}</span></button>{hasChildren && open && node.children.map((child) => <TreeNode key={child.id} node={child} depth={depth + 1} expanded={expanded} setExpanded={setExpanded} />)}</div>; }
