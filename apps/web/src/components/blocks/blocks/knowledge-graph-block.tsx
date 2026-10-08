"use client";

import { lazy, Suspense } from "react";
import type { BlockComponentProps } from "@/lib/block-system/registry";
import { BlockSkeleton } from "@/components/shared/block-skeleton";
import { useCourseStore } from "@/store/course";
import { useWorkspaceStore } from "@/store/workspace";
import { buildFocusTerms, findNodeById, getContentNodeMaterialKey } from "@/lib/content-tree";

const GraphView = lazy(() =>
  import("@/components/sections/analytics/graph-view").then((m) => ({ default: m.GraphView })),
);

export default function KnowledgeGraphBlock({ courseId }: BlockComponentProps) {
  const contentTree = useCourseStore((state) => state.contentTree);
  const selectedNodeId = useWorkspaceStore((state) => state.selectedNodeId);
  const selectedContentNode = findNodeById(contentTree, selectedNodeId);
  const focusTerms = selectedContentNode ? buildFocusTerms(selectedContentNode) : undefined;
  const activeMaterialId = getContentNodeMaterialKey(contentTree, selectedNodeId);

  return (
    <Suspense fallback={<BlockSkeleton />}>
      <GraphView courseId={courseId} focusTerms={focusTerms} activeMaterialId={activeMaterialId} />
    </Suspense>
  );
}
