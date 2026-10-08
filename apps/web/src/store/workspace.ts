/**
 * Workspace state management using Zustand.
 *
 * Controls active sections, pane sizing, and block-system state.
 * Block system operations are extracted to workspace-blocks.ts.
 */

import { create } from "zustand";
import type { CognitiveState } from "@/lib/api";
import { type BlockSystemState, createBlockSlice } from "./workspace-blocks";

export type SectionId = "notes" | "practice" | "analytics" | "plan";

/**
 * Ephemeral note editing state shared by the compact block and its immersive
 * drawer. It is intentionally UI-only: saved notes remain server-owned.
 */
export interface NoteDraftSession {
  courseId: string;
  title: string;
  markdown: string;
  format: string;
  sourceNodeId: string;
}

interface CoreWorkspaceState {
  activeSection: SectionId;
  setActiveSection: (id: SectionId) => void;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  treeCollapsed: boolean;
  toggleTree: () => void;
  treeWidth: number;
  setTreeWidth: (w: number) => void;
  chatHeight: number;
  setChatHeight: (h: number) => void;
  sectionRefreshKey: Record<string, number>;
  triggerRefresh: (section: SectionId) => void;
  practiceActiveTab: string | null;
  setPracticeTab: (tab: string | null) => void;
  /** Latest cognitive state from the Block Decision Engine. */
  cognitiveState: CognitiveState | null;
  setCognitiveState: (state: CognitiveState) => void;

  /** Notes drawer open state (right-side panel). */
  notesDrawerOpen: boolean;
  setNotesDrawerOpen: (open: boolean) => void;
  noteDraft: NoteDraftSession | null;
  setNoteDraft: (draft: NoteDraftSession | null) => void;
}

type WorkspaceState = CoreWorkspaceState & BlockSystemState;

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  activeSection: "notes",
  setActiveSection: (id) => set({ activeSection: id }),

  selectedNodeId: null,
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),

  treeCollapsed: false,
  toggleTree: () => set((s) => ({ treeCollapsed: !s.treeCollapsed })),

  treeWidth: 240,
  setTreeWidth: (w) => set({ treeWidth: Math.max(140, Math.min(480, w)) }),

  chatHeight: 0.35,
  setChatHeight: (h) => set({ chatHeight: Math.max(0.15, Math.min(0.7, h)) }),

  sectionRefreshKey: { notes: 0, practice: 0, analytics: 0, plan: 0 },
  triggerRefresh: (section) =>
    set((s) => ({
      sectionRefreshKey: {
        ...s.sectionRefreshKey,
        [section]: (s.sectionRefreshKey[section] ?? 0) + 1,
      },
    })),

  practiceActiveTab: null,
  setPracticeTab: (tab) => set({ practiceActiveTab: tab }),

  cognitiveState: null,
  setCognitiveState: (state) => set({ cognitiveState: state }),

  notesDrawerOpen: false,
  setNotesDrawerOpen: (open) => set({ notesDrawerOpen: open }),
  noteDraft: null,
  setNoteDraft: (draft) => set({ noteDraft: draft }),

  // Block system (extracted to workspace-blocks.ts)
  ...createBlockSlice(set, get),
}));
