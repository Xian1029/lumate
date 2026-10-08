"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { postponeLearningTask, startLearningPlan, taskAction, taskStatusLabel, taskTypeLabel, type LearningPlanStatus, type LearningTask } from "@/lib/api";
import { toast } from "sonner";

/** Terminal plans are read-only: completed work is historical fact. */
export function PlanTaskCard({ task, planStatus = "ACTIVE", onChanged }: { task: LearningTask; planStatus?: LearningPlanStatus; onChanged: () => void }) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const executable = planStatus === "ACTIVE" && task.status !== "COMPLETED";
  const act = async (action: "complete" | "skip") => { setWorking(true); try { await taskAction(task.id, action); toast.success(action === "complete" ? "已完成，正在为你准备下一步。" : "任务状态已更新"); onChanged(); } catch (error) { toast.error((error as Error).message || "操作失败，请重试"); } finally { setWorking(false); } };
  const postpone = async () => { const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); setWorking(true); try { await postponeLearningTask(task.id, tomorrow.toISOString()); toast.success("已安排到明天"); onChanged(); } catch (error) { toast.error((error as Error).message || "延后失败，请重试"); } finally { setWorking(false); } };
  const launch = async () => { setWorking(true); try { router.push((await startLearningPlan(task.plan_id)).href); } catch (error) { toast.error((error as Error).message || "暂时无法开始任务，请重试"); } finally { setWorking(false); } };
  return <article className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm"><div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-brand-muted px-2 py-0.5 text-[11px] font-medium text-brand">{taskTypeLabel[task.task_type]}</span><span className="text-[11px] text-muted-foreground">{taskStatusLabel[task.status]}</span></div><h3 className="mt-2 text-sm font-semibold text-foreground">{task.title}</h3>{task.instruction ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{task.instruction}</p> : null}<p className="mt-2 text-xs text-muted-foreground">{task.estimated_minutes ? `预计 ${task.estimated_minutes} 分钟` : "按自己的节奏完成"}</p>{task.status === "COMPLETED" ? <p className="mt-2 text-xs text-muted-foreground">已完成记录会作为学习历史保留。</p> : null}</div><div className="flex shrink-0 flex-wrap gap-2">{executable ? <><Button size="sm" onClick={() => void launch()} disabled={working}>{task.status === "IN_PROGRESS" ? "继续学习" : "开始学习"}</Button>{task.status === "IN_PROGRESS" ? <Button size="sm" variant="outline" onClick={() => void act("complete")} disabled={working}>标记完成</Button> : <Button size="sm" variant="outline" onClick={() => void postpone()} disabled={working}>明天再做</Button>}{!task.required ? <Button size="sm" variant="ghost" onClick={() => void act("skip")} disabled={working}>跳过</Button> : null}</> : null}</div></div></article>;
}
