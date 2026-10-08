"use client";

import { t } from "@/lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatView } from "./chat-view";
import { cn } from "@/lib/utils";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { useFocusTrap } from "@/hooks/use-focus-trap";

interface ChatDrawerProps {
  courseId: string;
  courseName?: string;
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  aiActionsEnabled?: boolean;
}

/** True when viewport is below the md breakpoint (768px). */
function useIsMobile() {
  const [mobile, setMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 767px)").matches;
  });
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  return mobile;
}

/**
 * On mobile (< 768px), renders as a bottom sheet with swipe-down to dismiss.
 * On desktop, renders as the original side drawer.
 */
export function ChatDrawer({
  courseId,
  courseName,
  open,
  onOpenChange,
  aiActionsEnabled = true,
}: ChatDrawerProps) {
  const isMobile = useIsMobile();
  const drawerRef = useRef<HTMLDivElement>(null);
  const handleClose = useCallback(() => onOpenChange?.(false), [onOpenChange]);

  // Trap focus within the drawer when open (desktop)
  useFocusTrap(drawerRef, open);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange?.(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  return (
    <>
      {/* Mobile: bottom sheet — only mount when actually mobile to avoid Radix portal leak */}
      {isMobile && (
        <BottomSheet open={open} onOpenChange={(v) => onOpenChange?.(v)} title={t("ui.chat")}>
          <div className="h-[75dvh]">
            {open && <ChatView courseId={courseId} courseName={courseName} aiActionsEnabled={aiActionsEnabled} onClose={handleClose} />}
          </div>
        </BottomSheet>
      )}

      {/* Desktop: side drawer (>= md) */}
      <div
        ref={drawerRef}
        role="complementary"
        aria-label={t("ui.chat_panel")}
        aria-hidden={!open ? "true" : undefined}
        className={cn(
          "hidden md:block fixed inset-y-0 right-0 z-[70] h-dvh w-full sm:w-[420px] md:w-[480px] isolate",
          "bg-card border-l border-border/40 shadow-2xl",
          "transition-transform duration-300 ease-in-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {open && (
          <ChatView courseId={courseId} courseName={courseName} aiActionsEnabled={aiActionsEnabled} onClose={handleClose} />
        )}
      </div>
    </>
  );
}
