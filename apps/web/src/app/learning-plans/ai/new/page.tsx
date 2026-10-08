"use client";

import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createLearningPlan, getContentTree, listCourseOverview, planAction, regenerateLearningPlan, type ContentNode, type CourseOverviewCard } from "@/lib/api";
import { toast } from "sonner";

function isMaterialContainer(node: ContentNode): boolean {
  return node.type === "file" || (node.level === 0 && !node.content?.trim() && node.children.length > 0);
}

function flatten(nodes: ContentNode[], depth = 0, parentIds: string[] = []): Array<{ node: ContentNode; depth: number; parentIds: string[] }> {
  return nodes.flatMap((node) => [{ node, depth, parentIds }, ...flatten(node.children ?? [], depth + 1, [...parentIds, node.id])]);
}

function descendantIds(node: ContentNode): string[] {
  return [node.id, ...(node.children ?? []).flatMap(descendantIds)];
}

function materialLabel(title: string): string {
  return title.replace(/\.(pdf|docx?|pptx?)$/i, "").replace(/\s+/g, " ").trim();
}

function localDateValue(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function AiLearningPlanForm() {
  const router = useRouter(); const searchParams = useSearchParams();
  const [courses, setCourses] = useState<CourseOverviewCard[]>([]); const [working, setWorking] = useState(false); const [nodes, setNodes] = useState<ContentNode[]>([]); const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const preferredCourse = searchParams.get("courseId") || "";
  useEffect(() => { void listCourseOverview().then(setCourses).catch(() => toast.error("学习空间加载失败，请稍后再试。")); }, []);
  useEffect(() => { setNodes([]); setSelectedIds([]); if (preferredCourse) void getContentTree(preferredCourse).then(setNodes).catch(() => toast.error("教材目录加载失败，请稍后再试。")); }, [preferredCourse]);
  const materialGroups = useMemo(() => {
    // A PDF/document root identifies source material, not a study chapter.
    // Show it only as a group heading so similarly numbered chapters from
    // several textbooks remain distinguishable without becoming a task.
    const groups = nodes.map((root, index) => ({
      id: root.id,
      label: isMaterialContainer(root) ? materialLabel(root.title) : nodes.length > 1 ? `学习资料 ${index + 1}` : "教材章节",
      items: flatten(isMaterialContainer(root) ? root.children : [root]).filter(
        ({ node }) => node.title.trim() && node.content_category !== "reference" && node.content_category !== "other",
      ),
    })).filter((group) => group.items.length > 0);
    return groups;
  }, [nodes]);
  const items = useMemo(() => materialGroups.flatMap((group) => group.items), [materialGroups]);
  const itemById = useMemo(() => new Map(items.map((item) => [item.node.id, item])), [items]);
  const toggle = (id: string) => setSelectedIds((current) => {
    const item = itemById.get(id); if (!item) return current;
    const subtree = new Set(descendantIds(item.node));
    if (!current.includes(id)) return [...new Set([...current, ...subtree, ...item.parentIds])];
    const next = current.filter((value) => !subtree.has(value));
    // An ancestor is merely a grouping selection while at least one selected
    // child remains. Remove empty ancestor paths so the UI stays truthful.
    return next.filter((value) => {
      const candidate = itemById.get(value);
      return !candidate || candidate.node.children.length === 0 || items.some((other) => other.parentIds.includes(value) && next.includes(other.node.id));
    });
  });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const courseId = String(form.get("courseId") || ""); const targetDate = String(form.get("targetDate") || "");
    if (!courseId || !selectedIds.length || !targetDate) return;
    setWorking(true);
    try {
      // selectedIds also contains visual ancestor markers. Send only the
      // deepest selected nodes, otherwise selecting one section plus its
      // highlighted chapter would make the backend expand every sibling.
      const taskNodeIds = selectedIds.filter((id) => !items.some(
        ({ node, parentIds }) => selectedIds.includes(node.id) && parentIds.includes(id),
      ));
      const labels = items.filter(({ node }) => taskNodeIds.includes(node.id)).map(({ node }) => node.title);
      const plan = await createLearningPlan({ course_id: courseId, title: `学习${labels.slice(0, 2).map((label) => `「${label}」`).join("、")}${labels.length > 2 ? "等内容" : ""}`, description: `仅围绕所选教材章节安排：${labels.join("、")}`, target_date: targetDate, available_minutes_per_day: Number(form.get("minutes")) || 30, source: "AI", draft_payload: { selected_content_node_ids: taskNodeIds, selection_labels: labels } }); await regenerateLearningPlan(plan.id); await planAction(plan.id, "submit"); router.push(`/learning-plans/${plan.id}/review`);
    }
    catch (error) { toast.error((error as Error).message || "暂时没能安排任务，请确认这个学习空间已有章节内容。"); }
    finally { setWorking(false); }
  };
  // A date input represents the learner's local calendar day. Using
  // toISOString() here made the default become "yesterday" before 08:00 in
  // China because it converts the value to UTC first.
  const today = localDateValue();
  return <main className="mx-auto min-h-screen max-w-2xl bg-background px-4 py-8 sm:px-6"><button type="button" className="text-sm font-medium text-brand hover:underline" onClick={() => router.push(preferredCourse ? `/course/${preferredCourse}` : "/learning-plans")}>← 返回学习空间</button><h1 className="mt-5 text-2xl font-bold text-foreground">帮我安排学习</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">选择本次要完成的教材章节；计划只会围绕已选内容生成，并在确认后才开始执行。</p><form onSubmit={submit} className="mt-6 space-y-5 rounded-2xl border border-border bg-card p-5"><label className="block text-sm font-semibold">学习哪个学习空间？<select name="courseId" value={preferredCourse} onChange={(event) => router.replace(`/learning-plans/ai/new?courseId=${event.target.value}`)} required className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3">{!preferredCourse && <option value="">请选择学习空间</option>}{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label><fieldset><legend className="text-sm font-semibold">本次想完成的学习章节内容 <span className="text-destructive">*</span></legend><p className="mt-1 text-xs text-muted-foreground">支持多选。选择章会包含其全部小节；单独选择小节时会标记所属章节，但任务只围绕实际选中的章节内容生成。</p><div className="mt-2 max-h-72 space-y-3 overflow-y-auto rounded-xl border border-border p-2">{materialGroups.length ? materialGroups.map((group) => <section key={group.id} aria-label={group.label}><h2 className="sticky top-0 z-10 rounded-md bg-muted px-2 py-1.5 text-xs font-semibold text-muted-foreground">{group.label}</h2><div className="mt-1 space-y-1">{group.items.map(({ node, depth }) => <label key={node.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 hover:bg-muted" style={{ paddingLeft: `${8 + depth * 18}px` }}><input type="checkbox" checked={selectedIds.includes(node.id)} onChange={() => toggle(node.id)} /><span className={depth === 0 ? "font-semibold" : "text-sm"}>{node.title}</span></label>)}</div></section>) : <p className="p-3 text-sm text-muted-foreground">请先选择含已解析教材的学习空间。</p>}</div></fieldset><label className="block text-sm font-semibold">希望哪天完成？<Input name="targetDate" type="date" required min={today} defaultValue={today} className="mt-2" /><span className="mt-1 block text-xs font-normal text-muted-foreground">默认今天；不修改时，生成的任务均安排在今天。</span></label><label className="block text-sm font-semibold">每天学习时长（分钟）<select name="minutes" defaultValue="30" className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3"><option value="30">30 分钟</option><option value="45">45 分钟</option><option value="60">60 分钟</option></select></label><Button disabled={working || !selectedIds.length}>{working ? "正在为你安排…" : "生成学习安排"}</Button></form></main>;
}

export default function AiLearningPlanPage() {
  return <Suspense fallback={<main className="min-h-screen bg-background" />}><AiLearningPlanForm /></Suspense>;
}
