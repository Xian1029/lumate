"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, FileClock, Loader2, Upload, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { clearFailedIngestionJobs, listAllIngestionJobs, uploadFile, type GlobalIngestionJob } from "@/lib/api";
import { toast } from "sonner";
import { getProcessingStatusLabel } from "@/lib/display-mappers";

function statusIcon(job: GlobalIngestionJob) {
  if (job.status === "failed") return <XCircle className="size-4 text-red-500" />;
  if (job.status === "embedding") return <CheckCircle2 className="size-4 text-emerald-500" />;
  if (job.status === "completed") {
    if (job.page_stats && (job.page_stats.failed_pages?.length ?? 0) > 0) {
      return <AlertTriangle className="size-4 text-amber-500" />;
    }
    return <CheckCircle2 className="size-4 text-emerald-500" />;
  }
  return <Loader2 className="size-4 animate-spin text-brand" />;
}

function statusText(job: GlobalIngestionJob): string {
  const stats = job.page_stats;
  if (job.status === "completed" && stats && (stats.failed_pages?.length ?? 0) > 0) {
    return `部分内容解析失败 · ${stats.parsed} / ${stats.total} 页成功`;
  }
  if (job.status === "failed") return "解析失败";
  if (job.status === "embedding") return "资料已可学习 · 正在建立检索索引";
  return getProcessingStatusLabel(job.status);
}

export default function ProcessingCenterPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<GlobalIngestionJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [clearingFailures, setClearingFailures] = useState(false);
  const [replacementTarget, setReplacementTarget] = useState<GlobalIngestionJob | null>(null);
  const replacementInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await listAllIngestionJobs(100);
      setJobs(data);
    } catch {
      toast.error("资料列表加载失败", { description: "请稍后重试。" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Poll while any job is in flight
    const timer = setInterval(() => {
      setJobs((current) => {
        if (current.some((j) => ["pending", "uploaded", "extracting", "classifying", "dispatching"].includes(j.status))) {
          void load();
        }
        return current;
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const openReplacementUpload = (job: GlobalIngestionJob) => {
    if (!job.course_id) {
      toast.error("无法重新上传", { description: "这条旧资料没有关联学习空间，请在对应课程中重新上传。" });
      return;
    }
    setReplacementTarget(job);
    replacementInputRef.current?.click();
  };

  const handleReplacementUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const target = replacementTarget;
    if (!file || !target?.course_id) return;

    setRetrying(target.id);
    try {
      await uploadFile(target.course_id, file, undefined, target.id);
      toast.success("资料已重新上传", { description: "新资料处理成功，原失败记录已自动清理。" });
      await load();
    } catch {
      toast.error("重新上传未成功", { description: "原失败记录仍会保留，你可以换一份文件后再试。" });
      await load();
    } finally {
      setRetrying(null);
      setReplacementTarget(null);
      event.target.value = "";
    }
  };

  const clearHistoricalFailures = async () => {
    const failedCount = jobs.filter((job) => job.status === "failed").length;
    if (!failedCount) return;
    if (!window.confirm(`确认清除 ${failedCount} 条历史失败记录吗？已成功的资料和学习内容不会受到影响。`)) return;
    setClearingFailures(true);
    try {
      const result = await clearFailedIngestionJobs();
      toast.success(`已清除 ${result.deleted_count} 条失败记录`);
      await load();
    } catch {
      toast.error("清除失败记录失败", { description: "请稍后再试。" });
    } finally {
      setClearingFailures(false);
    }
  };

  const failedCount = jobs.filter((job) => job.status === "failed").length;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <button
        type="button"
        onClick={() => router.push("/")}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> 返回首页
      </button>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-xl bg-brand-muted text-brand">
          <FileClock className="size-5" />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-foreground">资料处理中心</h1>
          <p className="text-sm text-muted-foreground">查看所有上传资料的解析状态，失败的内容可以重新处理。</p>
        </div>
        </div>
        {failedCount > 0 ? <button type="button" disabled={clearingFailures} onClick={() => void clearHistoricalFailures()} className="rounded-lg border border-destructive/30 px-3 py-2 text-xs font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-60">{clearingFailures ? "正在清除…" : `清除 ${failedCount} 条失败记录`}</button> : null}
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 正在加载资料列表……
        </div>
      ) : jobs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border px-6 py-16 text-center">
          <p className="text-sm font-medium text-foreground">还没有上传过资料</p>
          <p className="mt-1 text-xs text-muted-foreground">去首页创建学习空间并上传教材。</p>
          <button
            type="button"
            onClick={() => router.push("/new")}
            className="mt-4 inline-flex h-9 items-center rounded-full bg-brand px-4 text-sm font-semibold text-brand-foreground"
          >
            上传学习资料
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {jobs.map((job) => (
            <li
              key={job.id}
              className="flex items-start gap-3 rounded-xl border border-border/70 bg-card px-4 py-3"
            >
              <span className="mt-0.5 shrink-0">{statusIcon(job)}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{job.filename || "(未命名)"}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {statusText(job)}
                  {job.category ? ` · ${job.category === "textbook" ? "教材" : job.category === "assignment" ? "作业" : job.category === "notes" ? "笔记" : job.category === "lecture_slides" ? "课件" : job.category === "exam_schedule" ? "考试安排" : job.category === "syllabus" ? "教学大纲" : "其他"}` : ""}
                  {job.nodes_created > 0 ? ` · 生成 ${job.nodes_created} 个内容节点` : ""}
                </p>
                {!["completed", "failed", "embedding"].includes(job.status) && (
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-brand transition-all"
                      style={{ width: `${job.progress_percent || 0}%` }}
                    />
                  </div>
                )}
              </div>
              {job.status === "failed" && (
                <button
                  type="button"
                  disabled={retrying === job.id}
                  onClick={() => openReplacementUpload(job)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-brand/30 bg-brand-muted px-3 py-1.5 text-xs font-medium text-brand hover:bg-brand-muted/70 disabled:opacity-60"
                >
                  {retrying === job.id ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                  重新上传
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <input
        ref={replacementInputRef}
        type="file"
        className="hidden"
        aria-label="选择替换资料"
        onChange={(event) => void handleReplacementUpload(event)}
      />
    </div>
  );
}
