"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n-context";
import {
  getKnowledgeGraph,
  getCourseLearningPlanDashboard,
  type KnowledgeGraphEdge,
  type KnowledgeGraphNode,
  type WorkspaceLearningProgress,
} from "@/lib/api";
import { trackApiFailure } from "@/lib/error-telemetry";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/store/workspace";
import { useCourseStore } from "@/store/course";
import { LearningPathView } from "./learning-path-view";
import {
  WIDTH,
  HEIGHT,
  getKnowledgeGraphCanvasBounds,
  layoutKnowledgeGraph,
  type SimNode,
} from "./graph-simulation";

interface GraphViewProps {
  courseId: string;
  focusTerms?: string[];
  /** Current uploaded textbook context. It highlights but never filters. */
  activeMaterialId?: string | null;
}

export function splitGraphLabel(label: string, maxChars = 9, maxLines = 2): string[] {
  const trimmed = label.trim();
  if (trimmed.length <= maxChars) return [trimmed];

  if (/\s/.test(trimmed)) {
    const lines: string[] = [];
    let current = "";
    for (const word of trimmed.split(/\s+/)) {
      const next = current ? `${current} ${word}` : word;
      if (next.length > maxChars && current) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) lines.push(current);
    if (lines.length <= maxLines) return lines;
    return [...lines.slice(0, Math.max(0, maxLines - 1)), `${lines[maxLines - 1].slice(0, Math.max(1, maxChars - 1))}…`];
  }

  const lines = Array.from({ length: Math.ceil(trimmed.length / maxChars) }, (_, index) =>
    trimmed.slice(index * maxChars, (index + 1) * maxChars),
  );
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, Math.max(0, maxLines - 1)), `${lines[maxLines - 1].slice(0, Math.max(1, maxChars - 1))}…`];
}

function edgeVisual(type: string, highlighted: boolean) {
  if (type === "prerequisite") {
    return { stroke: "#527463", width: highlighted ? 2.8 : 2.25, dash: undefined, opacity: highlighted ? 1 : 0.9, arrow: true };
  }
  if (type === "contains") {
    return { stroke: "#9fb1a5", width: highlighted ? 2 : 1.25, dash: undefined, opacity: highlighted ? 0.9 : 0.52, arrow: false };
  }
  return { stroke: "#8198ae", width: highlighted ? 2 : 1.3, dash: "5 4", opacity: highlighted ? 0.9 : 0.55, arrow: false };
}

