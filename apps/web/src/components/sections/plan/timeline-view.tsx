"use client";

import { useEffect, useMemo, useState } from "react";
import { listStudyGoals, updateStudyGoal, type StudyGoal } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface TimelineViewProps {
  courseId: string;
}

type Urgency = "overdue" | "soon" | "normal" | "future";

function getUrgency(daysLeft: number): Urgency {
  if (daysLeft < 0) return "overdue";
  if (daysLeft <= 7) return "soon";
  if (daysLeft <= 30) return "normal";
  return "future";
}

function formatDaysLeft(daysLeft: number): string {
  if (daysLeft < 0) return `${Math.abs(daysLeft)}天前过期`;
  if (daysLeft === 0) return "今天";
  if (daysLeft === 1) return "明天";
  return `${daysLeft}天后`;
}

export function TimelineView({ courseId }: TimelineViewProps) {
  const [goals, setGoals] = useState<StudyGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    listStudyGoals(courseId)
      .then((g) => setGoals(g))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [courseId]);

  const today = useMemo(() => new Date(), []);

  // Sort goals with deadlines, then without
  const sorted = useMemo(() => {
    const visible = goals.filter((g) => g.status !== "archived");
    const withDate = visible
      .filter((g) => g.target_date)
      .sort((a, b) => new Date(a.target_date!).getTime() - new Date(b.target_date!).getTime());
    const withoutDate = visible.filter((g) => !g.target_date);
    return [...withDate, ...withoutDate];
  }, [goals]);

  const updateGoal = async (goal: StudyGoal, action: "complete" | "delay" | "restore") => {
    setActingId(goal.id);
    try {
      const date = goal.target_date ? new Date(goal.target_date) : new Date();
      if (action === "delay") date.setDate(date.getDate() + 1);
      const updated = await updateStudyGoal(goal.id, action === "complete"
        ? { status: "completed" }
        : action === "restore"
          ? { status: "active" }
          : { status: "active", target_date: date.toISOString().split("T")[0] });
      setGoals((current) => current.map((item) => item.id === updated.id ? updated : item));
      toast.success(action === "complete" ? "任务已完成" : action === "delay" ? "已延后 1 天" : "任务已恢复");
    } catch (error) {
      toast.error((error as Error).message || "操作失败，请稍后再试");
    } finally {
      setActingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-2 text-center p-6">
        <p className="text-sm text-muted-foreground">暂无学习目标</p>
        <p className="text-xs text-muted-foreground">在计划视图中添加目标，时间线将显示在这里</p>
      </div>
    );
  }

  // Build time extent for the timeline bar (from earliest to latest + 7d buffer)
  const goalsWithDate = sorted.filter((g) => g.target_date);
  const earliestMs = goalsWithDate.length > 0
    ? Math.min(today.getTime(), new Date(goalsWithDate[0].target_date!).getTime())
    : today.getTime();
  const latestMs = goalsWithDate.length > 0
    ? new Date(goalsWithDate[goalsWithDate.length - 1].target_date!).getTime() + 7 * 86_400_000
    : today.getTime() + 30 * 86_400_000;
  const spanMs = Math.max(latestMs - earliestMs, 1);

  const positionPct = (dateMs: number) =>
    Math.min(100, Math.max(0, ((dateMs - earliestMs) / spanMs) * 100));

  const todayPct = positionPct(today.getTime());

  return (
    <div className="flex flex-col gap-6 p-4 overflow-auto">
      {/* Timeline header */}
      <div className="relative">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          时间线
        </div>

        {/* Timeline axis */}
        <div className="relative h-2 rounded-full bg-muted/40">
          {/* Today marker */}
          <div
            className="absolute top-1/2 -translate-y-1/2 w-0.5 h-5 bg-brand rounded-full z-10"
            style={{ left: `${todayPct}%` }}
            title="今天"
          />
          {/* Goal markers */}
          {goalsWithDate.map((g) => {
            const ms = new Date(g.target_date!).getTime();
            const pct = positionPct(ms);
            const daysLeft = Math.ceil((ms - today.getTime()) / 86_400_000);
            const urgency = getUrgency(daysLeft);
            const color =
              urgency === "overdue"
                ? "bg-destructive"
                : urgency === "soon"
                  ? "bg-warning"
                  : urgency === "normal"
                    ? "bg-brand"
                    : "bg-muted-foreground";
            return (
              <div
                key={g.id}
                className={`absolute top-1/2 -translate-y-1/2 size-3 rounded-full ${color} ring-2 ring-background z-10`}
                style={{ left: `${pct}%`, transform: "translate(-50%, -50%)" }}
                title={`${g.title}: ${formatDaysLeft(daysLeft)}`}
              />
            );
          })}
        </div>

        {/* Date labels */}
        <div className="flex justify-between mt-1 text-[10px] text-muted-foreground">
          <span>{new Date(earliestMs).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</span>
          <span className="text-brand font-medium">今天</span>
          <span>{new Date(latestMs).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</span>
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-muted/20 p-3 text-xs leading-5 text-muted-foreground">
        按日期查看接下来要做什么。完成后会保留在时间线中；需要更多时间可延后，误点完成也可以恢复。
      </div>

      {/* Goal rows */}
      <div className="space-y-2">
        {sorted.map((goal) => {
          const hasDate = !!goal.target_date;
          const daysLeft = hasDate
            ? Math.ceil((new Date(goal.target_date!).getTime() - today.getTime()) / 86_400_000)
            : null;
          const urgency = daysLeft !== null ? getUrgency(daysLeft) : "future";
          const dotColor =
            urgency === "overdue"
              ? "bg-destructive"
              : urgency === "soon"
                ? "bg-warning"
                : urgency === "normal"
                  ? "bg-brand"
                  : "bg-muted-foreground/40";

          return (
            <div
              key={goal.id}
              className="flex items-center gap-3 rounded-xl bg-muted/20 p-3.5 hover:bg-muted/30 transition-colors"
            >
              {/* Status dot */}
              <div className={`size-2.5 rounded-full shrink-0 ${dotColor}`} />

              {/* Goal info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{goal.title}</p>
                  {goal.status === "completed" && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-success-muted text-success font-medium shrink-0">
                      完成
                    </span>
                  )}
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{goal.objective}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {goal.metadata_json?.source === "assistant" ? "小助手安排" : "我创建的任务"}
                  {typeof goal.metadata_json?.plan_day === "number" ? ` · 第 ${goal.metadata_json.plan_day} 天` : ""}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {goal.status === "completed" ? (
                    <Button size="sm" variant="outline" disabled={actingId === goal.id} onClick={() => void updateGoal(goal, "restore")}>恢复任务</Button>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" disabled={actingId === goal.id} onClick={() => void updateGoal(goal, "delay")}>延后 1 天</Button>
                      <Button size="sm" disabled={actingId === goal.id} onClick={() => void updateGoal(goal, "complete")}>标记完成</Button>
                    </>
                  )}
                </div>
              </div>

              {/* Deadline */}
              <div className="shrink-0 text-right">
                {hasDate && daysLeft !== null ? (
                  <>
                    <p
                      className={`text-xs font-medium tabular-nums ${
                        urgency === "overdue"
                          ? "text-destructive"
                          : urgency === "soon"
                            ? "text-warning"
                            : "text-muted-foreground"
                      }`}
                    >
                      {formatDaysLeft(daysLeft)}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(goal.target_date!).toLocaleDateString("zh-CN", {
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">无截止日期</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-[11px] text-muted-foreground pt-2 border-t border-border/40">
        <div className="flex items-center gap-1.5">
          <div className="size-2 rounded-full bg-destructive" />
          <span>已逾期</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="size-2 rounded-full bg-warning" />
          <span>7天内</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="size-2 rounded-full bg-brand" />
          <span>30天内</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="size-2 rounded-full bg-muted-foreground/40" />
          <span>较远</span>
        </div>
      </div>
    </div>
  );
}
