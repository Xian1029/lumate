import { Suspense, lazy } from "react";

const GraphView = lazy(() =>
  import("@/components/sections/analytics/graph-view").then((m) => ({ default: m.GraphView })),
);

type TranslateFn = (key: string) => string;

interface GraphPanelProps {
  courseId: string;
  focusTerms: string[];
  activeMaterialId?: string | null;
  t: TranslateFn;
}

export function GraphPanel({ courseId, focusTerms, activeMaterialId, t }: GraphPanelProps) {
  return (
    <section className="flex h-[min(620px,75dvh)] min-h-[480px] flex-col overflow-hidden rounded-3xl border border-violet-100 bg-card shadow-[0_18px_55px_-38px_rgba(90,65,130,0.4)]">
      <div className="flex shrink-0 items-center gap-3 border-b border-violet-100 bg-gradient-to-r from-violet-50/75 to-sky-50/45 px-6 py-4">
        <span className="grid size-10 place-items-center rounded-xl bg-white text-xl shadow-sm" aria-hidden="true">🧩</span>
        <div><h2 className="text-lg font-bold">{t("course.graph")}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{t("unit.graph.desc")}</p>
        </div>
      </div>
      <Suspense fallback={<div className="p-4 text-sm text-muted-foreground animate-pulse">{t("unit.loading.graph")}</div>}>
        <GraphView courseId={courseId} focusTerms={focusTerms} activeMaterialId={activeMaterialId} />
      </Suspense>
    </section>
  );
}
