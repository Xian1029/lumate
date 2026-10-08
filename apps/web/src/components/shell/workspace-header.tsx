"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, BarChart3, BookOpen, GitBranch, RefreshCw, Search, Settings } from "lucide-react";
import { NotificationBell } from "./notification-bell";
import { ModeSelector } from "@/components/course/mode-selector";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n-context";
import { syncCourse } from "@/lib/api";
import { useCourseStore } from "@/store/course";
import { useWorkspaceStore } from "@/store/workspace";


interface WorkspaceHeaderProps {
  courseName: string;
  courseId?: string;
  backHref?: string;
}

export function getWorkspaceBackHref(pathname: string, courseId?: string): string {
  if (!courseId) return "/";
  const courseRoot = `/course/${courseId}`;
  return pathname !== courseRoot && pathname.startsWith(`${courseRoot}/`) ? courseRoot : "/";
}

export function WorkspaceHeader({
  courseName,
  courseId,
  backHref: backHrefOverride,
}: WorkspaceHeaderProps) {
  const t = useT();
  const pathname = usePathname();
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const fetchContentTree = useCourseStore((s) => s.fetchContentTree);
  const fetchIngestionJobs = useCourseStore((s) => s.fetchIngestionJobs);
  const cognitiveState = useWorkspaceStore((s) => s.cognitiveState);
  const courseRoot = courseId ? `/course/${courseId}` : null;
  const backHref = backHrefOverride ?? getWorkspaceBackHref(pathname, courseId);
  const isCourseSubpage = !!courseRoot && pathname !== courseRoot && pathname.startsWith(`${courseRoot}/`);
  const backLabel = isCourseSubpage ? t("review.backToCourse") : t("nav.back");

  const handleSync = useCallback(async () => {
    if (!courseId || syncing) return;
    setSyncing(true);
    setSyncMessage(null);
    try {
      const result = await syncCourse(courseId);
      const parts: string[] = [];
      if (result.new_files > 0) parts.push(`${result.new_files} 个新文件`);
      if (result.updated_files > 0) parts.push(`${result.updated_files} 个已更新`);
      if (result.unchanged_files > 0) parts.push(`${result.unchanged_files} 个无变化`);
      setSyncMessage(parts.length > 0 ? parts.join("、") : t("ui.up_to_date"));

      // Refresh content tree and jobs
      void fetchContentTree(courseId);
      void fetchIngestionJobs(courseId);

      // Clear message after 4 seconds
      setTimeout(() => setSyncMessage(null), 4000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("ui.sync_failed");
      setSyncMessage(msg);
      setTimeout(() => setSyncMessage(null), 5000);
    } finally {
      setSyncing(false);
    }
  }, [courseId, syncing, fetchContentTree, fetchIngestionJobs, t]);

  return (
    <header
      role="banner"
      aria-label={t("ui.workspace_header")}
      className="sticky top-0 z-50 flex h-12 w-full shrink-0 items-center gap-2 border-b border-border/70 bg-background/95 px-4 shadow-[0_8px_20px_-20px_rgba(22,48,38,0.65)] backdrop-blur-xl supports-[backdrop-filter]:bg-background/85"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Button
          variant="ghost"
          size="icon-xs"
          asChild
          className="shrink-0 text-muted-foreground hover:text-foreground rounded-lg"
          title={backLabel}
        >
          <Link href={backHref} aria-label={backLabel || "Back"} data-testid="workspace-back-link">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>

        <span className="truncate text-sm font-semibold text-foreground">
          {courseName}
        </span>

        {courseId && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground hover:text-foreground rounded-lg"
            title={syncing ? t("ui.syncing") : t("ui.sync_course_content")}
            aria-label={syncing ? t("ui.syncing_course_content") : t("ui.sync_course_content")}
            onClick={handleSync}
            disabled={syncing}
          >
            <RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} />
          </Button>
        )}

        {syncMessage && (
          <span role="status" aria-live="polite" className="text-[11px] text-muted-foreground truncate max-w-[200px] animate-fade-in">
            {syncMessage}
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-1">
        {/* Cognitive state badge */}
        {cognitiveState && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
              cognitiveState.level === "high"
                ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                : cognitiveState.level === "medium"
                  ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                  : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
            }`}
            title={`学习负荷：${Math.round(cognitiveState.score * 100)}%`}
          >
            <span className="size-1.5 rounded-full bg-current" />
            {cognitiveState.level === "high" ? t("workspace.cognitive.high") : cognitiveState.level === "medium" ? t("workspace.cognitive.medium") : t("workspace.cognitive.focused")}
          </span>
        )}

        {/* Learning mode selector */}
        <ModeSelector />

        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground rounded-lg"
          title={t("ui.search_k")}
          aria-label={t("ui.search")}
          onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
        >
          <Search className="size-3.5" />
        </Button>

        <NotificationBell />

        {courseId && (
          <>
            <Link
              href={`/course/${courseId}/notes`}
              className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title={t("ui.notes")}
              aria-label={t("ui.notes")}
            >
              <BookOpen className="size-4" />
            </Link>
            <Link
              href={`/course/${courseId}/graph`}
              className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title={t("ui.knowledge_graph_1")}
              aria-label={t("ui.knowledge_graph_1")}
            >
              <GitBranch className="size-4" />
            </Link>
            <Link
              href={`/course/${courseId}/profile`}
              className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title={t("nav.analytics")}
              aria-label={t("nav.analytics") || "Analytics"}
            >
              <BarChart3 className="size-4" />
            </Link>
          </>
        )}

        <Button
          variant="ghost"
          size="icon-xs"
          asChild
          className="text-muted-foreground hover:text-foreground rounded-lg"
          title={t("ui.settings")}
        >
          <Link href="/settings" aria-label={t("nav.settings") || "设置"}>
            <Settings className="size-3.5" />
          </Link>
        </Button>
      </div>
    </header>
  );
}
