"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, LayoutTemplate, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useT, useTF } from "@/lib/i18n-context";
import { applyTemplate, listTemplates, type LearningTemplate } from "@/lib/api";

const BUILTIN_KEYS: Record<string, string> = {
  "STEM Student": "stem",
  "Humanities Scholar": "humanities",
  "Language Learner": "language",
  "Visual Learner": "visual",
  "Quick Reviewer": "quick",
};

const EFFECT_DIMENSIONS = ["note_format", "detail_level", "quiz_difficulty", "visual_preference"] as const;

export function TemplatesSection() {
  const t = useT();
  const tf = useTF();
  const [templates, setTemplates] = useState<LearningTemplate[]>([]);
  const [applying, setApplying] = useState<string | null>(null);
  const [appliedTemplateId, setAppliedTemplateId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("lumate_applied_learning_template");
  });

  useEffect(() => {
    void loadTemplates();
  }, []);

  async function loadTemplates(): Promise<void> {
    try {
      const data = await listTemplates();
      setTemplates(data);
    } catch {
      // Templates may not be seeded yet
    }
  }

  async function handleApplyTemplate(templateId: string): Promise<void> {
    setApplying(templateId);
    try {
      const result = await applyTemplate(templateId);
      setAppliedTemplateId(templateId);
      try { localStorage.setItem("lumate_applied_learning_template", templateId); } catch { /* non-critical */ }
      toast.success(tf("settings.templateAppliedDetail", { count: result.applied_preferences }));
    } catch {
      toast.error(t("settings.templateApplyFailed"));
    } finally {
      setApplying(null);
    }
  }

  return (
    <section>
      <h2 className="font-medium text-foreground mb-3">
        {t("settings.templates")}
      </h2>
      <p className="text-sm text-muted-foreground mb-4">
        {t("settings.templatesDescription")}
      </p>
      <div className="mb-4 flex items-start gap-3 rounded-2xl bg-brand/5 p-4 text-sm text-muted-foreground">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-brand" />
        <p>{t("settings.templatesEffectHint")}</p>
      </div>
      <div className="grid gap-3">
        {templates.map((template) => {
          const builtinKey = template.is_builtin ? BUILTIN_KEYS[template.name] : null;
          const isApplied = appliedTemplateId === template.id;
          const preferences = template.preferences ?? {};
          return (
          <div key={template.id} className={`rounded-2xl border p-4 transition-colors ${isApplied ? "border-brand/40 bg-brand/5" : "border-border bg-card"}`}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className={`grid size-8 place-items-center rounded-xl ${isApplied ? "bg-brand text-brand-foreground" : "bg-muted text-muted-foreground"}`}>
                  {isApplied ? <CheckCircle2 className="size-4" /> : <LayoutTemplate className="size-4" />}
                </span>
                <span className="font-medium text-sm text-foreground">{builtinKey ? t(`template.${builtinKey}`) : template.name}</span>
                {template.is_builtin && (
                  <Badge variant="secondary" className="text-xs">{t("settings.builtin")}</Badge>
                )}
                {isApplied ? <Badge className="text-xs">{t("settings.templateActive")}</Badge> : null}
              </div>
              <p className="mb-3 ml-10 text-xs leading-5 text-muted-foreground">
                {builtinKey ? t(`settings.template.${builtinKey}.description`) : template.description}
              </p>
              <div className="ml-10 flex flex-wrap gap-1.5">
                {EFFECT_DIMENSIONS.map((dimension) => preferences[dimension] ? (
                  <Badge key={dimension} variant="outline" className="text-xs font-normal">
                    {t(`settings.template.dimension.${dimension}`)} · {t(`settings.template.value.${preferences[dimension]}`)}
                  </Badge>
                ) : null)}
              </div>
            </div>
            <Button
              size="sm"
              variant={isApplied ? "secondary" : "outline"}
              onClick={() => handleApplyTemplate(template.id)}
              disabled={applying === template.id}
            >
              {applying === template.id
                ? t("settings.applying")
                : isApplied ? t("settings.reapply") : t("settings.apply")}
            </Button>
            </div>
            {isApplied ? <p className="mt-3 border-t border-brand/10 pt-3 text-xs text-brand">{t("settings.templateActiveHint")}</p> : null}
          </div>
        )})}
        {templates.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {t("settings.templatesEmpty")}
          </p>
        )}
      </div>
    </section>
  );
}
