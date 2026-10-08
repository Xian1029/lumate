"use client";

import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { SendHorizontal, Square } from "lucide-react";

interface SendButtonProps {
  isStreaming: boolean;
  canSend: boolean;
  onSend: () => void;
  onStop: () => void;
}

/**
 * Toggles between a Send button and a Stop button depending on
 * whether the chat is currently streaming a response.
 */
export function SendButton({
  isStreaming,
  canSend,
  onSend,
  onStop,
}: SendButtonProps) {
  if (isStreaming) {
    return (
      <Button
        type="button"
        variant="destructive"
        size="icon-xs"
        className="mb-0.5 rounded-full"
        data-testid="chat-stop"
        onClick={onStop}
        title={t("ui.stop_generating")}
        aria-label={t("ui.stop_generating")}
      >
        <Square className="size-3" />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="default"
      size="icon-xs"
      className="mb-0.5 rounded-full"
      data-testid="chat-send"
      onClick={onSend}
      disabled={!canSend}
      aria-disabled={!canSend}
      title={t("ui.send_message")}
      aria-label={t("ui.send_message")}
    >
      <SendHorizontal className="size-3.5" />
    </Button>
  );
}
