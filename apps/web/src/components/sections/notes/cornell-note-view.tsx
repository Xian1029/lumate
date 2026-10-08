"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, Check, Lightbulb, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/shared/markdown-renderer";
import {
  createPersonalNote,
  deletePersonalNote,
  listPersonalNotes,
  updatePersonalNote,
  type PersonalNote,
  type PersonalNoteStyle,
} from "@/lib/api";
import { useT } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";

const NOTE_STYLES: Array<{ value: PersonalNoteStyle; dot: string; card: string }> = [
  { value: "sunshine", dot: "bg-amber-300", card: "border-amber-200 bg-amber-50/80" },
  { value: "mint", dot: "bg-emerald-300", card: "border-emerald-200 bg-emerald-50/80" },
  { value: "sky", dot: "bg-sky-300", card: "border-sky-200 bg-sky-50/80" },
  { value: "berry", dot: "bg-pink-300", card: "border-pink-200 bg-pink-50/80" },
];

function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractCornellCues(markdown: string): string[] {
  const candidates = [
    ...Array.from(markdown.matchAll(/^#{1,4}\s+(.+)$/gm), (match) => match[1]),
    ...Array.from(markdown.matchAll(/\*\*([^*]{2,30})\*\*/g), (match) => match[1]),
  ];
  return Array.from(new Set(candidates.map(plainText).filter((item) => item.length >= 2))).slice(0, 7);
}

export function extractCornellSummary(markdown: string): string {
  const text = plainText(markdown);
  if (!text) return "";
  const sentences = text.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
  const summary = sentences.slice(0, 2).join("");
  return summary.length > 180 ? `${summary.slice(0, 180)}…` : summary;
}

function styleClass(style: PersonalNoteStyle): string {
  return NOTE_STYLES.find((item) => item.value === style)?.card ?? NOTE_STYLES[0].card;
}

interface CornellNoteViewProps {
  courseId: string;
  nodeId: string;
  title?: string;
  markdown: string;
  focused?: boolean;
  immersive?: boolean;
}

export function CornellNoteView({ courseId, nodeId, title, markdown, focused = false, immersive = false }: CornellNoteViewProps) {
  const t = useT();
  const cues = useMemo(() => extractCornellCues(markdown), [markdown]);
  const summary = useMemo(() => extractCornellSummary(markdown), [markdown]);
  const [notes, setNotes] = useState<PersonalNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [text, setText] = useState("");
  const [style, setStyle] = useState<PersonalNoteStyle>("sunshine");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const resetEditor = useCallback(() => {
    setText("");
    setStyle("sunshine");
    setEditingId(null);
    setPendingDeleteId(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    resetEditor();
    listPersonalNotes(courseId, nodeId)
      .then((items) => { if (!cancelled) setNotes(items); })
      .catch(() => { if (!cancelled) setNotes([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [courseId, nodeId, resetEditor]);

  const save = async () => {
    const nextText = text.trim();
    if (!nextText || saving) return;
    setSaving(true);
    try {
      const saved = editingId
        ? await updatePersonalNote(courseId, editingId, nodeId, nextText, style)
        : await createPersonalNote(courseId, nodeId, nextText, style);
      setNotes((current) => editingId
        ? current.map((item) => item.id === saved.id ? saved : item)
        : [saved, ...current]);
      resetEditor();
      toast.success(t("notes.personalSaved"));
    } catch (error) {
      toast.error((error as Error).message || t("notes.personalSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (note: PersonalNote) => {
    try {
      await deletePersonalNote(courseId, note.id);
      setNotes((current) => current.filter((item) => item.id !== note.id));
      if (editingId === note.id) resetEditor();
      setPendingDeleteId(null);
      toast.success(t("notes.personalDeleted"));
    } catch (error) {
      toast.error((error as Error).message || t("notes.personalDeleteFailed"));
    }
  };

  return (
    <article
      className={cn(
        "rounded-2xl border border-[#d9e7dc] bg-[#fffef9] shadow-sm",
        immersive && "overflow-visible",
      )}
      data-testid="cornell-note"
    >
      <header className={cn(
        "flex shrink-0 items-center gap-3 rounded-t-2xl border-b border-[#d9e7dc] bg-gradient-to-r from-emerald-50/90 via-amber-50/55 to-violet-50/70 px-5 py-4",
      )}>
          <span className="flex size-9 items-center justify-center rounded-xl bg-white text-emerald-700 shadow-sm"><BookOpen className="size-5" /></span>
          <div className="min-w-0">
            <p className="truncate font-semibold text-foreground">{title}</p>
            <p className="text-xs text-muted-foreground">{t("notes.cornellHint")}</p>
          </div>
          <div className={cn(
            "ml-auto hidden -rotate-2 items-center gap-2 rounded-full border border-amber-200 bg-white/75 px-3 py-1.5 text-xs font-medium text-amber-800 shadow-sm sm:flex",
            immersive && "xl:hidden",
          )}>
            <Pencil className="size-4 text-amber-500" />
            {t("notes.pencilPrompt")}
          </div>
      </header>

      <div className={cn(
        "grid items-start xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-stretch xl:overflow-hidden",
        immersive
          ? "overflow-visible xl:items-start xl:overflow-visible"
          : focused
          ? "xl:h-[calc(100dvh-21rem)] xl:min-h-[28rem]"
          : "xl:h-[clamp(30rem,62dvh,34rem)]",
      )}>
        <div className={cn(
          "min-w-0 xl:border-r xl:border-[#d9e7dc]",
          !immersive && "xl:h-full xl:overflow-y-scroll xl:overscroll-contain xl:scrollbar-thin xl:[scrollbar-gutter:stable]",
        )}>
          <div className="grid md:grid-cols-[12rem_minmax(0,1fr)]">
            <aside className="border-b-2 border-[#d9e7dc] bg-amber-50/45 p-4 md:border-b-0 md:border-r-2">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-900"><Lightbulb className="size-4" />{t("notes.cornellCues")}</div>
              <div className="space-y-2">
                {(cues.length ? cues : [t("notes.cornellCueFallback")]).map((cue) => (
                  <div key={cue} className="rounded-xl border border-amber-200/70 bg-white/75 px-3 py-2 text-xs leading-5 text-amber-950">{cue}</div>
                ))}
              </div>
              <p className="mt-4 text-xs leading-5 text-muted-foreground">{t("notes.cornellQuestionPrompt")}</p>
            </aside>

            <section className="min-w-0 border-b-2 border-[#d9e7dc] bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_31px,rgba(49,93,75,0.055)_32px)] p-5">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-emerald-900"><Sparkles className="size-4" />{t("notes.cornellMain")}</div>
              <MarkdownRenderer content={markdown} className="max-w-none text-sm" />
            </section>
          </div>

          <footer className="rounded-bl-2xl bg-emerald-50/45 px-5 py-4">
            <p className="mb-1 text-sm font-semibold text-emerald-900">{t("notes.cornellSummary")}</p>
            <p className="text-sm leading-6 text-foreground/80">{summary || t("notes.cornellSummaryFallback")}</p>
          </footer>
        </div>

        <aside className={cn(
          "self-stretch border-t border-violet-100 xl:border-t-0 xl:border-l",
          immersive
            ? "bg-[repeating-linear-gradient(to_bottom,#fbfaff_0,#fbfaff_31px,rgba(139,92,246,0.045)_32px)]"
            : "bg-gradient-to-b from-violet-50/70 to-white xl:h-full xl:overflow-hidden",
        )} data-testid="personal-notes">
        <div className={cn(
          "flex flex-col p-4",
          immersive && "xl:sticky xl:top-11 xl:max-h-[calc(100dvh-7rem)] xl:overflow-hidden",
          !immersive && "xl:h-full",
        )}>
        <div className="mb-3 flex items-start gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-700"><Pencil className="size-4" /></span>
          <div>
            <p className="text-sm font-semibold">{t("notes.personalTitle")}</p>
            <p className="text-xs leading-5 text-muted-foreground">{t("notes.personalHint")}</p>
          </div>
        </div>

        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("notes.personalPlaceholder")}
          maxLength={5000}
          className="min-h-28 w-full resize-y rounded-xl border border-violet-200 bg-white/90 p-3 text-sm leading-6 outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
        />
        <div className="mt-2 space-y-2">
          <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1" aria-label={t("notes.personalStyle")}>
            {NOTE_STYLES.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setStyle(item.value)}
                className={`size-7 rounded-full border-2 p-1 transition ${style === item.value ? "scale-110 border-violet-500" : "border-transparent"}`}
                aria-label={t(`notes.personalStyle.${item.value}`)}
                aria-pressed={style === item.value}
              ><span className={`block size-full rounded-full ${item.dot}`} /></button>
            ))}
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground">{text.length}/5000</span>
          </div>
          <div className="flex justify-end gap-2">
            {editingId ? <Button type="button" size="sm" variant="outline" className="h-8 min-w-20 rounded-xl px-3" onClick={resetEditor}><X className="mr-1 size-3.5" />{t("notes.personalCancel")}</Button> : null}
            <Button type="button" size="sm" className="h-8 min-w-24 rounded-xl px-3" disabled={!text.trim() || saving} onClick={() => void save()}>
              {editingId ? <Check className="mr-1 size-3.5" /> : <Plus className="mr-1 size-3.5" />}
              {saving ? t("notes.personalSaving") : editingId ? t("notes.personalSave") : t("notes.personalAdd")}
            </Button>
          </div>
        </div>

        <div className="mt-4 max-h-64 min-h-0 space-y-2 overflow-y-auto pr-1 scrollbar-thin xl:max-h-none xl:flex-1">
          {loading ? <p className="py-4 text-center text-xs text-muted-foreground">{t("ui.loading")}</p> : null}
          {!loading && notes.length === 0 ? <p className="rounded-xl border border-dashed border-violet-200 px-3 py-5 text-center text-xs leading-5 text-muted-foreground">{t("notes.personalEmpty")}</p> : null}
          {notes.map((note) => (
            <div key={note.id} className={`group rounded-xl border p-3 ${styleClass(note.style)}`}>
              <p className="whitespace-pre-wrap break-words text-sm leading-6">{note.text}</p>
              {pendingDeleteId === note.id ? (
                <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5 rounded-lg bg-white/65 px-2 py-1.5">
                  <span className="mr-auto text-[11px] text-rose-700">{t("notes.personalDeleteInline")}</span>
                  <button type="button" className="rounded-lg px-2 py-1 text-[11px] text-muted-foreground hover:bg-white" onClick={() => setPendingDeleteId(null)}>{t("notes.personalCancel")}</button>
                  <button type="button" className="rounded-lg bg-rose-100 px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-200" onClick={() => void remove(note)}>{t("notes.personalDeleteConfirmAction")}</button>
                </div>
              ) : (
                <div className="mt-2 flex justify-end gap-1 opacity-70 transition group-hover:opacity-100">
                  <button type="button" className="rounded-lg p-1.5 hover:bg-white/70" aria-label={t("notes.personalEdit")} onClick={() => { setEditingId(note.id); setText(note.text); setStyle(note.style); setPendingDeleteId(null); }}><Pencil className="size-3.5" /></button>
                  <button type="button" className="rounded-lg p-1.5 text-rose-600 hover:bg-white/70" aria-label={t("notes.personalDelete")} onClick={() => setPendingDeleteId(note.id)}><Trash2 className="size-3.5" /></button>
                </div>
              )}
            </div>
          ))}
        </div>
        </div>
        </aside>
      </div>
    </article>
  );
}
