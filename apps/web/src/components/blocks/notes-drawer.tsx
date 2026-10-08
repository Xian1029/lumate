"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Maximize2, X } from "lucide-react";
import { NotesSection } from "@/components/sections/notes-section";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useT } from "@/lib/i18n-context";

interface NotesDrawerProps {
  courseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  aiActionsEnabled?: boolean;
}

/**
 * Temporary immersive view for AI notes. Pinning changes the workspace layout;
 * this layer only covers the window until it is closed.
 */
export function NotesDrawer({ courseId, open, onOpenChange, aiActionsEnabled = true }: NotesDrawerProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onOpenChange]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("ui.notes_fullscreen")}
      className="fixed inset-0 z-[100] flex min-h-0 flex-col bg-background"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 bg-card px-4 shadow-sm sm:px-6">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-brand-muted text-brand" aria-hidden="true">
          <Maximize2 className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{t("ui.notes_fullscreen")}</p>
          <p className="hidden text-xs text-muted-foreground sm:block">{t("ui.notes_fullscreen_hint")}</p>
        </div>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("ui.close_notes_fullscreen")}
          title={t("ui.close_notes_fullscreen")}
        >
          <X className="size-4" />
          <span>{t("ui.close")}</span>
        </button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 scrollbar-thin [scrollbar-gutter:stable] sm:px-4 sm:pb-4">
        <div className="mx-auto flex min-h-full w-full max-w-[1600px] rounded-b-2xl border-x border-b border-border/60 bg-card shadow-sm">
          <NotesSection courseId={courseId} aiActionsEnabled={aiActionsEnabled} immersive />
        </div>
      </main>
    </div>,
    document.body,
  );
}
