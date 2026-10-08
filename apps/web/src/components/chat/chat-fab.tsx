"use client";
import { t } from "@/lib/i18n";

import { cn } from "@/lib/utils";
import { LumateMascotIcon } from "./lumate-mascot-icon";

interface ChatFabProps {
  open: boolean;
  onToggle: () => void;
  hasUnread?: boolean;
}

export function ChatFab({ open, onToggle, hasUnread }: ChatFabProps) {
  if (open) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={open ? t("ui.close_chat") : t("ui.open_chat")}
      aria-expanded={open}
      className={cn(
        "fixed bottom-6 right-6 z-50 flex items-center justify-center",
        "h-16 w-16 rounded-[22px] border transition-all duration-300",
        "hover:scale-105 active:scale-95",
        "border-brand/20 bg-card text-foreground shadow-[0_10px_30px_-12px_rgba(71,100,80,0.55)] hover:border-brand/40 hover:shadow-[0_14px_34px_-12px_rgba(71,100,80,0.62)]",
      )}
    >
      <LumateMascotIcon className="size-12" />
      {!open && hasUnread && (
        <span className="absolute right-1.5 top-1.5 size-3 rounded-full border-2 border-card bg-destructive" />
      )}
    </button>
  );
}
