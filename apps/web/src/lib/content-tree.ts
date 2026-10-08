import type { ContentNode } from "@/lib/api";

const NON_LEARNING_CATEGORIES = new Set(["reference", "syllabus", "assignment", "exam_schedule", "other"]);
// Imported textbooks often contain a real-looking text node for the cover,
// foreword or table of contents.  It is source material, not a lesson: it
// must never unlock practice, alter progress, or become a recommendation.
const NON_LEARNING_TITLES = /^(?:前言与目录|目\s*录|contents?|前\s*言|序(?:言)?|引\s*言|致读者|使用说明|编写说明|出版说明|版权页|附录|参考文献|索引|preface|foreword|introduction)$/i;

function normalizedTitle(title: string | null | undefined): string {
  return (title ?? "").trim().replace(/\s+/g, " ");
}

export function isLearnableContentNode(node: ContentNode): boolean {
  return Boolean(node.content?.trim())
    && !NON_LEARNING_CATEGORIES.has(node.content_category ?? "")
    && !NON_LEARNING_TITLES.test(normalizedTitle(node.title));
}

/** A quiz needs a precise lesson context, not a book/chapter container. */
export function isPracticeEligibleContentNode(node: ContentNode): boolean {
  return isLearnableContentNode(node) && (node.children?.length ?? 0) === 0;
}

export function findFirstContentNode(nodes: ContentNode[]): ContentNode | null {
  for (const node of nodes) {
    if (isLearnableContentNode(node)) return node;
    const child = findFirstContentNode(node.children ?? []);
    if (child) return child;
  }
  return null;
}

/** Choose the first actual lesson beneath a chapter, keeping navigation and notes aligned. */
export function getPreferredLearningNode(node: ContentNode): ContentNode {
  const children = [...(node.children ?? [])].sort((a, b) => a.order_index - b.order_index);
  const firstLesson = findFirstContentNode(children);
  if (firstLesson) return firstLesson;

  let candidate = children[0];
  while (candidate?.children?.length) {
    candidate = [...candidate.children].sort((a, b) => a.order_index - b.order_index)[0];
  }
  return candidate ?? node;
}

export function findNodeById(nodes: ContentNode[], nodeId: string | null): ContentNode | null {
  if (!nodeId) return null;
  for (const node of nodes) {
    if (node.id === nodeId) return node;
    const child = findNodeById(node.children ?? [], nodeId);
    if (child) return child;
  }
  return null;
}

export function collectContentNodes(nodes: ContentNode[]): ContentNode[] {
  const result: ContentNode[] = [];
  for (const node of nodes) {
    if (isLearnableContentNode(node)) result.push(node);
    if (node.children?.length) {
      result.push(...collectContentNodes(node.children));
    }
  }
  return result;
}

export function findPathToNode(nodes: ContentNode[], nodeId: string): ContentNode[] {
  const walk = (items: ContentNode[], trail: ContentNode[]): ContentNode[] | null => {
    for (const item of items) {
      const nextTrail = [...trail, item];
      if (item.id === nodeId) return nextTrail;
      if (item.children?.length) {
        const found = walk(item.children, nextTrail);
        if (found) return found;
      }
    }
    return null;
  };

  return walk(nodes, []) ?? [];
}

/**
 * Stable material context for a selected node.  Descendants normally inherit
 * `source_file`, but older imports only recorded it on an ancestor, so walk
 * the path from the textbook root instead of relying on a single node.
 */
export function getContentNodeMaterialKey(nodes: ContentNode[], nodeId: string | null): string | null {
  if (!nodeId) return null;
  const path = findPathToNode(nodes, nodeId);
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const sourceFile = path[index].source_file?.trim();
    if (sourceFile) return sourceFile;
  }
  return null;
}

function collectTitles(node: ContentNode): string[] {
  const titles: string[] = [node.title];
  for (const child of node.children ?? []) {
    titles.push(...collectTitles(child));
  }
  return titles;
}

export function buildFocusTerms(node: ContentNode): string[] {
  const tokens = collectTitles(node)
    .flatMap((title) =>
      title
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fa5]+/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 2),
    )
    .filter((token, idx, arr) => arr.indexOf(token) === idx);

  return tokens.slice(0, 12);
}
