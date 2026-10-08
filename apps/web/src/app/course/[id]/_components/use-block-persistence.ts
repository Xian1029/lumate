"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { syncCourseSpaceLayout } from "@/lib/block-system/layout-sync";
import { useWorkspaceStore } from "@/store/workspace";
import type { LearningMode } from "@/lib/block-system/types";
import { buildLayoutFromMode } from "@/lib/block-system/templates";
import {
  loadStoredSpaceLayout,
  normalizeSpaceLayout,
  parseSpaceLayout,
} from "@/lib/block-system/layout-storage";

export function useBlockPersistence(
  courseId: string,
  course: { metadata?: unknown } | null,
) {
  const blocks = useWorkspaceStore((s) => s.spaceLayout.blocks);
  const loadBlocks = useWorkspaceStore((s) => s.loadBlocks);
  const blocksInitialized = useRef(false);
  const [initializedCourseId, setInitializedCourseId] = useState<string | null>(null);
  const lastCourseIdRef = useRef<string | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastConfirmedLayout = useRef<ReturnType<typeof normalizeSpaceLayout> | null>(null);

  const flushLayout = useCallback(() => {
    if (!blocksInitialized.current) return;
    const layout = useWorkspaceStore.getState().spaceLayout;
    syncCourseSpaceLayout(courseId, layout)
      .then((confirmed) => { lastConfirmedLayout.current = confirmed; })
      .catch((e) => {
        console.error("[Course] layout persist failed:", e);
        if (lastConfirmedLayout.current) loadBlocks(lastConfirmedLayout.current);
      });
  }, [courseId, loadBlocks]);

  useEffect(() => {
    if (lastCourseIdRef.current !== courseId) {
      lastCourseIdRef.current = courseId;
      blocksInitialized.current = false;
    }
    if (blocksInitialized.current) return;

    // Server metadata is authoritative. Local storage is recovery-only and
    // must never override a newer layout saved from another tab/device.
    if (!course) return;
    blocksInitialized.current = true;
    // This state gates the first server layout render for the current course.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInitializedCourseId(courseId);

    const savedLayout = parseSpaceLayout(
      (course.metadata as Record<string, unknown> | undefined)?.spaceLayout,
    );
    if (savedLayout) {
      loadBlocks(normalizeSpaceLayout(savedLayout));
      lastConfirmedLayout.current = normalizeSpaceLayout(savedLayout);
      return;
    }

    const cached = loadStoredSpaceLayout(courseId);
    if (cached) {
      loadBlocks(cached);
      lastConfirmedLayout.current = cached;
      return;
    }

    const savedMode = (course.metadata as Record<string, unknown> | undefined)
      ?.learning_mode as LearningMode | undefined;
    if (savedMode) {
      loadBlocks(buildLayoutFromMode(savedMode));
      return;
    }

    // A newly-created course can be opened before ingestion has written a
    // server layout. Never inherit the previous course's Zustand state: start
    // from the product's canonical learning-space layout instead.
    const fallback = buildLayoutFromMode("course_following");
    loadBlocks(fallback);
    lastConfirmedLayout.current = fallback;
  }, [courseId, course, loadBlocks]);

  useEffect(() => {
    if (!blocksInitialized.current) return;
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      flushLayout();
    }, 2000);
    return () => clearTimeout(persistTimer.current);
  }, [blocks, flushLayout]);

  useEffect(() => {
    const flushNow = () => {
      clearTimeout(persistTimer.current);
      flushLayout();
    };

    window.addEventListener("pagehide", flushNow);
    window.addEventListener("beforeunload", flushNow);
    return () => {
      window.removeEventListener("pagehide", flushNow);
      window.removeEventListener("beforeunload", flushNow);
      flushNow();
    };
  }, [courseId, flushLayout]);

  return {
    blocks,
    blocksInitialized: initializedCourseId === courseId,
  };
}
