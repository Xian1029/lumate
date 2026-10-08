import { describe, expect, it } from "vitest";
import {
  buildFocusTerms,
  collectContentNodes,
  findFirstContentNode,
  findNodeById,
  findPathToNode,
  getContentNodeMaterialKey,
  getPreferredLearningNode,
  isLearnableContentNode,
  isPracticeEligibleContentNode,
} from "./content-tree";
import type { ContentNode } from "@/lib/api";

const tree: ContentNode[] = [
  {
    id: "chapter-1",
    title: "Chapter 1",
    type: "section",
    content: "",
    level: 1,
    order_index: 0,
    source_type: "file",
    children: [
      {
        id: "node-a",
        title: "Binary Search",
        type: "topic",
        content: "How binary search works",
        level: 2,
        order_index: 0,
        source_type: "file",
        children: [],
      },
      {
        id: "node-b",
        title: "Two Pointers",
        type: "section",
        content: "",
        level: 2,
        order_index: 1,
        source_type: "file",
        children: [
          {
            id: "node-c",
            title: "Sliding Window",
            type: "topic",
            content: "Window technique notes",
            level: 3,
            order_index: 0,
            source_type: "file",
            children: [],
          },
        ],
      },
    ],
  },
];

describe("getPreferredLearningNode", () => {
  it("opens a chapter at its first lesson instead of the chapter container", () => {
    expect(getPreferredLearningNode(tree[0] as never).id).toBe("node-a");
  });
});

describe("content-tree helpers", () => {
  it("finds the first node with content", () => {
    expect(findFirstContentNode(tree)?.id).toBe("node-a");
  });

  it("finds nodes by id", () => {
    expect(findNodeById(tree, "node-c")?.title).toBe("Sliding Window");
    expect(findNodeById(tree, "missing")).toBeNull();
  });

  it("collects content nodes in traversal order", () => {
    expect(collectContentNodes(tree).map((node) => node.id)).toEqual(["node-a", "node-c"]);
  });

  it("builds the path to a nested node", () => {
    expect(findPathToNode(tree, "node-c").map((node) => node.id)).toEqual([
      "chapter-1",
      "node-b",
      "node-c",
    ]);
  });

  it("builds deduplicated focus terms from titles", () => {
    expect(buildFocusTerms(tree[0].children![1]).slice(0, 4)).toEqual([
      "two",
      "pointers",
      "sliding",
      "window",
    ]);
  });

  it("keeps textbook front matter out of learning and practice contexts", () => {
    const preface: ContentNode = { ...tree[0].children![0], id: "preface", title: "前言与目录", content: "目录\n第一章" };
    expect(isLearnableContentNode(preface)).toBe(false);
    expect(isPracticeEligibleContentNode(preface)).toBe(false);
  });

  it("requires a specific leaf lesson for practice", () => {
    const sectionWithChildren: ContentNode = { ...tree[0], content: "Chapter overview" };
    expect(isPracticeEligibleContentNode(sectionWithChildren)).toBe(false);
    expect(isPracticeEligibleContentNode(tree[0].children![0])).toBe(true);
  });

  it("resolves material context from an ancestor for older imported trees", () => {
    const materialTree: ContentNode[] = [{
      ...tree[0], id: "book", source_file: "数学上册.pdf", children: [{
        ...tree[0].children![0], id: "lesson", source_file: null,
      }],
    }];
    expect(getContentNodeMaterialKey(materialTree, "lesson")).toBe("数学上册.pdf");
  });
});
