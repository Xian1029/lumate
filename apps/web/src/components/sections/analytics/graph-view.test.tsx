import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import { GraphView, splitGraphLabel } from "./graph-view";
import { getKnowledgeGraphCanvasBounds, layoutKnowledgeGraph } from "./graph-simulation";

const getKnowledgeGraph = vi.fn();
const getCourseLearningPlanDashboard = vi.fn();

vi.mock("@/lib/api", () => ({
  getKnowledgeGraph: (...args: unknown[]) => getKnowledgeGraph(...args),
  getCourseLearningPlanDashboard: (...args: unknown[]) => getCourseLearningPlanDashboard(...args),
}));

vi.mock("@/lib/error-telemetry", () => ({
  trackApiFailure: vi.fn(),
}));

vi.mock("@/lib/i18n-context", () => ({
  useT: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("GraphView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCourseLearningPlanDashboard.mockResolvedValue({ workspace_progress: { completed_learning_items: 0, total_learning_items: 0, progress_percent: null } });
  });

  it("renders empty state when the graph has no nodes", async () => {
    getKnowledgeGraph.mockResolvedValue({ nodes: [], edges: [] });

    render(<GraphView courseId="course-1" />);

    await screen.findByText("graph.emptyHint");
    expect(getKnowledgeGraph).toHaveBeenCalledWith("course-1");
  });

  it("wraps long Chinese node labels without losing the label text", () => {
    const label = "有理数的加法与减法运算";
    expect(splitGraphLabel(label).join("")).toBe(label);
    expect(splitGraphLabel(label)).toHaveLength(2);
  });

  it("marks only nodes belonging to the actively viewed textbook", async () => {
    getKnowledgeGraph.mockResolvedValue({
      nodes: [
        { id: "a", label: "数轴", level: 1, size: 12, color: "#94a3b8", status: "not_started", mastery: 0, material_id: "数学上册.pdf" },
        { id: "b", label: "三角形", level: 1, size: 12, color: "#94a3b8", status: "not_started", mastery: 0, material_id: "数学下册.pdf" },
      ],
      edges: [],
    });
    const { container } = render(<GraphView courseId="course-1" activeMaterialId="数学上册.pdf" />);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-current-material="true"]')).toHaveLength(1);
    });
  });

  it("keeps graph card positions stable and separate", () => {
    const graphNodes = ["正数和负数", "有理数比较", "有理数加法", "有理数乘方"].map((label, index) => ({
      id: String(index), label, level: 1, size: 12, color: "#94a3b8", status: "not_started", mastery: 0,
    }));
    const first = layoutKnowledgeGraph(graphNodes, []);
    const second = layoutKnowledgeGraph(graphNodes, []);

    expect(first.map(({ x, y }) => [x, y])).toEqual(second.map(({ x, y }) => [x, y]));
    expect(new Set(first.map(({ x, y }) => `${x}:${y}`)).size).toBe(graphNodes.length);
  });

  it("lays prerequisite routes left to right at every course-space width", () => {
    const graphNodes = ["基础", "比较", "加减", "乘除", "乘方"].map((label, index) => ({
      id: String(index), label, level: 1, size: 12, color: "#94a3b8", status: "not_started", mastery: 0,
    }));
    const graphEdges = [1, 2, 3, 4].map((index) => ({
      source: String(index), target: String(index - 1), type: "prerequisite",
    }));

    for (const width of [640, 900, 1280]) {
      const route = layoutKnowledgeGraph(graphNodes, graphEdges, width, 520);
      expect(route.map((node) => node.x)).toEqual([...route].sort((a, b) => a.x - b.x).map((node) => node.x));
      for (let index = 1; index < route.length; index++) {
        const previous = route[index - 1];
        const current = route[index];
        expect(current.x - current.cardWidth / 2).toBeGreaterThanOrEqual(previous.x + previous.cardWidth / 2);
      }
    }
  });

  it("keeps every branch card inside the graph frame", () => {
    const graphNodes = Array.from({ length: 9 }, (_, index) => ({
      id: String(index), label: `知识点${index + 1}`, level: 1, size: 12, color: "#94a3b8", status: "not_started", mastery: 0,
    }));
    const graphEdges = [
      { source: "1", target: "0", type: "prerequisite" },
      { source: "2", target: "1", type: "prerequisite" },
      { source: "3", target: "2", type: "prerequisite" },
      { source: "4", target: "3", type: "prerequisite" },
      { source: "6", target: "5", type: "prerequisite" },
      { source: "7", target: "6", type: "prerequisite" },
      { source: "8", target: "5", type: "prerequisite" },
    ];
    const route = layoutKnowledgeGraph(graphNodes, graphEdges, 884, 500);

    for (const node of route) {
      expect(node.x - node.cardWidth / 2).toBeGreaterThanOrEqual(0);
      expect(node.x + node.cardWidth / 2).toBeLessThanOrEqual(884);
      expect(node.y - node.cardHeight / 2).toBeGreaterThanOrEqual(0);
      expect(node.y + node.cardHeight / 2).toBeLessThanOrEqual(500);
    }
  });

  it("expands the canvas for a large multi-textbook graph instead of overlapping cards", () => {
    const graphNodes = Array.from({ length: 18 }, (_, index) => ({
      id: String(index), label: `教材知识点${index + 1}`, level: 1, size: 12, color: "#94a3b8", status: "not_started", mastery: 0,
    }));
    const graphEdges = graphNodes.slice(6).map((node, index) => ({
      source: node.id, target: String(index % 6), type: "prerequisite",
    }));
    const bounds = getKnowledgeGraphCanvasBounds(graphNodes, graphEdges, 640, 500);
    const route = layoutKnowledgeGraph(graphNodes, graphEdges, bounds.width, bounds.height);

    expect(bounds.height).toBeGreaterThan(500);
    for (let index = 0; index < route.length; index++) {
      for (let otherIndex = index + 1; otherIndex < route.length; otherIndex++) {
        const first = route[index];
        const second = route[otherIndex];
        const overlaps = Math.abs(first.x - second.x) < (first.cardWidth + second.cardWidth) / 2
          && Math.abs(first.y - second.y) < (first.cardHeight + second.cardHeight) / 2;
        expect(overlaps).toBe(false);
      }
    }
  });
});
