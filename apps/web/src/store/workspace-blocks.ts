/**
 * Block system slice for workspace store.
 *
 * Extracted from workspace.ts for maintainability.
 * All block-related operations live here.
 */

import type {
  BlockInstance,
  BlockType,
  BlockSize,
  BlockSource,
  LegacyBlockSource,
  AgentBlockMeta,
  SpaceLayout,
  LearningMode,
} from "@/lib/block-system/types";
import { canRemoveBlock, defaultBlockSource } from "@/lib/block-system/types";
import { buildLayoutFromTemplate, buildLayoutFromMode } from "@/lib/block-system/templates";
import { createBlockId, normalizeSpaceLayout, parseSpaceLayout } from "@/lib/block-system/layout-storage";
import { BLOCK_REGISTRY } from "@/lib/block-system/registry";
import { recordBlockEvent } from "@/hooks/use-block-engagement";

function nextBlockId(): string {
  return createBlockId();
}

/** Reorder blocks by placing one of each type in `orderedTypes` first, then the rest. */
function reorderBlocksByType(blocks: BlockInstance[], orderedTypes: BlockType[]): BlockInstance[] {
  const byType = new Map<BlockType, BlockInstance[]>();
  for (const b of blocks) {
    const list = byType.get(b.type) ?? [];
    list.push(b);
    byType.set(b.type, list);
  }
  const reordered: BlockInstance[] = [];
  // The course outline is structural navigation and must stay first even when
  // user/agent reorder requests omit it or try to move it.
  const outline = byType.get("chapter_list")?.shift();
  if (outline) reordered.push(outline);
  if (byType.get("chapter_list")?.length === 0) byType.delete("chapter_list");
  for (const type of orderedTypes) {
    if (type === "chapter_list") continue;
    const list = byType.get(type);
    if (list?.length) {
      reordered.push(list.shift()!);
      if (list.length === 0) byType.delete(type);
    }
  }
  for (const remaining of byType.values()) reordered.push(...remaining);
  return reordered;
}

const MAX_LAYOUT_HISTORY = 10;
const DISMISS_STORAGE_KEY_PREFIX = "opentutor_dismiss_";
const DISMISS_RETENTION_MS = 7 * 86_400_000; // 7 days

interface DismissRecord {
  type: string;
  reason?: string;
  ts: number;
}

/** Get block types dismissed in the last 7 days for a course. */
export function getDismissHistory(courseId: string): string[] {
  try {
    const raw = localStorage.getItem(`${DISMISS_STORAGE_KEY_PREFIX}${courseId}`);
    if (!raw) return [];
    const records: DismissRecord[] = JSON.parse(raw);
    const cutoff = Date.now() - DISMISS_RETENTION_MS;
    return [...new Set(records.filter((r) => r.ts > cutoff).map((r) => r.type))];
  } catch {
    return [];
  }
}

function recordDismiss(courseId: string, blockType: string, reason?: string): void {
  try {
    const key = `${DISMISS_STORAGE_KEY_PREFIX}${courseId}`;
    const raw = localStorage.getItem(key);
    const records: DismissRecord[] = raw ? JSON.parse(raw) : [];
    records.push({ type: blockType, reason, ts: Date.now() });
    const cutoff = Date.now() - DISMISS_RETENTION_MS;
    localStorage.setItem(key, JSON.stringify(records.filter((r) => r.ts > cutoff)));
  } catch {
    // Best-effort
  }
}

export interface BlockSystemState {
  spaceLayout: SpaceLayout;
  addBlock: (type: BlockType, config?: Record<string, unknown>, source?: BlockSource | LegacyBlockSource, size?: BlockSize) => void;
  lastRemovedBlock: { block: BlockInstance; index: number } | null;
  removeBlock: (blockId: string) => void;
  undoRemoveBlock: () => void;
  removeBlockByType: (type: BlockType) => void;
  pinBlock: (blockId: string) => void;
  unpinBlock: (blockId: string) => void;
  hideBlock: (blockId: string) => void;
  showBlock: (blockId: string) => void;
  resetLayout: (layout: SpaceLayout) => void;
  reorderBlocks: (orderedTypes: BlockType[]) => void;
  resizeBlock: (blockId: string, size: BlockSize) => void;
  updateBlockConfig: (blockId: string, config: Record<string, unknown>) => void;
  toggleFocusedBlock: (blockId: string) => void;
  applyBlockTemplate: (templateId: string) => void;
  agentAddBlock: (type: BlockType, config: Record<string, unknown>, meta: AgentBlockMeta) => void;
  approveAgentBlock: (blockId: string) => void;
  dismissAgentBlock: (blockId: string) => void;
  loadBlocks: (layout: SpaceLayout) => void;
  setLearningMode: (mode: LearningMode) => void;
  setSpaceMode: (mode: LearningMode) => void;
  layoutHistory: SpaceLayout[];
  undoLayout: () => boolean;
  batchUpdateBlocks: (
    ops: Array<
      | { action: "add"; type: BlockType; config?: Record<string, unknown>; size?: BlockSize }
      | { action: "remove"; blockId: string }
      | { action: "reorder"; orderedTypes: BlockType[] }
      | { action: "resize"; blockId: string; size: BlockSize }
      | { action: "update_config"; blockId: string; config: Record<string, unknown> }
    >,
  ) => void;
}

