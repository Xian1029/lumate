"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createLearningPlan, createLearningTask, getContentTree, listCourseOverview, planAction, type ContentNode, type CourseOverviewCard, type LearningTaskType } from "@/lib/api";
import { toast } from "sonner";

const taskTypes: Array<{ value: LearningTaskType; label: string }> = [
  { value: "LEARN", label: "学习新内容" },
  { value: "PRACTICE", label: "完成练习" },
  { value: "REVIEW", label: "复习巩固" },
  { value: "NOTE", label: "整理笔记" },
];

/** Creates a usable plan: a draft must contain a first task before review. */
export default function NewLearningPlanPage() {
  const router = useRouter();
  const [courses, setCourses] = useState<CourseOverviewCard[]>([]);
  const [courseId, setCourseId] = useState("");
  const [nodes, setNodes] = useState<ContentNode[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { void listCourseOverview().then(setCourses).catch((error) => toast.error((error as Error).message || "课程加载失败")); }, []);
  useEffect(() => { if (!courseId) { setNodes([]); return; } void getContentTree(courseId).then(setNodes).catch(() => { setNodes([]); toast.error("无法读取课程章节，请稍后重试。"); }); }, [courseId]);
  const chapterOptions = useMemo(() => { const result: Array<{ id: string; label: string }> = []; const visit = (items: ContentNode[], parents: string[]) => items.forEach((node) => { const path = [...parents, node.title]; if (node.children?.length) visit(node.children, path); else if (node.content_category !== "syllabus") result.push({ id: node.id, label: path.join(" / ") }); }); visit(nodes, []); return result; }, [nodes]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const courseId = String(form.get("courseId") || "");
    const title = String(form.get("title") || "").trim();
    const firstTask = String(form.get("firstTask") || "").trim();
    const contentNodeId = String(form.get("contentNodeId") || "");
    if (!courseId || !title || !firstTask || !contentNodeId) { toast.error("请选择学习空间和具体学习章节。"); return; }
    setSubmitting(true);
    try {
      const plan = await createLearningPlan({
        course_id: courseId,
        title,
        description: String(form.get("description") || "").trim() || null,
        target_date: String(form.get("targetDate") || "") || null,
        available_minutes_per_day: Number(form.get("minutes")) || null,
        source: "USER",
      });
      await createLearningTask(plan.id, {
        title: firstTask,
        task_type: String(form.get("taskType") || "LEARN") as LearningTaskType,
        sequence: 1,
        content_node_id: contentNodeId,
        instruction: String(form.get("instruction") || "").trim() || null,
        estimated_minutes: Number(form.get("taskMinutes")) || null,
        required: true,
      });
      await planAction(plan.id, "submit");
      toast.success("计划已创建，请确认后开始执行。");
      router.push(`/learning-plans/${plan.id}/review`);
    } catch (error) {
      toast.error((error as Error).message || "创建计划失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return <main className="mx-auto min-h-screen max-w-2xl bg-background px-4 py-8 sm:px-6"><button type="button" className="text-sm text-brand hover:underline" onClick={() => router.push("/learning-plans")}>← 学习计划中心</button><header className="mt-4"><h1 className="text-2xl font-bold text-foreground">新建学习计划</h1><p className="mt-2 text-sm text-muted-foreground">先选择学习空间和具体学习节；创建后你可以在确认页检查、调整或取消。</p></header><form onSubmit={submit} className="mt-6 space-y-5 rounded-2xl border border-border/70 bg-card p-5"><label className="block text-sm font-medium">学习空间<select name="courseId" value={courseId} onChange={(event) => setCourseId(event.target.value)} required className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="">请选择学习空间</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label><label className="block text-sm font-medium">计划名称<Input name="title" required className="mt-2" placeholder="例如：本周完成有理数基础学习" /></label><label className="block text-sm font-medium">目标日期<Input name="targetDate" type="date" className="mt-2" /></label><label className="block text-sm font-medium">每天预计学习时间（分钟）<Input name="minutes" type="number" min="1" className="mt-2" placeholder="例如 30" /></label><label className="block text-sm font-medium">计划说明<textarea name="description" className="mt-2 min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" placeholder="这段时间想达成什么？" /></label><div className="rounded-xl bg-muted/35 p-4"><p className="text-sm font-semibold">第一项任务</p><p className="mt-1 text-xs text-muted-foreground">任务必须绑定真实课程章节，避免生成无法执行的泛任务。</p><label className="mt-3 block text-sm font-medium">具体学习节<select name="contentNodeId" required disabled={!courseId || !chapterOptions.length} className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="">{courseId ? chapterOptions.length ? "请选择章节" : "暂无可学习章节，请先完成资料解析" : "请先选择学习空间"}</option>{chapterOptions.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label><label className="mt-3 block text-sm font-medium">任务名称<Input name="firstTask" required className="mt-2" placeholder="例如：完成第一节例题与基础练习" /></label><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-sm font-medium">任务类型<select name="taskType" className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{taskTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="text-sm font-medium">预计分钟<Input name="taskMinutes" type="number" min="1" className="mt-2" placeholder="例如 25" /></label></div><label className="mt-3 block text-sm font-medium">完成提示<textarea name="instruction" className="mt-2 min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" placeholder="写清完成标准，例如：完成 10 道基础题并订正。" /></label></div><div className="flex justify-end gap-3"><Button type="button" variant="outline" disabled={submitting} onClick={() => router.push("/learning-plans")}>取消</Button><Button disabled={submitting || courses.length === 0 || !chapterOptions.length}>{submitting ? "正在创建…" : "创建并进入确认"}</Button></div></form></main>;
}
