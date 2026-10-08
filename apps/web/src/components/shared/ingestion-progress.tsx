"use client";

import { t, tf } from "@/lib/i18n";
import { useEffect, useRef, useCallback, useState, type ChangeEvent } from "react";
import { Loader2, AlertCircle, AlertTriangle, X, ExternalLink, Upload } from "lucide-react";
import { toast } from "sonner";
import { useCourseStore } from "@/store/course";
import { uploadFile, type IngestionJobSummary } from "@/lib/api";
import { ACCEPTED_FILE_TYPES } from "@/components/chat/chat-input-utils";

interface IngestionProgressProps {
  courseId: string;
  onIngestionComplete?: () => void;
}

/** Keep one visible state per source even when retry history has many jobs. */
export function latestIngestionJobsBySource(
  jobs: IngestionJobSummary[],
): IngestionJobSummary[] {
  const latest = new Map<string, IngestionJobSummary>();
  const sorted = [...jobs].sort(
    (a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
  );
  for (const job of sorted) {
    const sourceKey = `${job.source_type}:${job.filename.trim().toLocaleLowerCase()}`;
    if (!latest.has(sourceKey)) latest.set(sourceKey, job);
  }
  return [...latest.values()];
}

/** Phase label to user-friendly description mapping. */
function describePhase(job: IngestionJobSummary): string {
  if (job.status === "failed") return t("ui.processing_failed");
  const stats = job.page_stats;
  if (stats && stats.failed_pages && stats.failed_pages.length > 0) {
    const unitLabel = stats.unit === "pages" ? "页" : "部分";
    return `部分内容解析失败，${stats.parsed} / ${stats.total} ${unitLabel}解析成功`;
  }
  if (job.status === "completed") return t("ui.ingestion_ready");
  return job.phase_label || t("ui.processing");
}

/** Check if a failed job is a Canvas 401 / session-expired error. */
function isCanvasSessionError(job: IngestionJobSummary): boolean {
  const msg = job.error_message ?? "";
  return (
    job.status === "failed" &&
    (msg.includes("401") || msg.toLowerCase().includes("session expired") || msg.toLowerCase().includes("re-login"))
  );
}

/** Extract the Canvas domain from an error message like t("ui.canvas_401") */
function extractCanvasDomain(errorMessage: string): string | null {
  const match = errorMessage.match(/401 for ([^\s.]+(?:\.[^\s.]+)+)/);
  return match ? match[1] : null;
}

export function IngestionProgress({ courseId, onIngestionComplete }: IngestionProgressProps) {
  const ingestionJobs = useCourseStore((s) => s.ingestionJobs);
  const fetchIngestionJobs = useCourseStore((s) => s.fetchIngestionJobs);
  const fetchContentTree = useCourseStore((s) => s.fetchContentTree);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevActiveCountRef = useRef(0);
  const [canvasAlertDismissed, setCanvasAlertDismissed] = useState(false);
  const [dismissedFailureIds, setDismissedFailureIds] = useState<Set<string>>(() => new Set());
  const [uploading, setUploading] = useState(false);
  const [replacementTarget, setReplacementTarget] = useState<IngestionJobSummary | null>(null);
  const retryInputRef = useRef<HTMLInputElement>(null);
  const visibleJobs = latestIngestionJobsBySource(ingestionJobs);

  // Determine active (in-progress) jobs
  const activeJobs = visibleJobs.filter((j) =>
    ["pending", "uploaded", "extracting", "classifying", "dispatching"].includes(j.status),
  );
  const failedJobs = visibleJobs.filter(
    (j) => j.status === "failed"
      && j.error_message !== t("ui.no_content_extracted"),
  );

  // Separate Canvas session errors from other failures
  const canvasSessionErrors = failedJobs.filter(isCanvasSessionError);
  const otherFailedJobs = failedJobs.filter((j) => !isCanvasSessionError(j));
  // Completed but partially failed (some pages unreadable) — must warn, never show "解析完成"
  const partialJobs = visibleJobs.filter(
    (j) => j.status === "completed" && j.page_stats && (j.page_stats.failed_pages?.length ?? 0) > 0,
  );

  // Compute aggregate progress for active jobs
  const avgProgress =
    activeJobs.length > 0
      ? Math.round(
          activeJobs.reduce((sum, j) => sum + (j.progress_percent || 0), 0) /
            activeJobs.length,
        )
      : 0;

  const refreshJobs = useCallback(() => {
    void fetchIngestionJobs(courseId);
  }, [courseId, fetchIngestionJobs]);

  const handleReplacementUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    if (replacementTarget && files.length !== 1) {
      toast.error("请一次选择一份替换资料", {
        description: "每条失败记录都需要对应一份重新上传的文件。",
      });
      event.target.value = "";
      return;
    }
    setUploading(true);
    let uploaded = 0;
    try {
      for (const file of files) {
        await uploadFile(courseId, file, undefined, replacementTarget?.id);
        uploaded += 1;
      }
      await fetchIngestionJobs(courseId);
      await fetchContentTree(courseId);
      onIngestionComplete?.();
      toast.success(uploaded > 1 ? `已添加 ${uploaded} 份教材` : "教材已重新添加", {
        description: replacementTarget
          ? "新资料已处理成功，原失败记录已自动清理。"
          : "正在重新整理教材内容。",
      });
    } catch {
      toast.error("这份教材还是没有解析成功", {
        description: "可以检查文件是否能正常打开，或换一份 PDF、Word、PPT 文件。",
      });
      await fetchIngestionJobs(courseId);
    } finally {
      setUploading(false);
      setReplacementTarget(null);
      event.target.value = "";
    }
  };

  const openReplacementUpload = (job?: IngestionJobSummary) => {
    setReplacementTarget(job ?? null);
    retryInputRef.current?.click();
  };

  // Poll while there are active jobs
  useEffect(() => {
    if (activeJobs.length > 0) {
      if (!intervalRef.current) {
        intervalRef.current = setInterval(refreshJobs, 3000);
      }
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [activeJobs.length, refreshJobs]);

  // When active jobs finish (count goes from >0 to 0), refresh content tree
  useEffect(() => {
    if (prevActiveCountRef.current > 0 && activeJobs.length === 0) {
      void fetchContentTree(courseId);
      onIngestionComplete?.();
    }
    prevActiveCountRef.current = activeJobs.length;
  }, [activeJobs.length, courseId, fetchContentTree, onIngestionComplete]);

  // Don't render if there are no active or recent failed jobs
  const recentFailedJobs = otherFailedJobs
    .filter((job) => !dismissedFailureIds.has(job.id))
    .slice(0, 3);
  const showCanvasAlert = canvasSessionErrors.length > 0 && !canvasAlertDismissed;

  if (activeJobs.length === 0 && recentFailedJobs.length === 0 && !showCanvasAlert && partialJobs.length === 0) {
    return null;
  }

  // Extract domain from the first Canvas error for the re-login link
  const canvasDomain = canvasSessionErrors.length > 0
    ? extractCanvasDomain(canvasSessionErrors[0].error_message ?? "")
    : null;
  const canvasLoginUrl = canvasDomain ? `https://${canvasDomain}/login` : null;

  return (
    <div className="grid gap-3" role="status" aria-live="polite">
      {/* Canvas session expired -- warning banner */}
      {showCanvasAlert && (
        <div
          role="alert"
          className="rounded-2xl border border-amber-300/60 bg-amber-50/80 px-4 py-3 text-amber-950 card-shadow"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t("ui.canvas_session_expired")}</p>
              <p className="text-sm text-amber-900/85">
                {t("ui.canvas_session_expired_detail")}
              </p>
              {canvasLoginUrl && (
                <a
                  href={canvasLoginUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-amber-700"
                >
                  <ExternalLink className="size-3" />
                  {t("ui.canvas_relogin")}
                </a>
              )}
            </div>
            <button
              type="button"
              onClick={() => setCanvasAlertDismissed(true)}
              className="mt-0.5 shrink-0 text-amber-600 hover:text-amber-900 transition-colors"
              aria-label={t("ui.dismiss_canvas_session_alert")}
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      {/* Partial parse warnings (some pages failed but the rest succeeded) */}
      {partialJobs.length > 0 && (
        <div
          role="alert"
          className="rounded-2xl border border-amber-300/60 bg-amber-50/80 px-4 py-3 text-amber-950 card-shadow"
        >
          {partialJobs.map((job) => {
            const stats = job.page_stats;
            if (!stats) return null;
            return (
              <div key={job.id} className="flex items-start gap-3 py-1">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">部分内容解析失败</p>
                  <p className="text-xs text-amber-900/85">
                    {job.filename}：{stats.parsed} / {stats.total} 页解析成功，{stats.failed_pages.length} 页待重新处理。
                    这些页面的内容暂时无法用于学习。
                  </p>
                </div>
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => openReplacementUpload()}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
                >
                  <Upload className="size-3" />
                  重新上传
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Active / failed ingestion jobs */}
      {(activeJobs.length > 0 || recentFailedJobs.length > 0) && (
        <div className="rounded-2xl border border-blue-200/60 bg-blue-50/70 px-3 py-2.5 text-sm card-shadow">
          {activeJobs.length > 0 && (
            <div className="flex items-center gap-2">
              <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-600" />
              <span className="text-blue-900">
                {tf("ui.processing_files", { count: activeJobs.length })}
                {avgProgress > 0 && ` (${avgProgress}%)`}
              </span>
            </div>
          )}

          {activeJobs.length > 0 && activeJobs.length <= 3 && (
            <div className="mt-1.5 space-y-1 pl-5">
              {activeJobs.map((job) => (
                <div key={job.id} className="flex items-center gap-2 text-xs text-blue-800/80">
                  <div
                    role="progressbar"
                    aria-label={tf("ui.file_progress", { filename: job.filename, percent: job.progress_percent ?? 0 })}
                    className="h-2.5 w-16 overflow-hidden rounded-full bg-blue-200"
                  >
                    <div
                      className="h-full rounded-full bg-brand transition-all duration-500"
                      style={{ width: `${job.progress_percent || 0}%` }}
                    />
                  </div>
                  <span className="truncate">
                    {job.filename}: {describePhase(job)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {activeJobs.length === 0 && recentFailedJobs.length > 0 && (
            <div className="space-y-2" role="alert">
              {recentFailedJobs.map((job) => (
                <div key={job.id} className="flex flex-col gap-2 rounded-xl bg-white/70 px-3 py-2 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-start gap-2 text-red-800">
                    <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                    <div className="min-w-0">
                      <p className="truncate font-medium">{job.filename}</p>
                      <p className="mt-0.5 text-xs text-red-700/80">这份教材暂时未能解析，请重新上传或换一份文件。</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      disabled={uploading}
                      onClick={() => openReplacementUpload(job)}
                      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-60"
                    >
                      {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                      {uploading ? "正在上传…" : "重新上传"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDismissedFailureIds((current) => new Set(current).add(job.id))}
                      className="inline-flex size-8 items-center justify-center rounded-lg text-red-500 transition-colors hover:bg-red-50 hover:text-red-700"
                      aria-label={`关闭 ${job.filename} 的解析失败提示`}
                      title="关闭提示"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <input
        ref={retryInputRef}
        type="file"
        multiple={!replacementTarget}
        accept={ACCEPTED_FILE_TYPES}
        className="hidden"
        aria-label="重新选择要上传的教材"
        onChange={(event) => void handleReplacementUpload(event)}
      />
    </div>
  );
}
