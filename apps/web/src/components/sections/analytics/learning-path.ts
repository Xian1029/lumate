import type { KnowledgeGraphEdge, KnowledgeGraphNode } from "@/lib/api";

export type LearningNodeStatus = "mastered" | "learning" | "available" | "locked" | "review";

export interface LearningPathNode extends KnowledgeGraphNode {
  prerequisiteIds: string[];
  successorIds: string[];
  tier: number;
  stageId: string;
  statusLabel: LearningNodeStatus;
  lockReason: string | null;
  relationHint: string | null;
}

export interface LearningStage {
  id: string;
  title: string;
  goal: string;
  nodes: LearningPathNode[];
  completedCount: number;
  unlocked: boolean;
}

export interface LearningPathPlan {
  nodes: LearningPathNode[];
  stages: LearningStage[];
  recommended: LearningPathNode | null;
  alternatives: LearningPathNode[];
  totalCount: number;
  completedCount: number;
  overallProgress: number;
  emptyReason: "complete" | "blocked" | "missing" | null;
}

export interface LearningPathOptions {
  /** Current textbook context prioritises, but never filters, recommendations. */
  activeMaterialId?: string | null;
}

/** Keep recommendations in the server-provided textbook/TOC order.
 *
 * ``curriculum_order`` comes from the parsed source tree.  It is deliberately
 * separate from prerequisite depth: a textbook's printed order is useful for
 * choosing the first available item, but it must not be misrepresented as a
 * hard prerequisite relationship.
 */
function compareCurriculumOrder(a: KnowledgeGraphNode, b: KnowledgeGraphNode): number {
  const aMaterial = a.material_order ?? Number.MAX_SAFE_INTEGER;
  const bMaterial = b.material_order ?? Number.MAX_SAFE_INTEGER;
  const aOrder = a.curriculum_order ?? Number.MAX_SAFE_INTEGER;
  const bOrder = b.curriculum_order ?? Number.MAX_SAFE_INTEGER;
  return aMaterial - bMaterial || aOrder - bOrder || a.label.localeCompare(b.label, "zh-Hans-CN");
}

function buildTier(
  id: string,
  prerequisites: Map<string, string[]>,
  cache: Map<string, number>,
  visiting = new Set<string>(),
): number {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  if (visiting.has(id)) return 0;
  visiting.add(id);
  const previous = prerequisites.get(id) ?? [];
  const tier = previous.length ? Math.max(...previous.map((item) => buildTier(item, prerequisites, cache, visiting))) + 1 : 0;
  visiting.delete(id);
  cache.set(id, tier);
  return tier;
}

/**
 * Converts the existing graph payload into learner-facing path information.
 * The backend stores a prerequisite edge as “later concept -> prerequisite”,
 * so this function deliberately reverses it only for the displayed journey.
 */
