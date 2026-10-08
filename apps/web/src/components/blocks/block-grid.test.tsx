import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test-utils";
import { BlockGrid } from "./block-grid";
import { useCourseStore } from "@/store/course";

vi.mock("@/hooks/use-roving-tabindex", () => ({
  useRovingTabindex: vi.fn(),
}));

vi.mock("./block-wrapper", () => ({
  BlockWrapper: ({ block }: { block: { type: string } }) => (
    <div data-testid={`block-${block.type}`}>Block: {block.type}</div>
  ),
}));

vi.mock("./block-palette", () => ({
  BlockPalette: () => <div data-testid="block-palette" />,
}));

vi.mock("@/lib/block-system/registry", () => ({
  BLOCK_REGISTRY: {
    notes: { label: "Notes" },
    quiz: { label: "Quiz" },
    flashcards: { label: "Flashcards" },
    progress: { label: "Progress" },
  },
}));

const MOCK_BLOCKS = [
  { id: "b1", type: "notes", position: 0, size: "large", visible: true, source: "template", config: {} },
  { id: "b2", type: "quiz", position: 1, size: "medium", visible: true, source: "template", config: {} },
  { id: "b3", type: "flashcards", position: 2, size: "medium", visible: true, source: "template", config: {} },
  { id: "b4", type: "progress", position: 3, size: "small", visible: false, source: "template", config: {} },
];

let mockBlocks = MOCK_BLOCKS;
let mockFocusedBlockId: string | null = null;
let mockSelectedNodeId: string | null = "lesson-1";

vi.mock("@/store/workspace", () => ({
  useWorkspaceStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ selectedNodeId: mockSelectedNodeId, spaceLayout: { blocks: mockBlocks, columns: 2, focusedBlockId: mockFocusedBlockId } }),
    {
      getState: () => ({ spaceLayout: { blocks: mockBlocks, columns: 2, focusedBlockId: mockFocusedBlockId } }),
    },
  ),
}));

describe("BlockGrid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBlocks = MOCK_BLOCKS;
    mockFocusedBlockId = null;
    mockSelectedNodeId = "lesson-1";
    useCourseStore.setState({
      contentTreeCourseId: "test",
      contentTree: [{
        id: "lesson-1", title: "1.1 正数和负数", type: "section", content: "有效学习内容", level: 2,
        order_index: 0, source_type: "pdf", children: [],
      }],
    });
  });

  it("renders visible blocks as list items", () => {
    render(<BlockGrid courseId="test" aiActionsEnabled={false} />);
    const items = screen.getAllByRole("listitem");
    // Three visible blocks; both practice blocks have a valid selected lesson.
    expect(items).toHaveLength(3);
  });

  it("has proper ARIA role=list with label", () => {
    render(<BlockGrid courseId="test" aiActionsEnabled={false} />);
    expect(screen.getByRole("list", { name: /Workspace blocks|工作区模块/ })).toBeInTheDocument();
  });

  it("renders eager block content through BlockWrapper", () => {
    render(<BlockGrid courseId="test" aiActionsEnabled={false} />);
    expect(screen.getByTestId("block-notes")).toBeInTheDocument();
    expect(screen.getByTestId("block-quiz")).toBeInTheDocument();
  });

  it("keeps the add-block palette available when no visible blocks exist", () => {
    mockBlocks = MOCK_BLOCKS.map((b) => ({ ...b, visible: false }));
    const { container } = render(<BlockGrid courseId="test" aiActionsEnabled={false} />);
    expect(container.querySelector("[role='list']")).not.toBeInTheDocument();
    expect(screen.getByTestId("block-palette")).toBeInTheDocument();
  });

  it("renders blocks sorted by position", () => {
    mockBlocks = [
      { id: "b2", type: "quiz", position: 1, size: "medium", visible: true, source: "template", config: {} },
      { id: "b1", type: "notes", position: 0, size: "large", visible: true, source: "template", config: {} },
    ];
    render(<BlockGrid courseId="test" aiActionsEnabled={false} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    // First item should be notes (position 0), second should be quiz (position 1)
    expect(items[0]).toHaveTextContent("notes");
    expect(items[1]).toHaveTextContent("quiz");
  });

  it("renders block palette for adding blocks", () => {
    render(<BlockGrid courseId="test" aiActionsEnabled={false} />);
    expect(screen.getByTestId("block-palette")).toBeInTheDocument();
  });

  it("hides quiz until a specific practice-eligible lesson is selected", () => {
    mockSelectedNodeId = null;
    render(<BlockGrid courseId="test" aiActionsEnabled={false} />);
    expect(screen.getByTestId("block-notes")).toBeInTheDocument();
    expect(screen.queryByTestId("block-quiz")).not.toBeInTheDocument();
    expect(screen.queryByTestId("block-flashcards")).not.toBeInTheDocument();
  });

  it("shows only the pinned block in focused study mode", () => {
    mockFocusedBlockId = "b1";
    render(<BlockGrid courseId="test" aiActionsEnabled={false} />);
    expect(screen.getByTestId("block-notes")).toBeInTheDocument();
    expect(screen.queryByTestId("block-quiz")).not.toBeInTheDocument();
    expect(screen.queryByTestId("block-palette")).not.toBeInTheDocument();
  });
});
