"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  X, Check, Sparkles, Maximize2, AlertTriangle, Lock,
  BookOpen, FileText, CircleHelp, Layers3, BarChart3, GitBranch,
  RotateCcw, CalendarDays, Puzzle, TrendingUp, Newspaper, Pin, PinOff,
  type LucideIcon,
} from "lucide-react";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { BLOCK_REGISTRY } from "@/lib/block-system/registry";
import { canRemoveBlock, type BlockInstance, type BlockType, type LearningMode } from "@/lib/block-system/types";
import { updateUnlockContext, isBlockUnlocked, getUnlockContext } from "@/lib/block-system/feature-unlock";
import { logAgentDecision } from "@/lib/api";
import { useWorkspaceStore } from "@/store/workspace";
import { useCourseStore } from "@/store/course";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n-context";
import { toast } from "sonner";
import { recordBlockEvent, useBlockEngagement } from "@/hooks/use-block-engagement";

/** Block types that open a right-side drawer instead of navigating. */
const BLOCK_DRAWER_TYPES = new Set<BlockType>(["notes"]);

const BLOCK_FULL_PAGE_LINKS: Partial<Record<BlockType, (courseId: string, nodeId?: string | null) => string>> = {
  quiz: (courseId, nodeId) => `/course/${courseId}/practice?tab=quiz${nodeId ? `&node=${encodeURIComponent(nodeId)}` : ""}`,
  flashcards: (courseId, nodeId) => `/course/${courseId}/practice?tab=flashcards${nodeId ? `&node=${encodeURIComponent(nodeId)}` : ""}`,
  // Preserve the current textbook node when opening the full-page graph so
  // its material highlight and contextual recommendation remain identical.
  knowledge_graph: (courseId, nodeId) => `/course/${courseId}/graph${nodeId ? `?node=${encodeURIComponent(nodeId)}` : ""}`,
  plan: (courseId) => `/course/${courseId}/plan`,
  review: (courseId) => `/course/${courseId}/review`,
  progress: (courseId) => `/course/${courseId}/profile?tab=progress`,
  wrong_answers: (courseId) => `/course/${courseId}/wrong-answers`,
  forecast: (courseId) => `/course/${courseId}/profile?tab=forecast`,
};

export function getBlockFullPageHref(blockType: BlockType, courseId: string, nodeId?: string | null): string | null {
  return BLOCK_FULL_PAGE_LINKS[blockType]?.(courseId, nodeId) ?? null;
}

/** Restrained accent colors make activities recognizable without competing with study content. */
const BLOCK_VISUALS: Record<BlockType, { Icon: LucideIcon; icon: string }> = {
  chapter_list: { Icon: BookOpen, icon: "bg-amber-100/70 text-amber-700 dark:bg-amber-900/25 dark:text-amber-300" },
  notes: { Icon: FileText, icon: "bg-sky-100/70 text-sky-700 dark:bg-sky-900/25 dark:text-sky-300" },
  quiz: { Icon: CircleHelp, icon: "bg-orange-100/70 text-orange-700 dark:bg-orange-900/25 dark:text-orange-300" },
  flashcards: { Icon: Layers3, icon: "bg-violet-100/70 text-violet-700 dark:bg-violet-900/25 dark:text-violet-300" },
  progress: { Icon: BarChart3, icon: "bg-emerald-100/70 text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-300" },
  knowledge_graph: { Icon: GitBranch, icon: "bg-yellow-100/70 text-yellow-700 dark:bg-yellow-900/25 dark:text-yellow-300" },
  review: { Icon: RotateCcw, icon: "bg-teal-100/70 text-teal-700 dark:bg-teal-900/25 dark:text-teal-300" },
  plan: { Icon: CalendarDays, icon: "bg-indigo-100/70 text-indigo-700 dark:bg-indigo-900/25 dark:text-indigo-300" },
  wrong_answers: { Icon: Puzzle, icon: "bg-rose-100/70 text-rose-700 dark:bg-rose-900/25 dark:text-rose-300" },
  forecast: { Icon: TrendingUp, icon: "bg-cyan-100/70 text-cyan-700 dark:bg-cyan-900/25 dark:text-cyan-300" },
  agent_insight: { Icon: Sparkles, icon: "bg-lime-100/70 text-lime-700 dark:bg-lime-900/25 dark:text-lime-300" },
  summary: { Icon: Newspaper, icon: "bg-orange-100/70 text-orange-700 dark:bg-orange-900/25 dark:text-orange-300" },
};

interface BlockWrapperProps {
  block: BlockInstance;
  courseId: string;
  aiActionsEnabled: boolean;
}

