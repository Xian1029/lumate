"use client";

import { t } from "@/lib/i18n";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useBatchManager } from "@/hooks/use-batch-manager";
import { listGeneratedQuizBatches, saveGeneratedQuiz } from "@/lib/api";
import { useChatStore } from "@/store/chat";
import { useWorkspaceStore } from "@/store/workspace";
import { toast } from "sonner";

interface GeneratedQuizCardProps {
  courseId: string;
}

export function GeneratedQuizCard({ courseId }: GeneratedQuizCardProps) {
  const draft = useChatStore((s) => s.generatedQuizDraft);
  const parseError = useChatStore((s) => s.generatedQuizError);
  const clearGeneratedQuizDraft = useChatStore((s) => s.clearGeneratedQuizDraft);
  const triggerRefresh = useWorkspaceStore((s) => s.triggerRefresh);
  const [saving, setSaving] = useState(false);
  const { latestBatch, loadBatches } = useBatchManager({
    courseId,
    refreshSection: "practice",
    listFn: listGeneratedQuizBatches,
  });

  if (!draft && !parseError) {
    return null;
  }

  const handleSave = async (replaceBatchId?: string) => {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await saveGeneratedQuiz(
        courseId,
        draft.rawContent,
        t("ui.chat_gen_practice"),
        replaceBatchId,
      );
      toast.success(`已保存 ${result.saved} 道题目到课程题库`);
      triggerRefresh("practice");
      await loadBatches();
      clearGeneratedQuizDraft(courseId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("ui.failed_save_quiz"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-border/60 bg-muted/20 px-3 py-2">
      <div className="rounded-xl border border-border/70 bg-background px-3 py-2.5" data-testid="generated-quiz-card">
        {draft ? (
          <>
            <p className="text-sm font-medium text-foreground">{t("ui.generated_questions_detected")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {draft.questionCount} 道题目已准备好，可以保存到课程题库。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {latestBatch?.is_active ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => void handleSave(latestBatch.batch_id)}
                >
                  替换最新版本
                </Button>
              ) : null}
              <Button type="button" size="sm" disabled={saving} onClick={() => void handleSave()}>
                另存为新版本
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => clearGeneratedQuizDraft(courseId)}
              >
                忽略
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-foreground">{t("ui.generated_quiz_not_saved")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{parseError}</p>
            <div className="mt-3">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => clearGeneratedQuizDraft(courseId)}
              >
                Dismiss
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
