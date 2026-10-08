"use client";

import { t } from "@/lib/i18n";
import { useChatStore } from "@/store/chat";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, X } from "lucide-react";
import { useState } from "react";

interface ChatHeaderProps {
  courseId: string;
  onClose?: () => void;
}

/**
 * Compact chat panel header with session selector and "New Chat" button.
 * Height ~36px.
 */
export function ChatHeader({ courseId, onClose }: ChatHeaderProps) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const sessionsByCourse = useChatStore((s) => s.sessionsByCourse);
  const sessionIds = useChatStore((s) => s.sessionIds);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const isLoadingSessions = useChatStore((s) => s.isLoadingSessions);
  const loadSessionMessages = useChatStore((s) => s.loadSessionMessages);
  const startNewSession = useChatStore((s) => s.startNewSession);
  const deleteSession = useChatStore((s) => s.deleteSession);

  const sessions = sessionsByCourse[courseId] ?? [];
  const currentSessionId = sessionIds[courseId] ?? "";

  const formatSessionLabel = (session: (typeof sessions)[number], index: number) => {
    if (session.title) return session.title;
    const date = session.created_at
      ? new Date(session.created_at).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })
      : "";
    return `${t("ui.conversation")} ${index + 1}${date ? ` - ${date}` : ""}`;
  };

  return (
    <div role="banner" aria-label={t("ui.chat_header")} className="relative flex h-12 min-w-0 shrink-0 items-center gap-1 border-b border-border/40 px-2">
      <Select
        value={currentSessionId || "__current__"}
        onValueChange={(value) => {
          if (value && value !== "__current__") {
            void loadSessionMessages(courseId, value);
          }
        }}
        disabled={isStreaming || isLoadingSessions}
      >
        <SelectTrigger
          size="sm"
          className="h-8 min-w-0 flex-1 text-xs"
          data-testid="chat-session-select"
          aria-label={t("ui.select_chat_session")}
        >
          <SelectValue placeholder={t("ui.current_conversation")} />
        </SelectTrigger>
        <SelectContent position="popper" align="end" className="z-[110] max-w-[min(24rem,calc(100vw-1rem))]">
          <SelectItem value="__current__">{t("ui.current_conversation")}</SelectItem>
          {sessions.map((session, i) => (
            <SelectItem key={session.id} value={session.id}>
              {formatSessionLabel(session, i)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {currentSessionId ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={isStreaming || isLoadingSessions}
          onClick={() => setDeleteOpen(true)}
          aria-label={t("chat.deleteHistory")}
          title={t("chat.deleteHistory")}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </Button>
      ) : null}

      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => startNewSession(courseId)}
        disabled={isStreaming}
        title={t("ui.new_chat")}
        aria-label={t("ui.start_new_chat_session")}
      >
        <Plus className="size-4" />
        <span className="sr-only">{t("ui.new_chat")}</span>
      </Button>
      {onClose ? (
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label={t("ui.close_chat")} title={t("ui.close_chat")}>
          <X className="size-4" />
        </Button>
      ) : null}
      {deleteOpen ? (
        <div role="dialog" aria-label={t("chat.deleteHistoryTitle")} className="absolute right-2 top-11 z-[120] w-[min(20rem,calc(100vw-1rem))] rounded-2xl border border-amber-200/70 bg-amber-50/95 p-4 text-amber-950 shadow-xl backdrop-blur dark:border-amber-900/60 dark:bg-amber-950/95 dark:text-amber-50">
          <div className="flex gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/70 text-amber-600 dark:bg-white/10 dark:text-amber-300"><Trash2 className="size-4" /></span>
            <div>
              <p className="text-sm font-semibold">{t("chat.deleteHistoryTitle")}</p>
              <p className="mt-1 text-xs leading-5 opacity-75">{t("chat.deleteHistoryGentle")}</p>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDeleteOpen(false)}>{t("chat.keepHistory")}</Button>
            <Button
              size="sm"
              variant="outline"
              className="border-amber-300 bg-white/70 text-amber-800 hover:bg-white dark:border-amber-800 dark:bg-white/10 dark:text-amber-100"
              onClick={() => {
                setDeleteOpen(false);
                if (currentSessionId) void deleteSession(courseId, currentSessionId);
              }}
            >{t("chat.confirmDelete")}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
