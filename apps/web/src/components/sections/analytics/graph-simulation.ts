import type { KnowledgeGraphNode, KnowledgeGraphEdge } from "@/lib/api";

// The graph is rendered inside cards as well as the full-screen learning
// space. A deterministic layout avoids force-directed graphs changing shape
// on refresh and turning labels into an unreadable constellation.
export const WIDTH = 800;
export const HEIGHT = 600;
export const CARD_WIDTH = 208;
export const CARD_HEIGHT = 104;
export const GRAPH_PADDING_X = 54;
export const GRAPH_PADDING_TOP = 108;
export const GRAPH_PADDING_BOTTOM = 48;

export interface SimNode extends KnowledgeGraphNode {
  x: number;
  y: number;
  learningTier: number;
  isSequenced: boolean;
  routeId: number;
  cardWidth: number;
  cardHeight: number;
}

export interface GraphCanvasBounds {
  width: number;
  height: number;
}

function learningTier(
  nodeId: string,
  edges: KnowledgeGraphEdge[],
  cache: Map<string, number>,
  visiting = new Set<string>(),
): number {
  const known = cache.get(nodeId);
  if (known !== undefined) return known;
  if (visiting.has(nodeId)) return 0;

  visiting.add(nodeId);
  // A prerequisite edge is stored as “concept -> prerequisite”, so the
  // prerequisite belongs one tier before the current concept.
  const prerequisites = edges
    .filter((edge) => edge.type === "prerequisite" && edge.source === nodeId)
    .map((edge) => edge.target);
  const tier = prerequisites.length
    ? Math.min(9, Math.max(...prerequisites.map((id) => learningTier(id, edges, cache, visiting))) + 1)
    : 0;
  visiting.delete(nodeId);
  cache.set(nodeId, tier);
  return tier;
}

