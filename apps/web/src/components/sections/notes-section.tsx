"use client";

import { t } from "@/lib/i18n";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, BookOpen, Sparkles, X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCourseStore } from "@/store/course";
import { useWorkspaceStore } from "@/store/workspace";
import { useT } from "@/lib/i18n-context";
import {
  listGeneratedNoteBatches,
  restructureNotes,
  saveGeneratedNotes,
  getAiNoteForNode,
  listCourseFiles,
  type AiNoteForNode,
  type UploadedCourseFile,
} from "@/lib/api";
import { API_BASE } from "@/lib/api/client";
import { stabilizeMarkdownMermaidBlocks } from "@/lib/markdown/mermaid";
import { useBatchManager } from "@/hooks/use-batch-manager";
import { AiFeatureBlocked } from "@/components/shared/ai-feature-blocked";
import { collectContentNodes, findFirstContentNode, findNodeById, isLearnableContentNode } from "@/lib/content-tree";
import { ContentNodeItem } from "./notes/content-node-item";
import { CornellNoteView } from "./notes/cornell-note-view";
import { toast } from "sonner";

interface NotesSectionProps {
  courseId: string;
  blockId?: string;
  aiActionsEnabled?: boolean;
  immersive?: boolean;
}

interface GeneratedNoteDraft {
  title: string;
  markdown: string;
  format: string;
  sourceNodeId: string;
}

