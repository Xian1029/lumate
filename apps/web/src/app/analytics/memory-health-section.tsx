import { t } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MemoryStats } from "@/lib/api";
import { getMemoryTypeLabel } from "@/lib/display-mappers";

interface MemoryHealthSectionProps {
  memStats: MemoryStats;
  consolidating: boolean;
  onConsolidate: () => void;
}

export function MemoryHealthSection({
  memStats,
  consolidating,
  onConsolidate,
}: MemoryHealthSectionProps) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-medium text-foreground">{t("ui.memory_health")}</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={onConsolidate}
          disabled={consolidating}
        >
          {consolidating ? t("ui.consolidating") : "整理记忆"}
        </Button>
      </div>
      <div className="grid sm:grid-cols-4 gap-4">
        <div className="text-center">
          <div className="text-2xl font-semibold text-foreground">{memStats.total}</div>
          <div className="text-xs text-muted-foreground">{t("ui.total_memories")}</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-semibold text-foreground">{(memStats.avg_importance * 100).toFixed(0)}%</div>
          <div className="text-xs text-muted-foreground">{t("ui.avg_importance")}</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-semibold text-foreground">{memStats.merged_count}</div>
          <div className="text-xs text-muted-foreground">{t("ui.merged")}</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-semibold text-foreground">{memStats.uncategorized}</div>
          <div className="text-xs text-muted-foreground">{t("ui.uncategorized")}</div>
        </div>
      </div>
      {Object.keys(memStats.by_type).length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {Object.entries(memStats.by_type).map(([type, count]) => (
            <Badge key={type} variant="secondary">
              {getMemoryTypeLabel(type)}：{count}
            </Badge>
          ))}
        </div>
      )}
    </section>
  );
}
