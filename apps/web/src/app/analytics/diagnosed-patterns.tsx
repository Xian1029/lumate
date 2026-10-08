import { t } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { getDiagnosisTypeLabel } from "@/lib/display-mappers";

interface DiagnosedPatternsProps {
  diagnosisBreakdown: Record<string, number>;
}

export function DiagnosedPatterns({ diagnosisBreakdown }: DiagnosedPatternsProps) {
  const entries = Object.entries(diagnosisBreakdown).sort((a, b) => b[1] - a[1]);

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="font-medium mb-4 text-foreground">{t("ui.diagnosed_patterns")}</h2>
      <div className="flex flex-wrap gap-2" data-testid="analytics-breakdown-diagnoses">
        {entries.length > 0 ? (
          entries.map(([name, count]) => (
            <Badge key={name} variant="secondary">
              {getDiagnosisTypeLabel(name)}：{count}
            </Badge>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">{t("ui.no_diagnosis_data_yet")}</p>
        )}
      </div>
    </section>
  );
}