/** Place concepts in a stable reading order, with prerequisite depth first. */
export function layoutKnowledgeGraph(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[],
  canvasWidth = WIDTH,
  canvasHeight = HEIGHT,
): SimNode[] {
  const tierCache = new Map<string, number>();
  const ordered = [...nodes]
    .map((node) => ({ node, tier: learningTier(node.id, edges, tierCache) }))
    .sort((a, b) => a.tier - b.tier || a.node.label.localeCompare(b.node.label, "zh-Hans-CN"));

  const prerequisiteEdges = edges.filter((edge) => edge.type === "prerequisite");
  const sequencedIds = new Set(prerequisiteEdges.flatMap((edge) => [edge.source, edge.target]));
  const materialOrders = [...new Set(nodes
    .map((node) => node.material_order)
    .filter((value): value is number => typeof value === "number"))]
    .sort((a, b) => a - b);

  // Multi-textbook learning spaces need a stable, readable home for every
  // uploaded material. Grouping a complete source tree by material prevents
  // the few AI prerequisite edges from collapsing hundreds of unrelated
  // chapter cards into one narrow lane.
  if (materialOrders.length > 1) {
    const laneByMaterial = new Map(materialOrders.map((order, index) => [order, index]));
    const grouped = new Map<number, typeof ordered>();
    for (const entry of ordered) {
      const lane = laneByMaterial.get(entry.node.material_order ?? materialOrders[0]) ?? 0;
      grouped.set(lane, [...(grouped.get(lane) ?? []), entry]);
    }
    const laneWidth = CARD_WIDTH + 34;
    const positioned: SimNode[] = [];
    for (const [lane, members] of grouped) {
      members.sort((a, b) =>
        (a.node.curriculum_order ?? Number.MAX_SAFE_INTEGER) - (b.node.curriculum_order ?? Number.MAX_SAFE_INTEGER)
        || a.node.label.localeCompare(b.node.label, "zh-Hans-CN"));
      members.forEach(({ node, tier }, index) => positioned.push({
        ...node,
        x: GRAPH_PADDING_X + CARD_WIDTH / 2 + lane * laneWidth,
        y: GRAPH_PADDING_TOP + CARD_HEIGHT / 2 + index * (CARD_HEIGHT + 22),
        learningTier: tier,
        isSequenced: sequencedIds.has(node.id),
        routeId: lane,
        cardWidth: CARD_WIDTH,
        cardHeight: CARD_HEIGHT,
      }));
    }
    return positioned;
  }
  // Put every prerequisite depth in one vertical lane.  The former layout
  // split disconnected components into independently compressed routes;
  // cards in large uploads then collided and visually implied false stage
  // relationships.  A single tier layout is both complete and readable.
  if (sequencedIds.size >= 2) {
    const tierCount = Math.max(...ordered.map((entry) => entry.tier)) + 1;
    const groups = new Map<number, typeof ordered>();
    for (const entry of ordered) groups.set(entry.tier, [...(groups.get(entry.tier) ?? []), entry]);
    const largestGroup = Math.max(...[...groups.values()].map((group) => group.length));
    const usableHeight = canvasHeight - GRAPH_PADDING_TOP - GRAPH_PADDING_BOTTOM;
    const cardWidth = Math.min(CARD_WIDTH, Math.max(92, (canvasWidth - GRAPH_PADDING_X * 2) / tierCount - 16));
    const cardHeight = Math.min(CARD_HEIGHT, Math.max(88, Math.floor((usableHeight - Math.max(0, largestGroup - 1) * 24) / largestGroup)));
    const laneStart = GRAPH_PADDING_X + cardWidth / 2;
    const laneEnd = canvasWidth - GRAPH_PADDING_X - cardWidth / 2;
    const laneGap = tierCount > 1 ? (laneEnd - laneStart) / (tierCount - 1) : 0;
    const positioned: SimNode[] = [];
    for (const [tier, members] of groups) {
      const rows = members.length;
      const verticalGap = rows > 1 ? (usableHeight - rows * cardHeight) / (rows - 1) : 0;
      members.forEach(({ node }, index) => positioned.push({
        ...node,
        x: laneStart + tier * laneGap,
        y: rows === 1
          ? GRAPH_PADDING_TOP + usableHeight / 2
          : GRAPH_PADDING_TOP + cardHeight / 2 + index * (cardHeight + verticalGap),
        learningTier: tier,
        isSequenced: sequencedIds.has(node.id),
        routeId: 0,
        cardWidth,
        cardHeight,
      }));
    }
    return positioned;
  }

  // Three roomy columns keep Chinese labels legible in both the compact block
  // and the full-screen view. More columns make the content look like a dense
  // spreadsheet rather than a map children can explore.
  const columns = Math.min(3, Math.max(2, Math.ceil(Math.sqrt(ordered.length || 1))));
  const rows = Math.max(1, Math.ceil(ordered.length / columns));
  const cardWidth = Math.min(CARD_WIDTH, Math.max(92, (canvasWidth - GRAPH_PADDING_X * 2) / columns - 12));
  const cardHeight = Math.min(CARD_HEIGHT, Math.max(88, Math.floor((canvasHeight - GRAPH_PADDING_TOP - GRAPH_PADDING_BOTTOM - Math.max(0, rows - 1) * 24) / rows)));
  const usableWidth = canvasWidth - GRAPH_PADDING_X * 2;
  const usableHeight = canvasHeight - GRAPH_PADDING_TOP - GRAPH_PADDING_BOTTOM;

  return ordered.map(({ node }, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      ...node,
      x: GRAPH_PADDING_X + cardWidth / 2 + column * ((usableWidth - cardWidth) / Math.max(1, columns - 1)),
      y: rows === 1
        ? GRAPH_PADDING_TOP + usableHeight / 2
        : GRAPH_PADDING_TOP + cardHeight / 2 + row * ((usableHeight - cardHeight) / (rows - 1)),
      learningTier: 0,
      isSequenced: false,
      routeId: 0,
      cardWidth,
      cardHeight,
    };
  });
}