function cleanNoteText(value: unknown): string {
  if (typeof value !== "string") return "";

  // Some providers or copied source material arrive as UTF-8 bytes decoded as
  // Latin-1 (for example "ä¸­æ–‡"). Repair only that recognizable pattern so
  // ordinary non-English study content is never rewritten blindly.
  const withoutControls = value
    .replaceAll("\u0000", "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replaceAll("\uFFFD", "");
  const looksMojibaked = /(?:Ã.|Â.|â..|[\u00C2-\u00F4][\u0080-\u00BF])/.test(withoutControls);
  if (!looksMojibaked) return withoutControls.normalize("NFC").trim();

  try {
    // macOS/Windows text copied through a legacy path can turn bytes 80-9F
    // into their Windows-1252 punctuation equivalents.
    const cp1252Bytes: Record<number, number> = {
      0x2013: 0x96,
      0x2014: 0x97,
      0x2018: 0x91,
      0x2019: 0x92,
      0x201A: 0x82,
      0x201C: 0x93,
      0x201D: 0x94,
      0x2020: 0x86,
      0x2021: 0x87,
      0x2026: 0x85,
    };
    const rawBytes = Array.from(withoutControls, (char) => {
      const codePoint = char.codePointAt(0) ?? 0;
      return codePoint <= 0xff ? codePoint : cp1252Bytes[codePoint];
    });
    if (rawBytes.some((byte) => byte === undefined)) {
      return withoutControls.normalize("NFC").trim();
    }
    const bytes = Uint8Array.from(rawBytes as number[]);
    const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return repaired.normalize("NFC").trim();
  } catch {
    return withoutControls.normalize("NFC").trim();
  }
}

export const cleanNoteTextForTest = cleanNoteText;

function cleanNoteMarkdown(value: unknown): string {
  const markdown = cleanNoteText(value);
  return markdown ? stabilizeMarkdownMermaidBlocks(markdown) : "";
}

function normalizeGeneratedNoteDraft(
  payload: unknown,
  sourceNodeId: string,
  fallbackTitle: string,
): GeneratedNoteDraft | null {
  if (!payload || typeof payload !== "object") return null;

  const record = payload as Record<string, unknown>;
  const markdown = cleanNoteMarkdown(record.ai_content);
  if (!markdown) return null;

  return {
    title: cleanNoteText(record.original_title) || fallbackTitle,
    markdown,
    format: cleanNoteText(record.format_used) || "markdown",
    sourceNodeId,
  };
}

function normalizeAiNote(note: AiNoteForNode | null): AiNoteForNode | null {
  if (!note || typeof note !== "object") return null;

  const markdown = cleanNoteMarkdown(note.markdown);
  if (!markdown) return null;

  return {
    id: typeof note.id === "string" ? note.id : "",
    title: cleanNoteText(note.title) || t("ui.ai_notes"),
    markdown,
    format: cleanNoteText(note.format) || "markdown",
    auto_generated: !!note.auto_generated,
    version: typeof note.version === "number" ? note.version : 1,
  };
}

function NotesLoadingState({ label }: { label: string }) {
  return (
    <div className="mx-auto w-full max-w-3xl animate-pulse space-y-4 py-6" role="status" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className="size-10 rounded-2xl bg-muted/70" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-36 rounded-full bg-muted/80" />
          <div className="h-2.5 w-56 max-w-[70%] rounded-full bg-muted/55" />
        </div>
      </div>
      <div className="space-y-3 rounded-2xl border border-border/50 bg-card/70 p-5">
        <div className="h-3 w-2/5 rounded-full bg-muted/75" />
        <div className="h-2.5 w-full rounded-full bg-muted/50" />
        <div className="h-2.5 w-11/12 rounded-full bg-muted/50" />
        <div className="h-20 rounded-xl bg-muted/35" />
      </div>
      <p className="text-center text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

export function NotesSection({
  courseId,
  blockId,
  aiActionsEnabled = true,
  immersive = false,
}: NotesSectionProps) {
  const t = useT();
  const contentTree = useCourseStore((s) => s.contentTree);
  const contentTreeCourseId = useCourseStore((s) => s.contentTreeCourseId);
  const fetchContentTree = useCourseStore((s) => s.fetchContentTree);
  const { saving, latestBatch, wrapSave } = useBatchManager({
    courseId,
    refreshSection: "notes",
    listFn: listGeneratedNoteBatches,
  });
  const selectedNodeId = useWorkspaceStore((s) => s.selectedNodeId);
  const focusedBlockId = useWorkspaceStore((s) => s.spaceLayout.focusedBlockId);
  const setSelectedNodeId = useWorkspaceStore((s) => s.setSelectedNodeId);
  const noteDraft = useWorkspaceStore((s) => s.noteDraft);
  const setNoteDraft = useWorkspaceStore((s) => s.setNoteDraft);
  const draft = noteDraft?.courseId === courseId ? noteDraft : null;
  const setDraft = useCallback((next: GeneratedNoteDraft | null) => {
    setNoteDraft(next ? { ...next, courseId } : null);
  }, [courseId, setNoteDraft]);
  const [generating, setGenerating] = useState(false);
  const [viewMode, setViewMode] = useState<"ai" | "source">("ai");
  const [aiNote, setAiNote] = useState<AiNoteForNode | null>(null);
  const [aiNoteLoading, setAiNoteLoading] = useState(false);
  const [aiNoteResolvedNodeId, setAiNoteResolvedNodeId] = useState<string | null>(null);
  const [sourceFiles, setSourceFiles] = useState<UploadedCourseFile[]>([]);
  const [sourceFilesLoading, setSourceFilesLoading] = useState(true);
  const [sourcePreview, setSourcePreview] = useState<{ url: string; name: string } | null>(null);
  const aiFetchRequestRef = useRef(0);
  const generateRequestRef = useRef(0);

  const contentNodes = useMemo(() => collectContentNodes(contentTree), [contentTree]);

  const selectedNode = useMemo(
    () => findNodeById(contentTree, selectedNodeId),
    [selectedNodeId, contentTree],
  );
  const selectedLearnableNode = selectedNode && isLearnableContentNode(selectedNode)
    ? selectedNode
    : null;
  const canUseAiNotes = !!selectedLearnableNode;
  const selectedNodeForFetch = selectedLearnableNode?.id;

  const currentIndex = useMemo(
    () => contentNodes.findIndex((n) => n.id === selectedLearnableNode?.id),
    [contentNodes, selectedLearnableNode?.id],
  );
  const canPrev = currentIndex > 0;
  const canNext = currentIndex >= 0 && currentIndex < contentNodes.length - 1;

  useEffect(() => {
    if (contentTreeCourseId !== courseId) {
      void fetchContentTree(courseId);
    }
  }, [courseId, contentTreeCourseId, fetchContentTree]);

  // An absent selection or a non-learning node (preface/catalogue) is source
  // material only. Never silently substitute the first chapter, because that
  // makes the AI Notes tab appear to belong to the preface.
  useEffect(() => {
    // A route-level deep link is written before the async course tree arrives.
    // Do not clear it while loading, and never validate it against another
    // course's tree left in the shared store.
    if (contentTreeCourseId !== courseId) return;
    if (!findFirstContentNode(contentTree)) {
      if (selectedNodeId) setSelectedNodeId(null);
      if (draft) setDraft(null);
      return;
    }

    const requested = findNodeById(contentTree, selectedNodeId);
    if (selectedNodeId && !requested) {
      setSelectedNodeId(null);
    }
    if (draft && draft.sourceNodeId !== (selectedLearnableNode?.id ?? "")) {
      setDraft(null);
    }
  }, [courseId, contentTreeCourseId, contentTree, selectedNodeId, setSelectedNodeId, draft, selectedLearnableNode?.id]);

  useEffect(() => {
    setViewMode(canUseAiNotes ? "ai" : "source");
  }, [canUseAiNotes, selectedNodeId]);

  // Fetch AI note for selected node
  useEffect(() => {
    if (!selectedNodeForFetch) {
      aiFetchRequestRef.current += 1;
      setAiNote(null);
      setAiNoteResolvedNodeId(null);
      setAiNoteLoading(false);
      return;
    }

    const requestId = ++aiFetchRequestRef.current;
    let cancelled = false;
    setAiNoteLoading(true);
    setAiNoteResolvedNodeId(null);
    getAiNoteForNode(courseId, selectedNodeForFetch)
      .then((note) => {
        if (!cancelled && requestId === aiFetchRequestRef.current) {
          setAiNote(normalizeAiNote(note));
          setAiNoteResolvedNodeId(selectedNodeForFetch);
          setAiNoteLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled && requestId === aiFetchRequestRef.current) {
          setAiNote(null);
          setAiNoteResolvedNodeId(selectedNodeForFetch);
          setAiNoteLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [courseId, selectedNodeForFetch]);

  useEffect(() => {
    let cancelled = false;
    setSourceFiles([]);
    setSourceFilesLoading(true);
    listCourseFiles(courseId)
      .then((files) => {
        if (!cancelled) {
          setSourceFiles(files);
          setSourceFilesLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSourceFiles([]);
          setSourceFilesLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [courseId]);

  useEffect(() => {
    if (!sourcePreview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSourcePreview(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [sourcePreview]);

  const handleGenerate = useCallback(async () => {
    if (!selectedLearnableNode) {
      toast.error(t("ui.select_section_first"));
      return;
    }

    const requestId = ++generateRequestRef.current;
    setGenerating(true);
    try {
      const result = await restructureNotes(selectedLearnableNode.id);
      if (requestId !== generateRequestRef.current) return;

      const nextDraft = normalizeGeneratedNoteDraft(
        result,
        selectedLearnableNode.id,
        selectedLearnableNode.title || t("ui.untitled_section"),
      );

      if (!nextDraft) {
        throw new Error(t("ui.ai_notes_empty"));
      }

      setDraft(nextDraft);
      setViewMode("ai");
      toast.success(t("ui.generated_ai_notes"));
    } catch (error) {
      if (requestId === generateRequestRef.current) {
        toast.error((error as Error).message || t("ui.failed_gen_notes"));
      }
    } finally {
      if (requestId === generateRequestRef.current) {
        setGenerating(false);
      }
    }
  }, [selectedLearnableNode, t]);

  const handleSave = useCallback(
    async (replaceBatchId?: string) => {
      if (!draft) return;
      await wrapSave(() =>
        saveGeneratedNotes(courseId, draft.markdown, draft.title, draft.sourceNodeId, replaceBatchId),
      );
    },
    [courseId, draft, wrapSave],
  );

  // Determine what AI content to show
  const aiContent = draft?.markdown ?? aiNote?.markdown;
  const aiTitle = draft?.title ?? aiNote?.title;
  const hasAiNotes = !!(aiContent && aiContent.length > 0);
  const NotesViewport = immersive ? "div" : ScrollArea;

  if (contentTreeCourseId !== courseId) {
    return <NotesLoadingState label={t("ui.loading")} />;
  }

  if (contentTree.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 text-center">
        <div>
          <p className="text-muted-foreground text-sm">{t("notes.empty")}</p>
        </div>
      </div>
    );
  }

  return (
    <>
    <div role="region" aria-label={t("ui.course_notes")} className={`flex w-full flex-1 ${immersive ? "self-start overflow-visible" : "min-h-0 overflow-hidden"}`} data-testid="notes-panel">
      <div className={`flex w-full flex-1 flex-col ${immersive ? "overflow-visible" : "min-h-0"}`}>
        <div
          role="toolbar"
          aria-label={t("ui.notes_toolbar")}
          className="sticky top-0 z-30 flex min-h-11 shrink-0 items-center gap-2 border-b border-border/60 bg-card px-3 py-2 shadow-[0_8px_18px_-16px_rgba(30,45,38,0.7)]"
        >
          {/* AI / Source toggle */}
          <div role="group" aria-label={t("ui.view_mode")} className="flex items-center gap-0.5 rounded-xl bg-muted/30 p-0.5">
            <button
              type="button"
              disabled={!canUseAiNotes}
              aria-pressed={viewMode === "ai" ? "true" : "false"}
              className={`px-2 py-0.5 text-xs rounded ${
                viewMode === "ai"
                  ? "bg-primary text-primary-foreground"
                  : canUseAiNotes
                    ? "text-muted-foreground hover:text-foreground"
                    : "cursor-not-allowed text-muted-foreground/40"
              }`}
              onClick={() => setViewMode("ai")}
            >
              {t("notes.aiView")}
            </button>
            <button
              type="button"
              aria-pressed={viewMode === "source" ? "true" : "false"}
              className={`px-2 py-0.5 text-xs rounded ${
                viewMode === "source"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setViewMode("source")}
            >
              {t("notes.sourceView")}
            </button>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* Node selector: prev / dropdown / next */}
            {contentNodes.length > 1 && (
              <>
                <button
                  type="button"
                  className="px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-30"
                  disabled={!canPrev}
                  onClick={() => canPrev && setSelectedNodeId(contentNodes[currentIndex - 1].id)}
                  aria-label={t("ui.previous_section")}
                >
                  &lsaquo;
                </button>
                <select
                  value={selectedLearnableNode?.id ?? ""}
                  onChange={(e) => setSelectedNodeId(e.target.value)}
                  className="h-6 text-xs rounded border border-border bg-background px-1 max-w-[160px] truncate"
                  aria-label={t("ui.select_section")}
                >
                  <option value="" disabled>
                    {t("ui.select_section")}
                  </option>
                  {contentNodes.map((n, i) => (
                    <option key={n.id} value={n.id}>
                      {n.title || `${t("ui.untitled_section")} ${i + 1}`}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-30"
                  disabled={!canNext}
                  onClick={() => canNext && setSelectedNodeId(contentNodes[currentIndex + 1].id)}
                  aria-label={t("ui.next_section")}
                >
                  &rsaquo;
                </button>
              </>
            )}
            {contentNodes.length <= 1 && selectedLearnableNode ? (
              <Badge variant="outline" className="max-w-56 truncate">
                {selectedLearnableNode.title}
              </Badge>
            ) : null}
            {draft && latestBatch?.is_active ? (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                onClick={() => void handleSave(latestBatch.batch_id)}
                disabled={saving || generating}
              >
                替换最新版本
              </Button>
            ) : null}
            {draft ? (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                onClick={() => void handleSave()}
                disabled={saving || generating}
              >
                另存为新版本
              </Button>
            ) : null}            <Button
              data-testid="notes-generate"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => void handleGenerate()}
              disabled={!aiActionsEnabled || generating || saving || !canUseAiNotes}
            >
              {generating ? <span className="animate-pulse mr-1">...</span> : null}
              {t("notes.regenerate")}
            </Button>
          </div>
        </div>

        {!aiActionsEnabled ? <AiFeatureBlocked compact className="mx-4 mt-4" /> : null}

        <NotesViewport className={`${immersive ? "p-4" : "min-h-0 flex-1 p-4 scrollbar-thin"} ${
          !immersive && viewMode === "ai" && hasAiNotes
            ? "xl:[&_[data-slot=scroll-area-scrollbar]]:hidden xl:[&_[data-slot=scroll-area-viewport]]:!overflow-hidden"
            : ""
        }`}>
          {!selectedLearnableNode ? (
            <div className="mx-auto flex max-w-md flex-col items-center justify-center rounded-2xl border border-dashed border-brand/30 bg-brand-muted/20 px-6 py-12 text-center">
              <BookOpen className="mb-3 size-8 text-brand" aria-hidden="true" />
              <p className="text-base font-semibold text-foreground">先选择一个学习内容</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">选择一个知识点后，就可以在这里记录你的学习笔记。</p>
            </div>
          ) : viewMode === "ai" ? (
            <>
              {aiNoteLoading || aiNoteResolvedNodeId !== selectedNodeForFetch ? (
                <NotesLoadingState label={t("ui.loading_ai_notes")} />
              ) : hasAiNotes ? (
                <div data-testid="notes-preview">
                  <CornellNoteView
                    courseId={courseId}
                    nodeId={selectedLearnableNode!.id}
                    title={aiTitle}
                    markdown={aiContent!}
                    focused={!!blockId && focusedBlockId === blockId}
                    immersive={immersive}
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <p className="text-sm text-muted-foreground">
                    {t("notes.noAiNotesForSection")}
                  </p>
                  <Button
                    size="sm"
                    onClick={() => void handleGenerate()}
                    disabled={!aiActionsEnabled || generating || !canUseAiNotes}
                  >
                    {generating ? t("ui.generating") : t("ui.generate_ai_notes")}
                  </Button>
                </div>
              )}
            </>
          ) : sourceFilesLoading ? (
            <NotesLoadingState label={t("notes.preparingSource")} />
          ) : sourceFiles.length > 0 && (!selectedNode || selectedNode.source_type === "file") ? (
            <div className="mx-auto max-w-3xl overflow-hidden rounded-3xl border border-amber-200/80 bg-gradient-to-br from-amber-50 via-orange-50/70 to-emerald-50/70 shadow-[0_18px_50px_-35px_rgba(120,80,20,0.55)] dark:border-amber-900 dark:from-amber-950/30 dark:via-background dark:to-emerald-950/20">
              <div className="relative border-b border-amber-200/60 px-6 py-5 dark:border-amber-900/70">
                <div className="pointer-events-none absolute -right-8 -top-12 size-32 rounded-full bg-amber-200/35 blur-2xl" />
                <div className="relative flex items-center gap-4">
                  <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white text-amber-700 shadow-sm ring-1 ring-amber-200 dark:bg-background dark:text-amber-300 dark:ring-amber-900">
                    <BookOpen className="size-6" />
                  </div>
                  <div>
                    <p className="flex items-center gap-2 font-bold text-amber-950 dark:text-amber-100">
                      {t("notes.sourceCardTitle")}
                      <Sparkles className="size-4 text-amber-500" />
                    </p>
                    <p className="mt-1 text-sm leading-6 text-amber-950/65 dark:text-amber-100/65">
                      {t("notes.sourceCardDescription")}
                    </p>
                  </div>
                </div>
              </div>
              <div className="space-y-3 p-4 sm:p-5">
                {sourceFiles.length ? sourceFiles.map((file) => (
                  <button
                    type="button"
                    key={file.id}
                    onClick={() => setSourcePreview({
                      url: `${API_BASE}/content/files/${file.job_id}`,
                      name: file.filename || file.file_name || t("notes.originalPdf"),
                    })}
                    className="group flex w-full items-center gap-4 rounded-2xl border border-white/90 bg-white/85 px-4 py-4 text-left shadow-sm ring-1 ring-amber-100 transition duration-200 hover:-translate-y-0.5 hover:border-emerald-200 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:border-border dark:bg-card/90 dark:ring-amber-900"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900">
                      <BookOpen className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-foreground">{file.filename || file.file_name || t("notes.originalPdf")}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">{t("notes.sourceFileHint")}</span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition group-hover:bg-emerald-700">
                      {t("notes.openOriginal")}
                      <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </button>
                )) : (
                  <p className="text-sm text-muted-foreground">{t("notes.originalUnavailable")}</p>
                )}
              </div>
            </div>
          ) : (
            // Plain-text and web sources remain readable as extracted text.
            selectedNode ? (
              <ContentNodeItem node={selectedNode} />
            ) : (
              contentTree.map((node) => (
                <ContentNodeItem key={node.id} node={node} />
              ))
            )
          )}
        </NotesViewport>
      </div>
    </div>
    {sourcePreview && typeof document !== "undefined" ? createPortal(
      <div className="fixed inset-0 z-[100] flex flex-col bg-background" role="dialog" aria-modal="true" aria-label={sourcePreview.name}>
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold">{sourcePreview.name}</p>
          <button
            type="button"
            onClick={() => setSourcePreview(null)}
            className="inline-flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t("ui.close")}
          >
            <X className="size-5" />
          </button>
        </div>
        <iframe
          src={sourcePreview.url}
          title={sourcePreview.name}
          className="min-h-0 flex-1 border-0 bg-white"
        />
      </div>,
      document.body,
    ) : null}
    </>
  );
}
