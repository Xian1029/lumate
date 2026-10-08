"use client";

import { useCourseStore } from "@/store/course";
import { ChapterList } from "@/components/course/chapter-list";
import type { BlockComponentProps } from "@/lib/block-system/registry";

export default function ChapterListBlock({ courseId }: BlockComponentProps) {
  const contentTree = useCourseStore((s) => s.contentTree);
  return (
    <div className="min-h-0 overflow-y-auto overscroll-contain scrollbar-thin p-4 pr-3">
      <ChapterList courseId={courseId} nodes={contentTree} />
    </div>
  );
}
