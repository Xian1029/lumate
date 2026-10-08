import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspaceStore } from "./workspace";

describe("useWorkspaceStore", () => {
  beforeEach(() => {
    // Reset store to initial state
    useWorkspaceStore.setState({
      activeSection: "notes",
      selectedNodeId: null,
      treeCollapsed: false,
      treeWidth: 240,
      chatHeight: 0.35,
      practiceActiveTab: null,
      spaceLayout: { templateId: null, blocks: [], columns: 2 },
      layoutHistory: [],
      lastRemovedBlock: null,
    });
  });

  describe("activeSection", () => {
    it("defaults to notes", () => {
      expect(useWorkspaceStore.getState().activeSection).toBe("notes");
    });

    it("can be changed", () => {
      useWorkspaceStore.getState().setActiveSection("practice");
      expect(useWorkspaceStore.getState().activeSection).toBe("practice");
    });
  });

  describe("tree controls", () => {
    it("toggles tree collapsed state", () => {
      expect(useWorkspaceStore.getState().treeCollapsed).toBe(false);
      useWorkspaceStore.getState().toggleTree();
      expect(useWorkspaceStore.getState().treeCollapsed).toBe(true);
      useWorkspaceStore.getState().toggleTree();
      expect(useWorkspaceStore.getState().treeCollapsed).toBe(false);
    });

    it("clamps tree width to valid range", () => {
      useWorkspaceStore.getState().setTreeWidth(50);
      expect(useWorkspaceStore.getState().treeWidth).toBe(140); // min

      useWorkspaceStore.getState().setTreeWidth(1000);
      expect(useWorkspaceStore.getState().treeWidth).toBe(480); // max
    });
  });

  describe("chat height", () => {
    it("clamps to valid range", () => {
      useWorkspaceStore.getState().setChatHeight(0.01);
      expect(useWorkspaceStore.getState().chatHeight).toBe(0.15);

      useWorkspaceStore.getState().setChatHeight(0.99);
      expect(useWorkspaceStore.getState().chatHeight).toBe(0.7);
    });
  });

  describe("section refresh", () => {
    it("increments refresh key for a section", () => {
      const initial = useWorkspaceStore.getState().sectionRefreshKey.notes;
      useWorkspaceStore.getState().triggerRefresh("notes");
      expect(useWorkspaceStore.getState().sectionRefreshKey.notes).toBe(initial + 1);
    });
  });

  describe("block system", () => {
    it("adds a block", () => {
      useWorkspaceStore.getState().addBlock("quiz");
      const blocks = useWorkspaceStore.getState().spaceLayout.blocks;
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("quiz");
      expect(blocks[0].source).toBe("USER_ADDED");
    });

    it("restores an existing hidden block instead of creating a duplicate", () => {
      useWorkspaceStore.getState().addBlock("quiz");
      const quiz = useWorkspaceStore.getState().spaceLayout.blocks[0];
      useWorkspaceStore.setState({
        spaceLayout: {
          ...useWorkspaceStore.getState().spaceLayout,
          blocks: [{ ...quiz, isVisible: false }],
        },
      });

      useWorkspaceStore.getState().addBlock("quiz");

      const blocks = useWorkspaceStore.getState().spaceLayout.blocks;
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual(expect.objectContaining({ type: "quiz", isVisible: true }));
    });

    it("appends newly unlocked agent blocks after existing blocks", () => {
      useWorkspaceStore.getState().addBlock("notes");
      useWorkspaceStore.getState().addBlock("quiz");
      useWorkspaceStore.getState().agentAddBlock(
        "agent_insight",
        { insightType: "feature_unlock", suggestedBlockType: "wrong_answers" },
        {
          reason: "Wrong answers unlocked",
          needsApproval: true,
          dismissible: true,
        },
      );

      const blocks = useWorkspaceStore.getState().spaceLayout.blocks;
      expect(blocks.map((block) => block.type)).toEqual(["notes", "quiz", "agent_insight"]);
      expect(blocks.map((block) => block.position)).toEqual([0, 1, 2]);
    });

    it("removes an optional block and supports undo", () => {
      useWorkspaceStore.getState().addBlock("review");
      const blockId = useWorkspaceStore.getState().spaceLayout.blocks[0].id;

      useWorkspaceStore.getState().removeBlock(blockId);
      expect(useWorkspaceStore.getState().spaceLayout.blocks).toHaveLength(0);
      expect(useWorkspaceStore.getState().lastRemovedBlock).not.toBeNull();

      useWorkspaceStore.getState().undoRemoveBlock();
      expect(useWorkspaceStore.getState().spaceLayout.blocks).toHaveLength(1);
    });

    it("removes optional blocks and lets the learner add them again", () => {
      useWorkspaceStore.getState().addBlock("quiz");
      useWorkspaceStore.getState().addBlock("flashcards");
      const [quiz, flashcards] = useWorkspaceStore.getState().spaceLayout.blocks;

      useWorkspaceStore.getState().removeBlock(quiz.id);
      useWorkspaceStore.getState().removeBlock(flashcards.id);

      expect(useWorkspaceStore.getState().spaceLayout.blocks).toEqual([]);
      useWorkspaceStore.getState().addBlock("quiz");
      expect(useWorkspaceStore.getState().spaceLayout.blocks.map((block) => block.type)).toEqual(["quiz"]);
    });

    it("persists independent pin and visibility state", () => {
      useWorkspaceStore.getState().addBlock("review");
      const id = useWorkspaceStore.getState().spaceLayout.blocks[0].id;
      useWorkspaceStore.getState().pinBlock(id);
      expect(useWorkspaceStore.getState().spaceLayout.blocks[0]).toEqual(expect.objectContaining({ isPinned: true, isVisible: true }));
      useWorkspaceStore.getState().unpinBlock(id);
      useWorkspaceStore.getState().hideBlock(id);
      expect(useWorkspaceStore.getState().spaceLayout.blocks[0]).toEqual(expect.objectContaining({ isPinned: false, isVisible: false }));
      useWorkspaceStore.getState().showBlock(id);
      expect(useWorkspaceStore.getState().spaceLayout.blocks[0].isVisible).toBe(true);
    });

    it("never removes required navigation or AI notes", () => {
      useWorkspaceStore.setState({
        spaceLayout: {
          templateId: null,
          columns: 2,
          blocks: [
            { id: "outline", type: "chapter_list", position: 0, size: "full", config: {}, isVisible: true, isPinned: false, source: "SYSTEM_REQUIRED" },
            { id: "notes", type: "notes", position: 1, size: "full", config: {}, isVisible: true, isPinned: false, source: "SYSTEM_REQUIRED" },
          ],
        },
      });
      useWorkspaceStore.getState().removeBlock("outline");
      useWorkspaceStore.getState().removeBlock("notes");
      expect(useWorkspaceStore.getState().spaceLayout.blocks).toHaveLength(2);
    });

    it("resizes a block", () => {
      useWorkspaceStore.getState().addBlock("quiz");
      const blockId = useWorkspaceStore.getState().spaceLayout.blocks[0].id;

      useWorkspaceStore.getState().resizeBlock(blockId, "full");
      expect(useWorkspaceStore.getState().spaceLayout.blocks[0].size).toBe("full");
    });

    it("updates block config", () => {
      useWorkspaceStore.getState().addBlock("quiz");
      const blockId = useWorkspaceStore.getState().spaceLayout.blocks[0].id;

      useWorkspaceStore.getState().updateBlockConfig(blockId, { difficulty: "hard" });
      expect(useWorkspaceStore.getState().spaceLayout.blocks[0].config.difficulty).toBe("hard");
    });
  });

  describe("layout history", () => {
    it("supports undo", () => {
      useWorkspaceStore.getState().addBlock("quiz");
      expect(useWorkspaceStore.getState().spaceLayout.blocks).toHaveLength(1);

      const undone = useWorkspaceStore.getState().undoLayout();
      expect(undone).toBe(true);
      expect(useWorkspaceStore.getState().spaceLayout.blocks).toHaveLength(0);
    });

    it("returns false when no history", () => {
      const undone = useWorkspaceStore.getState().undoLayout();
      expect(undone).toBe(false);
    });
  });
});
