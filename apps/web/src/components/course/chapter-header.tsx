"use client";

import { t } from "@/lib/i18n";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, BookOpen } from "lucide-react";
import type { ContentNode } from "@/lib/api";
import { getPreferredLearningNode } from "@/lib/content-tree";

interface ChapterHeaderProps {
  courseId: string;
  courseName: string;
  chapterTitle: string;
  chapters?: ContentNode[];
  currentChapterId?: string;
}

export function ChapterHeader({ courseId, courseName, chapterTitle, chapters = [], currentChapterId }: ChapterHeaderProps) {
  const router = useRouter();
  const selectedChapter = chapters.find((chapter) => chapter.id === currentChapterId);
  const selectedTargetId = selectedChapter ? getPreferredLearningNode(selectedChapter).id : currentChapterId;
  return (
    <header role="banner" aria-label={t("ui.chapter_navigation")} className="sticky top-0 z-30 border-b border-emerald-100/70 bg-[#fffdf8]/92 shadow-[0_8px_24px_-22px_rgba(20,70,50,0.6)] backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
        <Link
          href={`/course/${courseId}`}
          className="flex shrink-0 items-center gap-1.5 rounded-xl px-2 py-1.5 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-50"
          aria-label={`返回 ${courseName}`}
        >
          <ArrowLeft className="size-4" />
          <span className="hidden sm:inline">{courseName}</span>
        </Link>
        <span className="text-muted-foreground/40" aria-hidden="true">/</span>
        <h1 className="truncate text-sm font-semibold text-foreground">{chapterTitle}</h1>
        {chapters.length > 0 ? (
          <label className="ml-auto flex shrink-0 items-center gap-2 rounded-xl border border-emerald-100 bg-white/85 px-2.5 py-1.5 shadow-sm">
            <BookOpen className="size-4 text-emerald-700" aria-hidden="true" />
            <span className="sr-only">{t("unit.switchChapter")}</span>
            <select
              value={selectedTargetId}
              onChange={(event) => router.push(`/course/${courseId}/unit/${event.target.value}`)}
              className="max-w-48 bg-transparent text-xs font-medium text-foreground outline-none sm:max-w-64"
              aria-label={t("unit.switchChapter")}
            >
              {chapters.map((chapter) => <option key={chapter.id} value={getPreferredLearningNode(chapter).id}>{chapter.title}</option>)}
            </select>
          </label>
        ) : null}
      </div>
    </header>
  );
}
