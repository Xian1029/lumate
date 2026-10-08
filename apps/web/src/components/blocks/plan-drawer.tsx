"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, X } from "lucide-react";
import Link from "next/link";
import { CoursePlanStatus } from "@/components/learning-plans/course-plan-status";
import { useFocusTrap } from "@/hooks/use-focus-trap";

interface PlanDrawerProps {
  courseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  aiActionsEnabled?: boolean;
}

export function PlanDrawer({ courseId, open, onOpenChange }: PlanDrawerProps) {
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
    <div className="fixed inset-0 z-[100] bg-foreground/20 backdrop-blur-[1px]" onMouseDown={() => onOpenChange(false)}>
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="学习计划"
        className="flex h-full w-[min(92vw,760px)] flex-col border-r border-border/70 bg-background shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 bg-card px-4">
          <span className="flex size-8 items-center justify-center rounded-xl bg-violet-100 text-violet-700" aria-hidden="true">
            <CalendarDays className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">学习计划</p>
            <p className="text-xs text-muted-foreground">安排、完成和延后任务都在这里</p>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="关闭学习计划"
            title="关闭学习计划"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4"><CoursePlanStatus courseId={courseId} /><Link href="/learning-plans" onClick={() => onOpenChange(false)} className="mt-4 inline-flex text-sm font-medium text-brand hover:underline">打开学习计划中心 →</Link></div>
      </aside>
    </div>,
    document.body,
  );
}
