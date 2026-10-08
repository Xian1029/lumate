/**
 * Adaptation toast — notifies the user when the Block Decision Engine
 * modifies the workspace layout, with an undo option and optional
 * intervention feedback (thumbs up/down).
 */

import { t } from "@/lib/i18n";
import { toast } from "sonner";
import { Brain, ThumbsUp, ThumbsDown } from "lucide-react";
import type { BlockUpdateOp } from "@/lib/api";
import { request } from "@/lib/api/client";
import { BLOCK_REGISTRY } from "@/lib/block-system/registry";

const ACTION_LABEL_KEYS: Record<string, string> = {
  add: "ui.block_action_add",
  remove: "ui.block_action_remove",
  resize: "ui.block_action_resize",
  reorder: "ui.block_action_reorder",
  update_config: "ui.block_action_update",
};

async function submitFeedback(interventionId: string, feedback: "helpful" | "not_helpful") {
  try {
    await request("/blocks/intervention-feedback", {
      method: "POST",
      body: JSON.stringify({ intervention_id: interventionId, feedback }),
    });
  } catch {
    // Best-effort — don't disrupt UX on failure
  }
}

export function showAdaptationToast(
  explanation: string,
  operations: BlockUpdateOp[],
  onUndo?: () => void,
  interventionIds?: Record<string, string>,
): void {
  const describeOperation = (op: BlockUpdateOp) => {
    const blockLabel = BLOCK_REGISTRY[op.block_type as keyof typeof BLOCK_REGISTRY]
      ? t(BLOCK_REGISTRY[op.block_type as keyof typeof BLOCK_REGISTRY].labelKey)
      : op.block_type;
    const concepts = Array.isArray(op.config?.concepts)
      ? op.config.concepts.filter((value): value is string => typeof value === "string" && !/^(unknown|none|null|未知|未命名)$/i.test(value.trim()))
      : [];
    let reason = op.reason;
    if (op.block_type === "agent_insight" && op.config?.insightType === "mastery_gate") {
      reason = concepts.length
        ? `这些前置知识点还需要巩固：${concepts.join("、")}。先复习后再继续，会学得更顺畅。`
        : "前置知识掌握情况不足，建议先巩固相关内容再继续。";
    } else if (/prerequisites not yet mastered/i.test(reason)) {
      reason = "部分前置知识还需要巩固，建议先复习相关内容再继续。";
    }
    return `${t(ACTION_LABEL_KEYS[op.action] ?? op.action)}「${blockLabel}」${reason ? `：${reason}` : ""}`;
  };
  const description = operations
    .map(describeOperation)
    .join("\n");

  // If there are tracked interventions, show feedback buttons
  const firstInterventionId = interventionIds ? Object.values(interventionIds)[0] : undefined;

  toast(t("ui.workspace_adaptation_title"), {
    description: (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground whitespace-pre-line">{description}</p>
        {firstInterventionId && (
          <div className="flex items-center gap-2 pt-1">
            <span className="text-xs text-muted-foreground">{t("ui.was_this_helpful")}</span>
            <button
              type="button"
              title={t("ui.helpful")}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
              onClick={() => {
                submitFeedback(firstInterventionId, "helpful");
                toast.dismiss();
              }}
            >
              <ThumbsUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              title={t("ui.not_helpful")}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
              onClick={() => {
                submitFeedback(firstInterventionId, "not_helpful");
                toast.dismiss();
              }}
            >
              <ThumbsDown className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    ),
    action: onUndo ? { label: t("ui.undo"), onClick: onUndo } : undefined,
    duration: 10000,
    icon: <Brain className="h-4 w-4 text-purple-500" />,
  });
}