function pushHistory(layoutHistory: SpaceLayout[], spaceLayout: SpaceLayout): SpaceLayout[] {
  const history = [...layoutHistory, spaceLayout];
  return history.slice(-MAX_LAYOUT_HISTORY);
}

type SetState<TState extends BlockSystemState> = (
  fn: ((s: TState) => Partial<BlockSystemState>) | Partial<BlockSystemState>,
) => void;
type GetState<TState extends BlockSystemState> = () => TState;

export function createBlockSlice<TState extends BlockSystemState>(
  set: SetState<TState>,
  get: GetState<TState>,
): BlockSystemState {
  return {
    lastRemovedBlock: null,
    spaceLayout: { templateId: null, blocks: [], columns: 2 },

    addBlock: (type, config = {}, source = "USER_ADDED", size) => {
      const entry = BLOCK_REGISTRY[type];
      if (!entry) return;
      const blocks = get().spaceLayout.blocks;
      const existing = blocks.find((block) => block.type === type);
      if (existing) {
        set((s) => ({
          layoutHistory: pushHistory(s.layoutHistory, s.spaceLayout),
          spaceLayout: {
            ...s.spaceLayout,
            blocks: s.spaceLayout.blocks.map((block) => block.id === existing.id
              ? {
                ...block,
                isVisible: true,
                config: { ...block.config, ...config },
                size: size ?? block.size,
              }
              : block),
          },
        }));
        return;
      }
      const newBlock: BlockInstance = {
        id: nextBlockId(),
        type,
        position: blocks.length,
        size: size ?? entry.defaultSize,
        config: { ...entry.defaultConfig, ...config },
        isVisible: true,
        isPinned: false,
        source: source === "user" || source === "USER_ADDED"
          ? "USER_ADDED"
          : source === "SYSTEM_REQUIRED" ? "SYSTEM_REQUIRED" : defaultBlockSource(type),
      };
      set((s) => ({
        layoutHistory: pushHistory(s.layoutHistory, s.spaceLayout),
        spaceLayout: { ...s.spaceLayout, blocks: [...s.spaceLayout.blocks, newBlock] },
      }));
    },

    removeBlock: (blockId) => {
      set((state) => {
        const idx = state.spaceLayout.blocks.findIndex((b) => b.id === blockId);
        const block = state.spaceLayout.blocks[idx];
        if (block && !canRemoveBlock(block.source)) return state;
        return {
          layoutHistory: pushHistory(state.layoutHistory, state.spaceLayout),
          lastRemovedBlock: block ? { block, index: idx } : null,
          spaceLayout: {
            ...state.spaceLayout,
            focusedBlockId: state.spaceLayout.focusedBlockId === blockId ? null : state.spaceLayout.focusedBlockId,
            blocks: state.spaceLayout.blocks.filter((b) => b.id !== blockId),
          },
        };
      });
    },

    undoRemoveBlock: () => {
      set((state) => {
        const removed = state.lastRemovedBlock;
        if (!removed) return state;
        const blocks = [...state.spaceLayout.blocks];
        blocks.splice(removed.index, 0, removed.block);
        return { lastRemovedBlock: null, spaceLayout: { ...state.spaceLayout, blocks } };
      });
    },

    removeBlockByType: (type) => {
      set((s) => {
        const idx = s.spaceLayout.blocks.findIndex((b) => b.type === type);
        if (idx === -1) return s;
        if (!canRemoveBlock(s.spaceLayout.blocks[idx].source)) return s;
        const blocks = [...s.spaceLayout.blocks];
        blocks.splice(idx, 1);
        return { spaceLayout: { ...s.spaceLayout, blocks: blocks.map((b, i) => ({ ...b, position: i })) } };
      });
    },

    pinBlock: (blockId) => set((s) => ({
      layoutHistory: pushHistory(s.layoutHistory, s.spaceLayout),
      spaceLayout: { ...s.spaceLayout, blocks: s.spaceLayout.blocks.map((b) => b.id === blockId ? { ...b, isPinned: true, isVisible: true } : b) },
    })),

    unpinBlock: (blockId) => set((s) => ({
      layoutHistory: pushHistory(s.layoutHistory, s.spaceLayout),
      spaceLayout: { ...s.spaceLayout, blocks: s.spaceLayout.blocks.map((b) => b.id === blockId ? { ...b, isPinned: false } : b) },
    })),

    hideBlock: (blockId) => set((s) => {
      const block = s.spaceLayout.blocks.find((b) => b.id === blockId);
      if (!block || block.source === "SYSTEM_REQUIRED") return s;
      return {
        layoutHistory: pushHistory(s.layoutHistory, s.spaceLayout),
        spaceLayout: { ...s.spaceLayout, focusedBlockId: s.spaceLayout.focusedBlockId === blockId ? null : s.spaceLayout.focusedBlockId, blocks: s.spaceLayout.blocks.map((b) => b.id === blockId ? { ...b, isVisible: false, isPinned: false } : b) },
      };
    }),

    showBlock: (blockId) => set((s) => ({
      layoutHistory: pushHistory(s.layoutHistory, s.spaceLayout),
      spaceLayout: { ...s.spaceLayout, blocks: s.spaceLayout.blocks.map((b) => b.id === blockId ? { ...b, isVisible: true } : b) },
    })),

    resetLayout: (layout) => set((s) => ({
      layoutHistory: pushHistory(s.layoutHistory, s.spaceLayout),
      spaceLayout: normalizeSpaceLayout(layout),
    })),

    reorderBlocks: (orderedTypes) => {
      set((s) => {
        const reordered = reorderBlocksByType(s.spaceLayout.blocks, orderedTypes);
        return { spaceLayout: { ...s.spaceLayout, blocks: reordered.map((b, i) => ({ ...b, position: i })) } };
      });
    },

    resizeBlock: (blockId, size) => {
      set((s) => ({
        spaceLayout: { ...s.spaceLayout, blocks: s.spaceLayout.blocks.map((b) => (b.id === blockId ? { ...b, size } : b)) },
      }));
    },

    updateBlockConfig: (blockId, config) => {
      set((s) => ({
        spaceLayout: { ...s.spaceLayout, blocks: s.spaceLayout.blocks.map((b) => (b.id === blockId ? { ...b, config: { ...b.config, ...config } } : b)) },
      }));
    },

    toggleFocusedBlock: (blockId) => {
      set((state) => {
        const exists = state.spaceLayout.blocks.some((block) => block.id === blockId && block.isVisible);
        if (!exists) return state;
        return {
          spaceLayout: {
            ...state.spaceLayout,
            focusedBlockId: state.spaceLayout.focusedBlockId === blockId ? null : blockId,
          },
        };
      });
    },

    applyBlockTemplate: (templateId) => {
      const layout = buildLayoutFromTemplate(templateId);
      if (layout) {
        const existingMode = get().spaceLayout.mode;
        set({ spaceLayout: normalizeSpaceLayout({ ...layout, mode: existingMode ?? layout.mode }) });
      }
    },

    agentAddBlock: (type, config, meta) => {
      const entry = BLOCK_REGISTRY[type];
      if (!entry) return;
      const blocks = get().spaceLayout.blocks;

      // Keep one insight area, but reuse a learner-added companion block when a
      // concrete insight arrives so manual customization never blocks the agent.
      if (type === "agent_insight") {
        const existingInsight = blocks.find((b) => b.type === "agent_insight");
        if (existingInsight) {
          set((s) => ({
            spaceLayout: {
              ...s.spaceLayout,
              blocks: s.spaceLayout.blocks.map((block) => block.id === existingInsight.id
                ? {
                  ...block,
                  isVisible: true,
                  source: "SYSTEM_OPTIONAL",
                  config: { ...entry.defaultConfig, ...config },
                  agentMeta: meta,
                }
                : block),
            },
          }));
          return;
        }
      }

      // Agent suggestions and newly unlocked features should never displace
      // the learner's existing workspace. Always append them at the bottom.
      const position = blocks.length;
      const newBlock: BlockInstance = {
        id: nextBlockId(),
        type,
        position,
        size: entry.defaultSize,
        config: { ...entry.defaultConfig, ...config },
        isVisible: true,
        isPinned: false,
        source: "SYSTEM_OPTIONAL",
        agentMeta: meta,
      };
      set((s) => {
        const allBlocks = [...s.spaceLayout.blocks, newBlock];
        return { spaceLayout: { ...s.spaceLayout, blocks: allBlocks.map((b, i) => ({ ...b, position: i })) } };
      });
    },

    approveAgentBlock: (blockId) => {
      const block = get().spaceLayout.blocks.find((b) => b.id === blockId);
      if (block) {
        const match = globalThis.location?.pathname?.match(/\/course\/([^/]+)/);
        const courseId = match?.[1] ?? "global";
        recordBlockEvent(courseId, block.type, "approve");
      }
      set((s) => ({
        spaceLayout: {
          ...s.spaceLayout,
          blocks: s.spaceLayout.blocks.map((b) =>
            b.id === blockId && b.agentMeta ? { ...b, agentMeta: { ...b.agentMeta, needsApproval: false } } : b,
          ),
        },
      }));
    },

    dismissAgentBlock: (blockId) => {
      const block = get().spaceLayout.blocks.find((b) => b.id === blockId);
      if (block) {
        // Derive courseId from URL path: /course/{id}/...
        const match = globalThis.location?.pathname?.match(/\/course\/([^/]+)/);
        const courseId = match?.[1] ?? "global";
        recordDismiss(courseId, block.type, block.agentMeta?.reason);
      }
      set((s) => ({
        spaceLayout: {
          ...s.spaceLayout,
          blocks: s.spaceLayout.blocks.filter((b) => b.id !== blockId).map((b, i) => ({ ...b, position: i })),
        },
      }));
    },

    loadBlocks: (layout) => {
      const parsed = parseSpaceLayout(layout);
      if (parsed) {
        set({ spaceLayout: normalizeSpaceLayout(parsed) });
      }
    },

    setLearningMode: (mode) => {
      if (mode === "maintenance") mode = "self_paced";
      const layout = buildLayoutFromMode(mode);
      set({ spaceLayout: normalizeSpaceLayout(layout) });
    },

    setSpaceMode: (mode) => {
      if (mode === "maintenance") mode = "self_paced";
      set((s) => ({ spaceLayout: { ...s.spaceLayout, mode } }));
    },

    layoutHistory: [],

    undoLayout: () => {
      const state = get();
      if (state.layoutHistory.length === 0) return false;
      const history = [...state.layoutHistory];
      const previous = history.pop()!;
      set({ spaceLayout: previous, layoutHistory: history });
      return true;
    },

    batchUpdateBlocks: (ops) => {
      set((state) => {
        const history = pushHistory(state.layoutHistory, state.spaceLayout);
        let blocks = [...state.spaceLayout.blocks];

        for (const op of ops) {
          if (op.action === "add") {
            const entry = BLOCK_REGISTRY[op.type];
            if (!entry) continue;
            blocks.push({
              id: nextBlockId(),
              type: op.type,
              position: blocks.length,
              size: op.size ?? entry.defaultSize,
              config: { ...entry.defaultConfig, ...op.config },
              isVisible: true,
              isPinned: false,
              source: "SYSTEM_OPTIONAL",
            });
          } else if (op.action === "remove") {
            blocks = blocks.filter((b) => b.id !== op.blockId || !canRemoveBlock(b.source));
          } else if (op.action === "reorder") {
            blocks = reorderBlocksByType(blocks, op.orderedTypes);
          } else if (op.action === "resize") {
            blocks = blocks.map((b) => (b.id === op.blockId ? { ...b, size: op.size } : b));
          } else if (op.action === "update_config") {
            blocks = blocks.map((b) =>
              b.id === op.blockId ? { ...b, config: { ...b.config, ...op.config } } : b,
            );
          }
        }

        return {
          layoutHistory: history,
          spaceLayout: normalizeSpaceLayout({ ...state.spaceLayout, blocks: blocks.map((b, i) => ({ ...b, position: i })) }),
        };
      });
    },
  };
}