export function buildLearningPathPlan(
  graphNodes: KnowledgeGraphNode[],
  graphEdges: KnowledgeGraphEdge[],
  options: LearningPathOptions = {},
): LearningPathPlan {
  if (!graphNodes.length) {
    return { nodes: [], stages: [], recommended: null, alternatives: [], totalCount: 0, completedCount: 0, overallProgress: 0, emptyReason: "missing" };
  }

  const knownIds = new Set(graphNodes.map((node) => node.id));
  const prerequisites = new Map(graphNodes.map((node) => [node.id, [] as string[]]));
  const successors = new Map(graphNodes.map((node) => [node.id, [] as string[]]));
  for (const edge of graphEdges) {
    if (edge.type !== "prerequisite" || !knownIds.has(edge.source) || !knownIds.has(edge.target)) continue;
    prerequisites.get(edge.source)?.push(edge.target);
    successors.get(edge.target)?.push(edge.source);
  }

  const byId = new Map(graphNodes.map((node) => [node.id, node]));
  const tiers = new Map<string, number>();
  // A learning stage is a prerequisite depth, not a disconnected graph
  // component.  Separate textbooks may be independent branches, but their
  // first learnable concepts still belong to the learner's first stage.
  const tierByNode = new Map<string, number>();
  for (const node of graphNodes) tierByNode.set(node.id, buildTier(node.id, prerequisites, tiers));
  const stageTiers = [...new Set(tierByNode.values())].sort((a, b) => a - b);
  const stageByNode = new Map<string, string>();
  stageTiers.forEach((tier, index) => {
    for (const [id, nodeTier] of tierByNode) if (nodeTier === tier) stageByNode.set(id, `stage-${index + 1}`);
  });

  const nodes = graphNodes.map<LearningPathNode>((node) => {
    const prerequisiteIds = prerequisites.get(node.id) ?? [];
    const successorIds = successors.get(node.id) ?? [];
    const unmet = prerequisiteIds.filter((id) => byId.get(id)?.status !== "mastered");
    const mastered = node.status === "mastered";
    // Reuse the API's existing status classification rather than inventing a
    // new numerical mastery threshold in the client.
    const started = node.status === "in_progress";
    const needsReview = node.status === "reviewed";
    const statusLabel: LearningNodeStatus = mastered
      ? "mastered"
      : unmet.length
        ? "locked"
        : started
          ? "learning"
          : needsReview
            ? "review"
            : "available";
    const lockReason = unmet.length
      ? unmet.length === 1
        ? `完成“${byId.get(unmet[0])?.label ?? "前置知识"}”后解锁`
        : `需完成 ${unmet.length} 个前置知识点`
      : null;
    const relationHint = prerequisiteIds.length >= 2
      ? "需完成以下全部前置知识"
      : successorIds.length >= 2
        ? "完成后会解锁多个后续知识点"
        : prerequisiteIds.length === 1
          ? `完成“${byId.get(prerequisiteIds[0])?.label ?? "前置知识"}”后学习`
          : null;
    return {
      ...node,
      prerequisiteIds,
      successorIds,
      tier: tierByNode.get(node.id) ?? 0,
      stageId: stageByNode.get(node.id) ?? "stage-1",
      statusLabel,
      lockReason,
      relationHint,
    };
  });

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const stages = stageTiers.map((tier, index) => {
    const stageNodes = nodes.filter((node) => node.tier === tier)
      .sort(compareCurriculumOrder);
    const roots = stageNodes.filter((node) => node.prerequisiteIds.length === 0);
    const completedCount = stageNodes.filter((node) => node.statusLabel === "mastered").length;
    return {
      id: `stage-${index + 1}`,
      title: index === 0 ? "基础学习" : `进阶学习 ${index}`,
      goal: index === 0
        ? roots.length > 1
          ? `本阶段有 ${roots.length} 个可并行起步的知识点，完成后进入下一阶段`
          : `从“${roots[0]?.label ?? stageNodes[0]?.label}”开始，完成本阶段基础内容`
        : `每个知识点会在自己的前置内容完成后开放；其他学习支线不会阻塞这里`,
      nodes: stageNodes,
      completedCount,
      // A prerequisite tier is a visual grouping, not a global gate. An
      // unrelated root topic must never block an otherwise-ready concept.
      unlocked: stageNodes.some((node) => node.statusLabel !== "locked"),
    };
  });

  const candidates = nodes.filter((node) => ["learning", "review", "available"].includes(node.statusLabel));
  const isUnlockedContinuation = (node: LearningPathNode) =>
    node.prerequisiteIds.length > 0 && node.prerequisiteIds.every((id) => nodeMap.get(id)?.statusLabel === "mastered");
  // Continue work before opening a new independent topic. Review signals and
  // actual prerequisite readiness are stronger evidence than a global stage.
  candidates.sort((a, b) => {
    const priority = (node: LearningPathNode) => node.statusLabel === "learning" ? 0
      : node.statusLabel === "review" ? 1
        : isUnlockedContinuation(node) ? 2
          : node.material_id === options.activeMaterialId ? 3 : 4;
    const aCurrentMaterial = a.material_id === options.activeMaterialId ? 0 : 1;
    const bCurrentMaterial = b.material_id === options.activeMaterialId ? 0 : 1;
    return priority(a) - priority(b)
      || aCurrentMaterial - bCurrentMaterial
      || a.tier - b.tier
      || compareCurriculumOrder(a, b);
  });
  const recommended = candidates[0] ?? null;
  const alternatives = recommended
    ? candidates.filter((node) => node.id !== recommended.id
      && recommended.prerequisiteIds.length > 0
      && node.prerequisiteIds.some((id) => recommended.prerequisiteIds.includes(id))).slice(0, 3)
    : [];
  const completedCount = nodes.filter((node) => node.statusLabel === "mastered").length;
  return {
    nodes,
    stages,
    recommended,
    alternatives,
    totalCount: nodes.length,
    completedCount,
    overallProgress: nodes.length ? Math.round((completedCount / nodes.length) * 100) : 0,
    emptyReason: recommended ? null : completedCount === nodes.length ? "complete" : "blocked",
  };
}
