"use client";

import { t } from "@/lib/i18n";
import { getSourceTypeLabel } from "@/lib/display-mappers";
import { useCallback, useEffect, useState } from "react";
import {
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Trash2,
  Play,
  Pause,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  listScrapeSources,
  updateScrapeSource,
  deleteScrapeSource,
  scrapeNow,
  type ScrapeSource,
} from "@/lib/api";
import { toast } from "sonner";

interface SyncSettingsPanelProps {
  courseId: string;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">
        <Clock className="size-3" />
        待处理
      </span>
    );
  }
  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
        <CheckCircle2 className="size-3" />
        同步成功
      </span>
    );
  }
  if (status === "auth_expired") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
        <AlertTriangle className="size-3" />
        登录已过期
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
      <XCircle className="size-3" />
      同步失败
    </span>
  );
}

const INTERVAL_OPTIONS = [
  { value: 1, label: t("ui.every_hour") },
  { value: 6, label: t("ui.every_6h") },
  { value: 12, label: t("ui.every_12h") },
  { value: 24, label: t("ui.every_day") },
  { value: 72, label: t("ui.every_3d") },
  { value: 168, label: t("ui.every_week") },
];

export function SyncSettingsPanel({ courseId }: SyncSettingsPanelProps) {
  const [sources, setSources] = useState<ScrapeSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [scrapingId, setScrapingId] = useState<string | null>(null);

  const fetchSources = useCallback(async () => {
    try {
      const data = await listScrapeSources(courseId);
      setSources(data);
    } catch {
      // silently fail — no sources is fine
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  const handleToggleEnabled = async (source: ScrapeSource) => {
    try {
      const updated = await updateScrapeSource(source.id, {
        enabled: !source.enabled,
      });
      setSources((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      toast.success(updated.enabled ? t("ui.autosync_enabled") : t("ui.autosync_paused"));
    } catch {
      toast.error(t("ui.failed_update_sync"));
    }
  };

  const handleIntervalChange = async (source: ScrapeSource, hours: number) => {
    try {
      const updated = await updateScrapeSource(source.id, {
        interval_hours: hours,
      });
      setSources((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      toast.success(t("ui.sync_interval_updated"));
    } catch {
      toast.error(t("ui.failed_update_interval"));
    }
  };

  const handleScrapeNow = async (source: ScrapeSource) => {
    setScrapingId(source.id);
    try {
      const result = await scrapeNow(source.id);
      toast.success(
        result.content_changed
          ? t("ui.new_content_synced")
          : t("ui.content_uptodate")
      );
      await fetchSources();
    } catch {
      toast.error(t("ui.sync_failed"));
    } finally {
      setScrapingId(null);
    }
  };

  const handleDelete = async (source: ScrapeSource) => {
    try {
      await deleteScrapeSource(source.id);
      setSources((prev) => prev.filter((s) => s.id !== source.id));
      toast.success(t("ui.sync_source_removed"));
    } catch {
      toast.error(t("ui.failed_remove_sync"));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin mr-2" />
        Loading sync settings...
      </div>
    );
  }

  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <RefreshCw className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">{t("ui.auto_sync")}</h3>
      </div>

      <div className="space-y-2">
        {sources.map((source) => (
          <div
            key={source.id}
            className="rounded-xl border border-border/60 p-4 space-y-3"
          >
            {/* Top row: URL + status */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground truncate">
                    {source.label || source.url}
                  </span>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="size-3" />
                  </a>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[11px] text-muted-foreground">
                    {getSourceTypeLabel(source.source_type)}
                  </span>
                  {source.requires_auth && (
                    <span className="text-[11px] text-muted-foreground">
                      · Authenticated
                    </span>
                  )}
                </div>
              </div>
              <StatusBadge status={source.last_status} />
            </div>

            {/* Info row */}
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              {source.last_scraped_at && (
                <span>Last synced: {timeAgo(source.last_scraped_at)}</span>
              )}
              {source.consecutive_failures > 0 && (
                <span className="text-red-500">
                  {source.consecutive_failures} consecutive failures
                </span>
              )}
            </div>

            {/* Controls row */}
            <div className="flex items-center gap-2 flex-wrap">
              {/* Enable/Disable toggle */}
              <Button
                variant={source.enabled ? "outline" : "default"}
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={() => handleToggleEnabled(source)}
              >
                {source.enabled ? (
                  <>
                    <Pause className="size-3" /> Pause
                  </>
                ) : (
                  <>
                    <Play className="size-3" /> Enable
                  </>
                )}
              </Button>

              {/* Sync now */}
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={() => handleScrapeNow(source)}
                disabled={scrapingId === source.id}
              >
                {scrapingId === source.id ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                立即同步
              </Button>

              {/* Interval selector */}
              <select
                className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                value={source.interval_hours}
                onChange={(e) =>
                  handleIntervalChange(source, Number(e.target.value))
                }
              >
                {INTERVAL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>

              {/* Delete */}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-red-600 ml-auto"
                onClick={() => handleDelete(source)}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
