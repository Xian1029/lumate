"use client";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n-context";

export function AppearanceSection() {
  const t = useT();
  return (
    <section>
        <h2 className="font-medium text-foreground mb-3">
          {t("settings.theme")}
        </h2>
        <div className="flex gap-2">
          <Button
            data-testid="settings-theme-light"
            variant="default"
            size="sm"
            disabled
          >
            {t("settings.appearance.light")}
          </Button>
          <p className="self-center text-xs text-muted-foreground">{t("settings.appearance.lightOnly")}</p>
        </div>
    </section>
  );
}