export function GraphView({ courseId, focusTerms, activeMaterialId }: GraphViewProps) {
  const t = useT();
  const graphHostRef = useRef<HTMLDivElement>(null);
  const [rawNodes, setRawNodes] = useState<KnowledgeGraphNode[]>([]);
  const [edges, setEdges] = useState<KnowledgeGraphEdge[]>([]);
  const [workspaceProgress, setWorkspaceProgress] = useState<WorkspaceLearningProgress | null>(null);
  // `undefined` means use a note-context highlight once; `null` is an
  // explicit learner dismissal after clicking empty canvas.
  const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [viewport, setViewport] = useState({ width: WIDTH, height: HEIGHT });
  const loadedCourseRef = useRef<string | null>(null);
  // The complete graph is the landing view; the guided path remains one clear
  // switch away for learners who want a next-step recommendation.
  const [view, setView] = useState<"path" | "graph">("graph");
  const analyticsRefreshKey = useWorkspaceStore((state) => state.sectionRefreshKey.analytics);
  const contentTree = useCourseStore((state) => state.contentTree);
  const activeCourse = useCourseStore((state) => state.activeCourse);
  const canvasBounds = useMemo(
    () => getKnowledgeGraphCanvasBounds(rawNodes, edges, viewport.width, viewport.height),
    [rawNodes, edges, viewport.width, viewport.height],
  );

  useEffect(() => {
    let cancelled = false;
    // A practice submission refreshes analytics so progress stays current.
    // Do not replace an already visible graph with a loading panel during
    // that background refresh: doing so makes the whole learning page jump.
    const isInitialLoad = loadedCourseRef.current !== courseId;
    startTransition(() => {
      if (isInitialLoad) {
        setLoading(true);
        setError(null);
      }
    });
    Promise.all([getKnowledgeGraph(courseId), getCourseLearningPlanDashboard(courseId)])
      .then(([data, dashboard]) => {
        if (cancelled) return;
        // The graph always represents the complete uploaded course. The note
        // selection only highlights matching concepts; it must never filter
        // unrelated nodes out of the graph.
        const graphNodes = data.nodes ?? [];
        const graphEdges = data.edges ?? [];

        if (!graphNodes.length) {
          setEmpty(true);
          setError(null);
          setLoading(false);
          return;
        }
        setRawNodes(graphNodes);
        setEdges(graphEdges);
        setWorkspaceProgress(dashboard.workspace_progress);
        setEmpty(false);
        setError(null);
        setLoading(false);
        loadedCourseRef.current = courseId;
      })
      .catch((err) => {
        if (!cancelled) {
          trackApiFailure("graph", err, {
            endpoint: `/progress/courses/${courseId}/knowledge-graph`,
            courseId,
          });
          // Preserve a previously rendered graph if only its background
          // refresh fails; the learner can keep answering without a page
          // flicker, and the next refresh can recover normally.
          if (isInitialLoad) {
            setEmpty(false);
            setError(err instanceof Error ? err.message : t("graph.loadFailed"));
            setLoading(false);
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, focusTerms, reloadTick, analyticsRefreshKey, t]);

  useEffect(() => {
    const host = graphHostRef.current;
    if (!host) return;
    const updateViewport = () => {
      const { width, height } = host.getBoundingClientRect();
      if (width > 0 && height > 0) setViewport({ width: Math.round(width), height: Math.round(height) });
    };
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(host);
    return () => observer.disconnect();
  }, [loading, error, empty, view]);

  const nodes = useMemo(
    () => layoutKnowledgeGraph(rawNodes, edges, canvasBounds.width, canvasBounds.height),
    [rawNodes, edges, canvasBounds],
  );
  const contextualNodeId = useMemo(() => {
    if (!nodes.length) return null;
    const normalizedTerms = (focusTerms ?? []).map((term) => term.trim().toLowerCase()).filter(Boolean);
    const contextualNode = nodes.find((node) => {
      const label = node.label.trim().toLowerCase();
      return normalizedTerms.some((term) => label.includes(term) || term.includes(label));
    });
    return contextualNode?.id ?? null;
  }, [nodes, focusTerms]);
  const selected = selectedId === undefined
    ? nodes.find((node) => node.id === contextualNodeId) ?? null
    : nodes.find((node) => node.id === selectedId) ?? null;

  // Keep the relationship card in the same coordinate system as the graph
  // canvas. A fixed bottom-left panel made a click on a lower node look like
  // it had no effect until the learner scrolled back to the top. The card now
  // follows the selected node and flips above it when the node is near the
  // bottom edge, so the explanation is always adjacent to what was clicked.
  const selectedDetailLayout = useMemo(() => {
    if (!selected) return null;
    const width = Math.min(340, Math.max(240, canvasBounds.width - 24));
    const halfWidth = width / 2;
    const left = Math.min(
      Math.max(selected.x, halfWidth + 12),
      canvasBounds.width - halfWidth - 12,
    );
    const estimatedHeight = 154;
    const placeAbove = selected.y + estimatedHeight > canvasBounds.height - 12;
    const top = placeAbove
      ? selected.y - selected.cardHeight / 2 - 12
      : selected.y + selected.cardHeight / 2 + 12;
    return { width, left, top, placeAbove };
  }, [canvasBounds.width, canvasBounds.height, selected]);

  const handleNodeClick = useCallback(
    (node: SimNode) => {
      setSelectedId((currentId) => currentId === node.id ? null : node.id);
    },
    [],
  );

  if (loading) {
    return (
      <div
        className="flex-1 flex items-center justify-center p-8"
        data-testid="graph-panel"
      >
        <p className="text-xs text-muted-foreground">{t("graph.loading")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-3"
        data-testid="graph-panel"
      >
        <h3 className="text-sm font-medium">{t("graph.loadFailed")}</h3>
        <p className="text-xs text-muted-foreground max-w-xs">{error}</p>
        <Button variant="outline" size="sm" onClick={() => setReloadTick((value) => value + 1)}>
          {t("graph.retry")}
        </Button>
      </div>
    );
  }

  if (empty) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center p-8 text-center"
        data-testid="graph-panel"
      >
        <h3 className="text-sm font-medium mb-1">{t("course.graph")}</h3>
        <p className="text-xs text-muted-foreground max-w-xs">
          {t("graph.emptyHint")}
        </p>
      </div>
    );
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const selectedRelationships = selected ? (() => {
    const priority = { prerequisite: 0, curriculum_sequence: 1, contains: 2, related: 3 } as Record<string, number>;
    const items = edges
      .filter((edge) => edge.source === selected.id || edge.target === selected.id)
      .map((edge) => {
        const other = nodeById.get(edge.source === selected.id ? edge.target : edge.source);
        if (!other) return null;
        const currentIsSource = edge.source === selected.id;
        let label = "学习关联";
        let detail = other.label;
        if (edge.type === "prerequisite") {
          label = currentIsSource ? "学习前提" : "学完后可继续";
          detail = currentIsSource ? `先掌握「${other.label}」` : `可学习「${other.label}」`;
        } else if (edge.type === "curriculum_sequence") {
          label = currentIsSource ? "教材下一步" : "教材上一步";
          detail = currentIsSource ? `接着学习「${other.label}」` : `在「${other.label}」之后学习`;
        } else if (edge.type === "contains") {
          label = currentIsSource ? "包含内容" : "所属教材单元";
          detail = other.label;
        } else if (edge.type === "related") {
          label = "相关概念";
        }
        return { key: `${label}:${other.id}`, label, detail, priority: priority[edge.type] ?? 4 };
      })
      .filter((item): item is { key: string; label: string; detail: string; priority: number } => item !== null)
      .sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label, "zh-Hans-CN"));
    return items.filter((item, index) => items.findIndex((candidate) => candidate.key === item.key) === index).slice(0, 6);
  })() : [];
  // The full graph may contain several branches. Keep a minimum logical
  // canvas height and allow the host to scroll instead of squeezing branch
  // cards into each other in a short panel.
  const cardEdgePoint = (from: SimNode, to: SimNode) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const scale = Math.min(
      from.cardWidth / 2 / Math.max(1, Math.abs(dx)),
      from.cardHeight / 2 / Math.max(1, Math.abs(dy)),
    );
    return { x: from.x + dx * scale, y: from.y + dy * scale };
  };

  if (view === "path") {
    return <LearningPathView courseId={courseId} courseName={activeCourse?.name} graphNodes={rawNodes} graphEdges={edges} contentTree={contentTree} workspaceProgress={workspaceProgress} activeMaterialId={activeMaterialId} onShowFullGraph={() => setView("graph")} />;
  }

  return (
    <div role="region" aria-label={t("ui.knowledge_graph")} className="flex h-full min-h-0 flex-col overflow-hidden bg-[#f7f8f6]" data-testid="graph-panel">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-4 py-3">
        <div><p className="text-xs font-semibold text-brand">知识图谱</p><p className="text-sm font-medium">完整知识点关系</p></div>
        <div className="inline-flex rounded-xl bg-muted p-1" role="tablist" aria-label="知识图谱视图">
          <button type="button" role="tab" aria-selected={false} onClick={() => setView("path")} className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:text-foreground">推荐学习路径</button>
          <button type="button" role="tab" aria-selected className="rounded-lg bg-card px-3 py-2 text-sm font-semibold shadow-sm">完整知识图谱</button>
        </div>
      </div>
      <div ref={graphHostRef} className="relative flex-1 min-h-0 overflow-auto">
      <div
        className="relative flex min-h-full min-w-full justify-center"
        style={{ width: Math.max(viewport.width, canvasBounds.width), height: Math.max(viewport.height, canvasBounds.height) }}
      >
      <div
        className="relative shrink-0"
        style={{ width: canvasBounds.width, height: canvasBounds.height }}
      >
      <svg
        viewBox={`0 0 ${canvasBounds.width} ${canvasBounds.height}`}
        className="block bg-background"
        style={{ width: canvasBounds.width, height: canvasBounds.height, flex: "none" }}
        role="img"
        aria-label={t("ui.knowledge_graph_visualization")}
        onClick={() => setSelectedId(null)}
      >
        <defs>
          <marker id="knowledge-graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="#647b6c" />
          </marker>
        </defs>
        <rect width={canvasBounds.width} height={canvasBounds.height} fill="#fcfbf9" />
        <text x={54} y={29} fontSize={15} fontWeight={700} fill="var(--foreground, #1f2937)">
          完整知识图谱
        </text>
        <text x={54} y={47} fontSize={11} fill="var(--muted-foreground, #64748b)">
          展示全部知识点及真实依赖关系；{activeMaterialId ? "带「当前教材」标记的节点来自正在浏览的教材" : "需要行动建议时可切换到推荐学习路径"}
        </text>
        <g aria-label="关系图例">
          <line x1={54} y1={69} x2={76} y2={69} stroke="#527463" strokeWidth={2.25} markerEnd="url(#knowledge-graph-arrow)" />
          <text x={82} y={73} fontSize={10} fill="#52665a">前置关系</text>
          <line x1={144} y1={69} x2={166} y2={69} stroke="#9fb1a5" strokeWidth={1.25} />
          <text x={172} y={73} fontSize={10} fill="#62716a">教材层级</text>
          <line x1={234} y1={69} x2={256} y2={69} stroke="#8198ae" strokeWidth={1.3} strokeDasharray="5 4" />
          <text x={262} y={73} fontSize={10} fill="#5f7180">相关 / 教材顺序</text>
        </g>
        {edges.map((edge) => {
          const source = nodeById.get(edge.source);
          const target = nodeById.get(edge.target);
          if (!source || !target) return null;
          const isPrerequisite = edge.type === "prerequisite";
          // Stored prerequisite edges read “later concept -> prerequisite”.
          // Learners should see the learning journey in the natural direction:
          // “prerequisite -> later concept”.
          const visualSource = isPrerequisite ? target : source;
          const visualTarget = isPrerequisite ? source : target;
          const start = cardEdgePoint(visualSource, visualTarget);
          const end = cardEdgePoint(visualTarget, visualSource);
          const highlighted = selected?.id === edge.source || selected?.id === edge.target;
          const visual = edgeVisual(edge.type, Boolean(highlighted));
          return (
            <line
              key={`${edge.source}-${edge.target}`}
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              stroke={visual.stroke}
              strokeWidth={visual.width}
              strokeDasharray={visual.dash}
              strokeOpacity={visual.opacity}
              markerEnd={visual.arrow ? "url(#knowledge-graph-arrow)" : undefined}
            />
          );
        })}
        {nodes.map((node) => {
          const normalizedLabel = node.label.trim().toLowerCase();
          const matchesCurrentNote = (focusTerms ?? []).some((term) => {
            const normalizedTerm = term.trim().toLowerCase();
            return normalizedTerm.length >= 2
              && (normalizedLabel.includes(normalizedTerm) || normalizedTerm.includes(normalizedLabel));
          });
          const isSelected = selected?.id === node.id || matchesCurrentNote;
          const isCurrentMaterial = Boolean(activeMaterialId && node.material_id === activeMaterialId);
          const isMastered = node.mastery >= 0.85;
          const isLearning = node.mastery > 0 && !isMastered;
          const background = isMastered ? "#f4f8f5" : isLearning ? "#fbfaf5" : "#ffffff";
          const accent = isMastered ? "#66806d" : isLearning ? "#8d9278" : "#8b9aa3";
          const progressLabel = isMastered ? "已点亮" : isLearning ? "成长中" : "待探索";
          const progressIcon = isMastered ? "✦" : isLearning ? "✧" : "○";
          const cardLeft = node.x - node.cardWidth / 2;
          const cardTop = node.y - node.cardHeight / 2;
          const labelMaxChars = Math.max(7, Math.floor((node.cardWidth - 54) / 12));
          const labelLines = splitGraphLabel(node.label, labelMaxChars);
          return (
          <g
            key={node.id}
            onClick={(event) => { event.stopPropagation(); handleNodeClick(node); }}
            className="cursor-pointer"
            aria-current={matchesCurrentNote ? "true" : undefined}
            data-current-material={isCurrentMaterial ? "true" : undefined}
          >
            <title>{`${node.label}，掌握度 ${Math.round(node.mastery * 100)}%`}</title>
            <rect
              x={cardLeft}
              y={cardTop}
              width={node.cardWidth}
              height={node.cardHeight}
              rx={18}
              fill={background}
              stroke={isCurrentMaterial ? "#bc8a2c" : isSelected ? "var(--brand, #7c9082)" : isMastered ? "#aac2b0" : "#cfd8d1"}
              strokeWidth={isCurrentMaterial || isSelected ? 2.5 : 1.5}
            />
            {isCurrentMaterial ? <rect x={cardLeft + 1} y={cardTop + 16} width={4} height={node.cardHeight - 32} rx={2} fill="#c98519" /> : null}
            <circle
              cx={cardLeft + 22}
              cy={cardTop + 22}
              r={11}
              fill={isMastered ? "#dce8df" : isLearning ? "#ebeade" : "#e9eded"}
            />
            <text x={cardLeft + 22} y={cardTop + 26} textAnchor="middle" fontSize={12}>{progressIcon}</text>
            <text
              x={cardLeft + 40}
              y={cardTop + 27}
              textAnchor="start"
              fontSize={12}
              fontWeight={600}
              fill="var(--foreground, #333)"
            >
              {labelLines.map((line, index) => (
                <tspan key={`${node.id}-label-${index}`} x={cardLeft + 40} dy={index === 0 ? 0 : 15}>
                  {line}
                </tspan>
              ))}
            </text>
            <rect x={cardLeft + 16} y={cardTop + node.cardHeight - 16} width={node.cardWidth - 32} height={6} rx={3} fill="#dfe6e1" />
            <rect x={cardLeft + 16} y={cardTop + node.cardHeight - 16} width={(node.cardWidth - 32) * node.mastery} height={6} rx={3} fill={accent} />
            <text x={cardLeft + 16} y={cardTop + node.cardHeight - 23} fontSize={10} fontWeight={600} fill={accent}>
              {progressLabel} · {Math.round(node.mastery * 100)}%
            </text>
          </g>
          );
        })}
      </svg>
      {selected && selectedDetailLayout ? (
        <aside
          className="pointer-events-auto absolute z-10 rounded-xl border border-border bg-card/95 p-3 text-xs shadow-lg backdrop-blur"
          style={{
            width: selectedDetailLayout.width,
            left: selectedDetailLayout.left,
            top: selectedDetailLayout.top,
            transform: selectedDetailLayout.placeAbove ? "translate(-50%, -100%)" : "translateX(-50%)",
          }}
          aria-live="polite"
          data-testid="graph-node-details"
        >
          <p className="font-semibold text-foreground">{selected.label}</p>
          {selectedRelationships.length ? (
            <ul className="mt-1.5 space-y-1 text-muted-foreground">
              {selectedRelationships.map((relationship) => {
                return <li key={relationship.key}><span className="font-medium text-foreground">{relationship.label}：</span>{relationship.detail}</li>;
              })}
            </ul>
          ) : <p className="mt-1 text-muted-foreground">该知识点暂未建立明确的知识依赖；当前仅保留教材范围与学习进度。</p>}
        </aside>
      ) : null}
      </div>
      </div>
    </div>
    </div>
  );
}
