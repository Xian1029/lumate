"use client";

import { t } from "@/lib/i18n";
import { PracticeSection } from "@/components/sections/practice-section";
import type { BlockComponentProps } from "@/lib/block-system/registry";
import { useCourseStore } from "@/store/course";
import { useWorkspaceStore } from "@/store/workspace";
import { findNodeById, isPracticeEligibleContentNode } from "@/lib/content-tree";

export default function FlashcardsBlock({ courseId, aiActionsEnabled }: BlockComponentProps) {
  const contentTree = useCourseStore((state) => state.contentTree);
  const contentTreeCourseId = useCourseStore((state) => state.contentTreeCourseId);
  const selectedNodeId = useWorkspaceStore((state) => state.selectedNodeId);
  const selectedNode = contentTreeCourseId === courseId ? findNodeById(contentTree, selectedNodeId) : null;

  // Match the quiz eligibility contract: flashcards are tied to one precise
  // lesson, never a book root, chapter container, preface, or stale node from
  // another learning space. This guard also protects focused/deep-link mounts
  // that bypass BlockGrid.
  if (!selectedNode || !isPracticeEligibleContentNode(selectedNode)) return null;

  return (
    <div role="region" aria-label={t("ui.flashcards")} className="h-full min-h-0 overflow-hidden flex flex-col">
      <PracticeSection
        courseId={courseId}
        aiActionsEnabled={aiActionsEnabled}
        defaultTab="flashcards"
        scope="flashcards"
      />
    </div>
  );
}