/** Minimum scrollable canvas that keeps every card fully visible. */
export function getKnowledgeGraphCanvasBounds(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[],
  viewportWidth = WIDTH,
  viewportHeight = HEIGHT,
): GraphCanvasBounds {
  if (!nodes.length) return { width: viewportWidth, height: Math.max(viewportHeight, HEIGHT) };
  const cache = new Map<string, number>();
  const entries = nodes.map((node) => ({ node, tier: learningTier(node.id, edges, cache) }));
  const materialOrders = [...new Set(nodes
    .map((node) => node.material_order)
    .filter((value): value is number => typeof value === "number"))]
    .sort((a, b) => a - b);
  if (materialOrders.length > 1) {
    const countByMaterial = new Map<number, number>();
    for (const node of nodes) {
      const material = node.material_order ?? materialOrders[0];
      countByMaterial.set(material, (countByMaterial.get(material) ?? 0) + 1);
    }
    const largestLane = Math.max(...countByMaterial.values());
    return {
      width: Math.max(viewportWidth, GRAPH_PADDING_X * 2 + materialOrders.length * (CARD_WIDTH + 34) - 34),
      height: Math.max(viewportHeight, 560, GRAPH_PADDING_TOP + GRAPH_PADDING_BOTTOM + largestLane * CARD_HEIGHT + Math.max(0, largestLane - 1) * 22),
    };
  }
  const hasPrerequisites = edges.some((edge) => edge.type === "prerequisite");
  const tierCount = hasPrerequisites ? Math.max(...entries.map((entry) => entry.tier)) + 1 : Math.min(3, Math.max(2, Math.ceil(Math.sqrt(nodes.length))));
  const rowsByLane = new Map<number, number>();
  for (const entry of entries) {
    const lane = hasPrerequisites ? entry.tier : entries.indexOf(entry) % tierCount;
    rowsByLane.set(lane, (rowsByLane.get(lane) ?? 0) + 1);
  }
  const largestLane = Math.max(...rowsByLane.values());
  // A graph with only a handful of concepts should feel like a compact map,
  // not a few cards stranded at the left of a desktop-sized canvas. Keep its
  // logical canvas close to the content and let the view center it. Larger
  // graphs retain a viewport-sized (or scrollable) canvas for readability.
  const isCompactGraph = nodes.length <= 8;
  const contentWidth = GRAPH_PADDING_X * 2 + tierCount * (CARD_WIDTH + 24) - 24;
  const contentHeight = GRAPH_PADDING_TOP + GRAPH_PADDING_BOTTOM + largestLane * CARD_HEIGHT + Math.max(0, largestLane - 1) * 24;
  return {
    width: isCompactGraph ? Math.max(520, contentWidth) : Math.max(viewportWidth, contentWidth),
    height: isCompactGraph ? Math.max(420, contentHeight) : Math.max(viewportHeight, 560, contentHeight),
  };
}

export function buildFocusedGraph(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[],
  focusTerms?: string[],
  maxNodes = 20,
): { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] } {
  const normalizedTerms = (focusTerms ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length >= 2);
  if (normalizedTerms.length === 0) {
    return { nodes, edges };
  }

  const seedIds = new Set(
    nodes
      .filter((node) =>
        normalizedTerms.some((term) => node.label.toLowerCase().includes(term)),
      )
      .map((node) => node.id),
  );

  // If no direct matches, fall back to the full graph.
  if (seedIds.size === 0) {
    return { nodes, edges };
  }

  const included = new Set(seedIds);
  for (const edge of edges) {
    if (seedIds.has(edge.source) || seedIds.has(edge.target)) {
      included.add(edge.source);
      included.add(edge.target);
    }
  }

  let focusedNodes = nodes.filter((node) => included.has(node.id));
  let focusedEdges = edges.filter(
    (edge) => included.has(edge.source) && included.has(edge.target),
  );

  if (focusedNodes.length > maxNodes) {
    const prioritized = [...focusedNodes].sort((a, b) => {
      const aSeed = seedIds.has(a.id) ? 0 : 1;
      const bSeed = seedIds.has(b.id) ? 0 : 1;
      if (aSeed !== bSeed) return aSeed - bSeed;
      return a.mastery - b.mastery;
    });
    focusedNodes = prioritized.slice(0, maxNodes);
    const allowed = new Set(focusedNodes.map((node) => node.id));
    focusedEdges = focusedEdges.filter(
      (edge) => allowed.has(edge.source) && allowed.has(edge.target),
    );
  }

  return { nodes: focusedNodes, edges: focusedEdges };
}