export function BlockWrapper({ block, courseId, aiActionsEnabled }: BlockWrapperProps) {
  const t = useT();
  const removeBlock = useWorkspaceStore((s) => s.removeBlock);
  const pinBlock = useWorkspaceStore((s) => s.pinBlock);
  const unpinBlock = useWorkspaceStore((s) => s.unpinBlock);
  const hideBlock = useWorkspaceStore((s) => s.hideBlock);
  const addBlock = useWorkspaceStore((s) => s.addBlock);
  const approveAgentBlock = useWorkspaceStore((s) => s.approveAgentBlock);
  const dismissAgentBlock = useWorkspaceStore((s) => s.dismissAgentBlock);
  const setLearningMode = useWorkspaceStore((s) => s.setLearningMode);
  const applyBlockTemplate = useWorkspaceStore((s) => s.applyBlockTemplate);
  const currentMode = useWorkspaceStore((s) => s.spaceLayout.mode);
  const focusedBlockId = useWorkspaceStore((s) => s.spaceLayout.focusedBlockId);
  const selectedNodeId = useWorkspaceStore((s) => s.selectedNodeId);
  const toggleFocusedBlock = useWorkspaceStore((s) => s.toggleFocusedBlock);
  const courses = useCourseStore((s) => s.courses);

  const setNotesDrawerOpen = useWorkspaceStore((s) => s.setNotesDrawerOpen);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuPosition) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !menuTriggerRef.current?.contains(target)) setMenuPosition(null);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuPosition(null); };
    const onViewportChange = () => setMenuPosition(null);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [menuPosition]);

  const engagementRef = useBlockEngagement(block.id, block.type, courseId);

  // Feature unlock check
  const { unlocked, unlockHint, reason: unlockReason } = useMemo(() => {
    const ctx = { ...getUnlockContext(courseId, courses.length), mode: currentMode ?? undefined };
    return isBlockUnlocked(block.type, ctx);
  }, [block.type, courseId, courses.length, currentMode]);

  const entry = BLOCK_REGISTRY[block.type];
  if (!entry) return null;
  const visual = BLOCK_VISUALS[block.type];
  const BlockIcon = visual.Icon;
  const isFocused = focusedBlockId === block.id;

  const Component = entry.component;
  const isAgent = Boolean(block.agentMeta);
  const isInsight = block.type === "agent_insight";
  const needsApproval = isAgent && block.agentMeta?.needsApproval;
  const insightType = block.type === "agent_insight" ? (block.config.insightType as string | undefined) : undefined;
  const hasValidMasteryGateConcepts = Array.isArray(block.config.concepts)
    && block.config.concepts.some((value) => typeof value === "string" && value.trim() && !/^(unknown|none|null|未知|未命名)$/i.test(value.trim()));
  const invalidMasteryGate = block.type === "agent_insight" && insightType === "mastery_gate" && !hasValidMasteryGateConcepts;
  useEffect(() => {
    if (invalidMasteryGate) dismissAgentBlock(block.id);
  }, [block.id, dismissAgentBlock, invalidMasteryGate]);
  // Old persisted insights sometimes contain placeholder concept names. Drop
  // them from the rendered workspace and remove the stale block from its layout.
  if (invalidMasteryGate) return null;
  const suggestionSignals = Array.isArray(block.config.suggestionSignals)
    ? block.config.suggestionSignals.filter((signal): signal is string => typeof signal === "string")
    : [];
  const usesAdaptiveHeight = block.type === "chapter_list" || block.type === "notes" || block.type === "agent_insight" || block.type === "forecast" || block.type === "progress";
  const blockHeightClass = isFocused
    ? "h-[calc(100dvh-7.5rem)] min-h-[520px]"
    : block.type === "agent_insight"
    ? "h-auto"
    : block.type === "forecast"
    ? "h-auto max-h-[min(380px,58dvh)]"
    : block.type === "progress"
    ? "h-auto max-h-[min(440px,65dvh)]"
    : block.type === "chapter_list"
    ? "h-auto max-h-[min(560px,80dvh)]"
    : block.type === "notes"
      ? "h-auto max-h-[min(760px,86dvh)]"
      : block.size === "small"
        ? "h-[360px]"
        : "h-[560px]";

  const logModeSuggestionDecision = (action: string, suggestedMode?: LearningMode) => {
    void logAgentDecision({
      course_id: courseId,
      action,
      title: t(entry.labelKey),
      reason: typeof block.config.reason === "string" ? block.config.reason : block.agentMeta?.reason,
      decision_type: "mode_suggestion",
      source: "course_workspace",
      top_signal_type: "manual_override",
      metadata_json: {
        suggested_mode: suggestedMode,
        approval_cta: block.agentMeta?.approvalCta,
        signals: suggestionSignals,
      },
    }).catch(() => undefined);
  };

  const handleApprove = () => {
    // Apply the intended operation directly for high-impact Tier-2 suggestions.
    if (insightType === "mode_suggestion") {
      const suggestedMode = block.config.suggestedMode as LearningMode | undefined;
      if (suggestedMode) {
        logModeSuggestionDecision("approve_mode_suggestion", suggestedMode);
        setLearningMode(suggestedMode);
        updateUnlockContext(courseId, { mode: suggestedMode });
        dismissAgentBlock(block.id);
        return;
      }
    }
    if (insightType === "layout_suggestion") {
      const suggestedTemplate = block.config.suggestedTemplate as string | undefined;
      if (suggestedTemplate) {
        applyBlockTemplate(suggestedTemplate);
        dismissAgentBlock(block.id);
        return;
      }
    }
    if (insightType === "feature_unlock") {
      const suggestedBlockType = block.config.suggestedBlockType as BlockType | undefined;
      if (suggestedBlockType) {
        const exists = useWorkspaceStore.getState().spaceLayout.blocks.some(
          (b) => b.type === suggestedBlockType,
        );
        if (!exists) {
          addBlock(suggestedBlockType, {}, "agent");
        }
        dismissAgentBlock(block.id);
        return;
      }
    }
    approveAgentBlock(block.id);
    recordBlockEvent(courseId, block.type, "approve");
  };

  const handleDismiss = () => {
    if (insightType === "mode_suggestion") {
      const suggestedMode = block.config.suggestedMode as LearningMode | undefined;
      logModeSuggestionDecision("dismiss_mode_suggestion", suggestedMode);
    }
    dismissAgentBlock(block.id);
    recordBlockEvent(courseId, block.type, "dismiss");
  };

  return (
    <div
      ref={engagementRef}
      id={block.type === "notes" ? "notes" : undefined}
      data-block-type={block.type}
      role="region"
      aria-label={t(entry.labelKey)}
      tabIndex={0}
      className={cn(
        "group/block overflow-hidden rounded-2xl border border-border/60 bg-card flex flex-col shadow-[0_8px_28px_-22px_rgba(30,45,38,0.35)] transition-[box-shadow,border-color] duration-200 hover:border-brand/25 hover:shadow-[0_12px_32px_-22px_rgba(30,45,38,0.42)]",
        blockHeightClass,
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isAgent && "ring-1 ring-brand/20 bg-brand-muted/20",
        needsApproval && "ring-1 ring-warning/30 bg-warning-muted/20",
        isFocused && "border-brand/35 shadow-[0_18px_54px_-30px_rgba(49,93,75,0.45)]",
      )}
    >
      {/* Header bar */}
      <div className="relative z-40 flex items-center gap-2.5 overflow-visible border-b border-border/40 bg-muted/15 px-4 py-3">
        <span
          aria-hidden="true"
          className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", visual.icon)}
        >
          <BlockIcon className="size-4" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold tracking-tight text-foreground">{t(entry.labelKey)}</p>
          <p className="mt-0.5 hidden truncate text-[10px] text-muted-foreground sm:block">{t(entry.descriptionKey)}</p>
        </div>

        {!isInsight && <button
          type="button"
          onClick={() => toggleFocusedBlock(block.id)}
          className={cn(
            "rounded-lg p-1.5 transition-colors",
            isFocused
              ? "bg-brand-muted text-brand hover:bg-brand/15"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
          aria-pressed={isFocused}
          aria-label={isFocused ? "退出专注查看" : "专注查看"}
          title={isFocused ? "退出专注查看" : "专注查看"}
        >
          {isFocused ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </button>}

        {BLOCK_DRAWER_TYPES.has(block.type) && (
          <button
            type="button"
            onClick={() => {
              if (block.type === "notes") setNotesDrawerOpen(true);
            }}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
            aria-label={t("block.openFullscreen")}
            title={t("block.openFullscreen")}
          >
            <Maximize2 className="size-3.5" />
          </button>
        )}

        {getBlockFullPageHref(block.type, courseId, selectedNodeId) && (
          <Link
            href={getBlockFullPageHref(block.type, courseId, selectedNodeId)!}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
            aria-label={t("block.openFullPage")}
            title={t("block.openFullPage")}
          >
            <Maximize2 className="size-3.5" />
          </Link>
        )}

        {isAgent && block.agentMeta && !isInsight && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-brand bg-brand-muted px-2 py-0.5 rounded-full">
            <Sparkles className="size-3" />
            AI
          </span>
        )}

        {needsApproval && !isInsight && (
          <>
            <button
              onClick={handleApprove}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-success bg-success-muted px-2.5 py-1 rounded-md hover:bg-success/20 transition-colors"
              aria-label={block.agentMeta?.approvalCta || t("block.approve")}
            >
              <Check className="size-3" />
              {block.agentMeta?.approvalCta || t("block.approve")}
            </button>
            <button
              onClick={handleDismiss}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-destructive px-1.5 py-1 rounded-md transition-colors"
              aria-label={t("block.dismiss")}
            >
              <X className="size-3" />
            </button>
          </>
        )}

        {!needsApproval && isAgent && block.agentMeta?.dismissible && !isInsight && (
          <button
            onClick={handleDismiss}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 -mr-1"
            aria-label={t("block.dismiss")}
          >
            <X className="size-3.5" />
          </button>
        )}

        {canRemoveBlock(block.source) ? (
          <button
            ref={menuTriggerRef}
            type="button"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const width = 176;
              const height = 144;
              const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
              const top = rect.bottom + height + 8 <= window.innerHeight
                ? rect.bottom + 8
                : Math.max(8, rect.top - height - 8);
              setMenuPosition((current) => current ? null : { top, left });
            }}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="区块操作"
            aria-haspopup="menu"
            aria-expanded={Boolean(menuPosition)}
          >
            <span className="text-lg leading-none">⋯</span>
          </button>
        ) : null}
      </div>

      {menuPosition && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[100] w-44 rounded-xl border border-border bg-popover p-1.5 text-xs shadow-xl"
          style={{ top: menuPosition.top, left: menuPosition.left }}
        >
              <button type="button" onClick={() => { block.isPinned ? unpinBlock(block.id) : pinBlock(block.id); setMenuPosition(null); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted">
                {block.isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                {block.isPinned ? "取消固定" : "固定到工作区"}
              </button>
              <button type="button" onClick={() => { hideBlock(block.id); setMenuPosition(null); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted">
                <X className="size-3.5" /> 隐藏区块
              </button>
              <button
                type="button"
                onClick={() => {
                  removeBlock(block.id);
                  setMenuPosition(null);
                  recordBlockEvent(courseId, block.type, "manual_remove");
                  toast(t("block.removed"), { action: { label: t("block.undo"), onClick: () => useWorkspaceStore.getState().undoRemoveBlock() }, duration: 5000 });
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-destructive hover:bg-destructive/10"
              >
                <X className="size-3.5" /> 移除区块
              </button>
        </div>,
        document.body,
      )}

      {/* Agent reason banner */}
      {isAgent && block.agentMeta?.reason && !isInsight && (
        <div className="px-4 py-2 text-xs text-brand bg-brand-muted/50 border-b border-brand/10">
          {block.agentMeta.reason}
        </div>
      )}

      {/* Block content */}
      <div
        className={cn(
          "flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-thin relative",
          block.type === "notes" && "xl:overflow-y-hidden",
          usesAdaptiveHeight ? "[&>*]:h-auto" : "[&>*]:h-full",
        )}
      >
        <ErrorBoundary
          fallback={
            <div className="flex flex-col items-center justify-center h-32 gap-2 text-center p-4">
              <AlertTriangle className="size-5 text-destructive/60" />
              <p className="text-xs text-muted-foreground">
                {t("block.renderError")}
              </p>
            </div>
          }
        >
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
                {t("block.loading")}
              </div>
            }
          >
            <Component
              courseId={courseId}
              blockId={block.id}
              config={block.config}
              aiActionsEnabled={aiActionsEnabled}
            />
          </Suspense>
        </ErrorBoundary>

        {/* Locked overlay */}
        {!unlocked && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-sm rounded-b-2xl z-20 group">
            <div className="flex flex-col items-center gap-2 p-4 text-center">
              <div className="flex size-10 items-center justify-center rounded-full bg-muted ring-2 ring-border group-hover:ring-brand/30 transition-all">
                <Lock className="size-5 text-muted-foreground group-hover:text-brand transition-colors" />
              </div>
              <p className="text-sm font-medium text-foreground">
                {t("block.locked").replace("{label}", t(entry.labelKey))}
              </p>
              {unlockHint && (
                <p className="text-xs text-muted-foreground max-w-[200px]">{unlockHint}</p>
              )}
              {unlockReason && (
                <p className="text-[11px] text-muted-foreground/70 max-w-[220px]">{unlockReason}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
