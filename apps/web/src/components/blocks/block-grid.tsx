"use client";

import { t, tf } from "@/lib/i18n";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useWorkspaceStore } from "@/store/workspace";
import { useCourseStore } from "@/store/course";
import { useRovingTabindex } from "@/hooks/use-roving-tabindex";
import { BLOCK_REGISTRY } from "@/lib/block-system/registry";
import { findNodeById, isPracticeEligibleContentNode } from "@/lib/content-tree";
import { BlockWrapper } from "./block-wrapper";
import { BlockPalette } from "./block-palette";
import { cn } from "@/lib/utils";

interface BlockGridProps {
  courseId: string;
  aiActionsEnabled: boolean;
}

function DeferredBlock({
  eager,
  minHeight,
  children,
}: {
  eager: boolean;
  minHeight: number;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(eager);
  const markerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ready || eager) return;
    const marker = markerRef.current;
    if (!marker || typeof IntersectionObserver === "undefined") {
      const fallbackTimer = window.setTimeout(() => setReady(true), 0);
      return () => window.clearTimeout(fallbackTimer);
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setReady(true);
          observer.disconnect();
        }
      },
      { rootMargin: "120px 0px" },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [eager, ready]);

  return (
    <div ref={markerRef} style={ready ? undefined : { minHeight }}>
      {ready ? children : (
        <div aria-hidden="true" className="h-full min-h-28 animate-pulse rounded-2xl border border-border/40 bg-muted/10" />
      )}
    </div>
  );
}

export function BlockGrid({ courseId, aiActionsEnabled }: BlockGridProps) {
  const blocks = useWorkspaceStore((s) => s.spaceLayout.blocks);
  const columns = useWorkspaceStore((s) => s.spaceLayout.columns);
  const focusedBlockId = useWorkspaceStore((s) => s.spaceLayout.focusedBlockId);
  const selectedNodeId = useWorkspaceStore((s) => s.selectedNodeId);
  const contentTree = useCourseStore((s) => s.contentTree);
  const contentTreeCourseId = useCourseStore((s) => s.contentTreeCourseId);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const gridRef = useRef<HTMLDivElement>(null);
  useRovingTabindex(gridRef, "both");

  const selectedNode = contentTreeCourseId === courseId ? findNodeById(contentTree, selectedNodeId) : null;
  const canPracticeCurrentNode = Boolean(selectedNode && isPracticeEligibleContentNode(selectedNode));
  const allVisibleBlocks = blocks.filter((b) =>
    (b.isVisible ?? b.visible ?? true) && !!BLOCK_REGISTRY[b.type] &&
    b.type !== "plan" && (!["quiz", "flashcards"].includes(b.type) || canPracticeCurrentNode),
  );
  const hasFocusedBlock = !!focusedBlockId && allVisibleBlocks.some((block) => block.id === focusedBlockId);
  const visibleBlocks = hasFocusedBlock
    ? allVisibleBlocks.filter((block) => block.id === focusedBlockId)
    : allVisibleBlocks;

  const toggleCollapse = useCallback((blockId: string) => {
    setCollapsed((prev) => ({ ...prev, [blockId]: !prev[blockId] }));
  }, []);

  const deferredHeight = (type: string): number => {
    if (["quiz", "flashcards", "knowledge_graph"].includes(type)) return 560;
    if (type === "progress") return 320;
    if (type === "forecast") return 380;
    if (type === "agent_insight") return 220;
    return 360;
  };

  // Map block sizes to grid column spans
  const sizeToSpan = (size: string, cols: number): string => {
    if (cols === 1) return "col-span-1";
    if (size === "full") return cols === 3 ? "col-span-3" : "col-span-2";
    if (size === "large") return cols === 3 ? "col-span-2" : "col-span-2";
    return "col-span-1";
  };

  return (
    <div className="space-y-4">
      {visibleBlocks.length > 0 ? <div
        ref={gridRef}
        role="list"
        aria-label={t("ui.workspace_blocks")}
        className="grid gap-6 max-sm:!grid-cols-1"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        }}
      >
        {visibleBlocks
          .sort((a, b) => a.position - b.position)
          .map((block, index) => {
            const isCollapsed = collapsed[block.id] ?? false;
            const regEntry = BLOCK_REGISTRY[block.type];
            const blockLabel = regEntry ? t(regEntry.labelKey) : block.type;

            return (
              <div
                key={block.id}
                role="listitem"
                aria-roledescription="sortable block"
                aria-label={tf("ui.block_position", { label: blockLabel, position: index + 1, total: visibleBlocks.length })}
                tabIndex={index === 0 ? 0 : -1}
                className={cn(
                  "max-sm:col-span-1",
                  hasFocusedBlock ? (columns === 3 ? "col-span-3" : columns === 2 ? "col-span-2" : "col-span-1") : sizeToSpan(block.size, columns),
                )}
                style={{ animation: "block-appear 0.4s ease-out both", animationDelay: `${index * 100}ms` }}
              >
                {/* Mobile collapsible header */}
                <button
                  type="button"
                  className="sm:hidden w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground rounded-t-xl bg-section-header border border-b-0 border-border/60 touch-target"
                  onClick={() => toggleCollapse(block.id)}
                  aria-expanded={!isCollapsed ? "true" : "false"}
                  aria-label={tf(isCollapsed ? "ui.expand_block" : "ui.collapse_block", { label: blockLabel })}
                >
                  <span>{blockLabel}</span>
                  <ChevronDown className={cn("h-4 w-4 transition-transform", isCollapsed && "-rotate-90")} />
                </button>
                <div className={cn("sm:!block", isCollapsed && "hidden")}>
                  <DeferredBlock eager={index < 2} minHeight={deferredHeight(block.type)}>
                    <BlockWrapper
                      block={block}
                      courseId={courseId}
                      aiActionsEnabled={aiActionsEnabled}
                    />
                  </DeferredBlock>
                </div>
              </div>
            );
          })}
      </div> : null}

      {!hasFocusedBlock ? <BlockPalette /> : null}
    </div>
  );
}
