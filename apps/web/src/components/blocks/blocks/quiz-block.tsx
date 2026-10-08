"use client";

import { t } from "@/lib/i18n";
import { PracticeSection } from "@/components/sections/practice-section";
import type { BlockComponentProps } from "@/lib/block-system/registry";
import { useCourseStore } from "@/store/course";
import { useWorkspaceStore } from "@/store/workspace";
import { findNodeById, isPracticeEligibleContentNode } from "@/lib/content-tree";

export default function QuizBlock({ courseId, aiActionsEnabled }: BlockComponentProps) {
  const contentTree = useCourseStore((state) => state.contentTree);
  const selectedNodeId = useWorkspaceStore((state) => state.selectedNodeId);
  const selectedNode = findNodeById(contentTree, selectedNodeId);

  // BlockGrid normally omits this block before mounting it. Keep the same
  // guard here for focused/deep-link renders so a book cover or contents page
  // can never create a context-free quiz surface.
  if (!selectedNode || !isPracticeEligibleContentNode(selectedNode)) return null;

  return (
    <div role="region" aria-label={t("ui.quiz")} className="h-full min-h-0 overflow-hidden flex flex-col">
      <PracticeSection
        courseId={courseId}
        aiActionsEnabled={aiActionsEnabled}
        defaultTab="quiz"
        scope="quiz"
      />
    </div>
  );
}
