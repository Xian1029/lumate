import { Suspense, lazy } from "react";
import { Button } from "@/components/ui/button";

const PracticeSection = lazy(() =>
  import("@/components/sections/practice-section").then((m) => ({ default: m.PracticeSection })),
);

type TranslateFn = (key: string) => string;
type TranslateFormatFn = (key: string, vars?: Record<string, string | number | null | undefined>) => string;

interface PracticePanelProps {
  courseId: string;
  difficultyLevel: string;
  aiActionsEnabled: boolean;
  generatingFocusedQuiz: boolean;
  onGenerateFocusedQuiz: () => void;
  t: TranslateFn;
  tf: TranslateFormatFn;
}

export function PracticePanel({
  courseId,
  difficultyLevel,
  aiActionsEnabled,
  generatingFocusedQuiz,
  onGenerateFocusedQuiz,
  t,
  tf,
}: PracticePanelProps) {
  return (
    <section className="flex h-[min(680px,80dvh)] flex-col overflow-hidden rounded-3xl border border-amber-100 bg-card shadow-[0_18px_55px_-38px_rgba(120,75,20,0.45)]">
      <div className="flex items-center gap-3 border-b border-amber-100 bg-gradient-to-r from-amber-50/80 to-orange-50/45 px-6 py-4">
        <span className="grid size-10 place-items-center rounded-xl bg-white text-xl shadow-sm" aria-hidden="true">🎯</span>
        <div>
          <h2 className="text-lg font-bold">{t("course.practice")}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t("unit.practice.desc")}</p>
        </div>
        <div className="ml-auto">
          <Button
            size="sm"
            variant="outline"
            disabled={!aiActionsEnabled || generatingFocusedQuiz}
            onClick={onGenerateFocusedQuiz}
          >
            {generatingFocusedQuiz
              ? t("unit.generating")
              : tf("unit.generateFocusedQuizWithDifficulty", { level: t(`unit.difficulty.${difficultyLevel}`) })}
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden [&>*]:h-full">
        <Suspense fallback={<div className="p-4 text-sm text-muted-foreground animate-pulse">{t("unit.loading.practice")}</div>}>
          <PracticeSection courseId={courseId} showReview={false} aiActionsEnabled={aiActionsEnabled} defaultTab="quiz" />
        </Suspense>
      </div>
    </section>
  );
}
