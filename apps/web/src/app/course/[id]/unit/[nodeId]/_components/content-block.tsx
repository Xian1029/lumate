"use client";

import { useEffect, useState } from "react";
import type { ContentNode, UploadedCourseFile } from "@/lib/api";
import { getAiNoteForNode, listCourseFiles, type AiNoteForNode } from "@/lib/api";
import { API_BASE } from "@/lib/api/client";
import { MarkdownRenderer } from "@/components/shared/markdown-renderer";
import { useT } from "@/lib/i18n-context";
import { BookOpen, ExternalLink } from "lucide-react";

function normalizedFileName(value?: string | null) {
  return value?.split(/[\\/]/).pop()?.trim().toLocaleLowerCase() ?? "";
}

function findSourceFile(files: UploadedCourseFile[], node: ContentNode) {
  const sourceName = normalizedFileName(node.source_file);
  const exactMatch = files.find((file) => {
    if (node.file_id && (file.id === node.file_id || file.job_id === node.file_id)) return true;
    if (!sourceName) return false;
    return [file.filename, file.file_name].some((name) => normalizedFileName(name) === sourceName);
  });

  // A parsed chapter does not always retain its PDF marker or filename. When the
  // course has one uploaded source, it is unambiguously the chapter's textbook.
  return exactMatch ?? (files.length === 1 ? files[0] : null);
}

export function ContentBlock({ node, courseId }: { node: ContentNode; courseId: string }) {
  const t = useT();
  const [aiNoteState, setAiNoteState] = useState<{ nodeId: string; note: AiNoteForNode | null } | null>(null);
  const sourceKey = `${courseId}:${node.file_id ?? ""}:${node.source_file ?? ""}`;
  const [sourceState, setSourceState] = useState<{ key: string; url: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAiNoteForNode(courseId, node.id)
      .then((note) => { if (!cancelled) setAiNoteState({ nodeId: node.id, note }); })
      .catch(() => { if (!cancelled) setAiNoteState({ nodeId: node.id, note: null }); });
    return () => { cancelled = true; };
  }, [courseId, node.id]);

  useEffect(() => {
    let cancelled = false;
    listCourseFiles(courseId).then((files) => {
      const matched = findSourceFile(files, node);
      if (!cancelled) {
        setSourceState({
          key: sourceKey,
          url: matched ? `${API_BASE}/content/files/${matched.job_id}` : null,
        });
      }
    }).catch(() => { if (!cancelled) setSourceState({ key: sourceKey, url: null }); });
    return () => { cancelled = true; };
  }, [courseId, node, sourceKey]);

  const aiNote = aiNoteState?.nodeId === node.id ? aiNoteState.note : null;
  const sourceUrl = sourceState?.key === sourceKey ? sourceState.url : null;

  const headingLevel = Math.min((node.level ?? 0) + 1, 6);
  const sizeClass =
    headingLevel === 1 ? "text-2xl" :
    headingLevel === 2 ? "text-xl" :
    headingLevel === 3 ? "text-lg" : "text-base";

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className={`font-bold text-foreground ${sizeClass}`}>{node.title}</h3>
        {sourceUrl ? (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs font-semibold text-emerald-800 shadow-sm transition hover:border-emerald-300 hover:bg-emerald-50"
          >
            <ExternalLink className="size-3.5" />
            {t("unit.viewSourceDocument")}
          </a>
        ) : null}
      </div>
      {node.content_category === "reference" ? (
        <div className="relative overflow-hidden rounded-2xl border border-amber-200/80 bg-gradient-to-br from-amber-50 via-orange-50/70 to-emerald-50/70 px-5 py-5 shadow-sm dark:border-amber-900 dark:from-amber-950/30 dark:via-background dark:to-emerald-950/20 sm:px-6">
          <div className="pointer-events-none absolute -right-8 -top-10 size-28 rounded-full bg-amber-200/30 blur-2xl" />
          <div className="relative flex items-start gap-4">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-white text-amber-700 shadow-sm ring-1 ring-amber-200 dark:bg-background dark:text-amber-300 dark:ring-amber-900">
              <BookOpen className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-amber-950 dark:text-amber-100">
                {t("unit.referenceWelcomeTitle")}
              </p>
              <p className="mt-1.5 max-w-3xl text-sm leading-6 text-amber-950/70 dark:text-amber-100/70">
                {t("unit.referenceWelcomeDescription")}
              </p>
              <p className="mt-3 inline-flex rounded-full bg-white/80 px-3 py-1 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200/80 dark:bg-background/70 dark:text-emerald-200 dark:ring-emerald-900">
                {t("unit.referenceLearningHint")}
              </p>
            </div>
          </div>
        </div>
      ) : aiNote?.markdown ? (
        <MarkdownRenderer
          content={aiNote.markdown}
          className="prose prose-base max-w-none leading-7 dark:prose-invert prose-headings:scroll-mt-24 prose-headings:text-foreground prose-p:text-foreground/85"
        />
      ) : node.content ? (
        <MarkdownRenderer
          content={node.content}
          className="prose prose-base max-w-none leading-7 dark:prose-invert prose-headings:scroll-mt-24 prose-headings:text-foreground prose-p:text-foreground/85"
        />
      ) : node.children?.length ? (
        <p className="text-sm leading-6 text-muted-foreground rounded-xl bg-muted/40 px-4 py-3">
          {t("unit.chooseSubsection")}
        </p>
      ) : null}
    </div>
  );
}
