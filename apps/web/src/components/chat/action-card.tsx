"use client";

import { useWorkspaceStore, type SectionId } from "@/store/workspace";
import { cn } from "@/lib/utils";
import {
  LayoutGrid,
  RefreshCw,
  Sparkles,
  Focus,
  BookOpen,
  ArrowRight,
} from "lucide-react";

interface ActionCardProps {
  action: {
    type: string;
    label?: string;
    payload?: Record<string, unknown>;
  };
}

/** 内部动作类型兜底中文标签，避免把英文枚举泄露给用户。 */
const ACTION_LABELS: Record<string, string> = {
  data_updated: "内容已更新",
  focus_topic: "聚焦知识点",
  add_block: "添加模块",
  remove_block: "移除模块",
  reorder_blocks: "调整模块顺序",
  resize_block: "调整模块大小",
  apply_template: "应用模板",
  agent_insight: "智能建议",
  set_learning_mode: "设置学习模式",
  suggest_mode: "推荐模式",
  unknown: "查看详情",
};

/** Map action types to their target workspace section and icon. */
const ACTION_MAP: Record<
  string,
  { section: SectionId; icon: typeof BookOpen; color: string }
> = {
  data_updated: {
    section: "notes",
    icon: RefreshCw,
    color: "bg-muted/30 text-muted-foreground",
  },
  focus_topic: {
    section: "notes",
    icon: Focus,
    color: "bg-muted/30 text-muted-foreground",
  },
  add_block: {
    section: "notes",
    icon: LayoutGrid,
    color: "bg-muted/40 text-foreground/80",
  },
  remove_block: {
    section: "notes",
    icon: LayoutGrid,
    color: "bg-muted/40 text-foreground/80",
  },
  reorder_blocks: {
    section: "notes",
    icon: LayoutGrid,
    color: "bg-muted/40 text-foreground/80",
  },
  resize_block: {
    section: "notes",
    icon: LayoutGrid,
    color: "bg-muted/40 text-foreground/80",
  },
  apply_template: {
    section: "notes",
    icon: LayoutGrid,
    color: "bg-muted/40 text-foreground/80",
  },
  agent_insight: {
    section: "notes",
    icon: Sparkles,
    color: "bg-muted/40 text-foreground/80",
  },
  set_learning_mode: {
    section: "plan",
    icon: Sparkles,
    color: "bg-muted/40 text-foreground/80",
  },
  suggest_mode: {
    section: "plan",
    icon: Sparkles,
    color: "bg-muted/40 text-foreground/80",
  },
  unknown: {
    section: "notes",
    icon: ArrowRight,
    color: "bg-muted/30 text-muted-foreground",
  },
};

/**
 * Small clickable pill/badge rendered inside assistant message bubbles.
 * Dispatches to the workspace store on click to switch sections.
 */
export function ActionCard({ action }: ActionCardProps) {
  const setActiveSection = useWorkspaceStore((s) => s.setActiveSection);
  const setSelectedNodeId = useWorkspaceStore((s) => s.setSelectedNodeId);

  const mapping = ACTION_MAP[action.type] ?? ACTION_MAP.unknown;
  const Icon = mapping?.icon ?? ArrowRight;
  const colorClass =
    mapping?.color ??
    "bg-muted/30 text-muted-foreground";

  const handleClick = () => {
    const VALID_SECTIONS: Set<string> = new Set(["notes", "practice", "analytics", "plan"]);
    if (action.type === "data_updated") {
      const requested = typeof action.payload?.section === "string" ? action.payload.section : action.label ?? "";
      if (VALID_SECTIONS.has(requested)) {
        setActiveSection(requested as SectionId);
        return;
      }
    }
    if (action.type === "focus_topic" && action.label) {
      const nodeId = action.payload?.nodeId;
      if (typeof nodeId === "string" && nodeId) setSelectedNodeId(nodeId);
    }
    setActiveSection(mapping.section);
  };

  const label =
    action.label ?? ACTION_LABELS[action.type] ?? "查看详情";

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium card-shadow",
        "transition-all hover:opacity-80 active:opacity-60",
        "cursor-pointer select-none",
        colorClass,
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
