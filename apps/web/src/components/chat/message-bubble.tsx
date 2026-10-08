"use client";

import { t } from "@/lib/i18n";
import Image from "next/image";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/store/chat";
import { ActionCard } from "@/components/chat/action-card";
import { Badge } from "@/components/ui/badge";
import { MarkdownRenderer } from "@/components/shared/markdown-renderer";
import { BookOpen, ChevronDown } from "lucide-react";

interface MessageBubbleProps {
  message: ChatMessage;
}

function compactEvidenceLabels(groups: { label?: string; matched_facets?: string[]; matched_terms?: string[] }[]): string[] {
  const labels: string[] = [];
  for (const group of groups) {
    for (const raw of [group.label, ...(group.matched_facets ?? []), ...(group.matched_terms ?? [])]) {
      if (!raw) continue;
      for (const label of raw.split(/\s+/).filter((item) => item.length >= 2).sort((a, b) => b.length - a.length)) {
        if (labels.some((existing) => existing.includes(label))) continue;
        const withoutShorter = labels.filter((existing) => !label.includes(existing));
        withoutShorter.push(label);
        labels.splice(0, labels.length, ...withoutShorter);
      }
    }
  }
  return labels.slice(0, 6);
}

function cleanReferenceTitle(raw?: string): string {
  if (!raw) return "课程资料";
  const segments = raw.split(/\s*>\s*/);
  const specific = segments.at(-1)?.trim();
  if (specific && !/\.pdf$/i.test(specific)) return specific;
  return raw.replace(/^【?\d+】?\s*/, "").replace(/\.pdf$/i, "").trim();
}

/**
 * Single message bubble.
 *
 * - User messages: right-aligned, chat-user colours.
 * - Assistant messages: left-aligned, safely rendered Markdown.
 * - Shows ActionCard components when metadata.actions is present.
 * - Displays attached images for user messages.
 * - Shows audio playback controls for voice responses.
 */
export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const actions = message.metadata?.actions;
  const contentRefs = message.metadata?.provenance?.content_refs ?? [];
  const evidenceGroups = message.metadata?.provenance?.content_evidence_groups ?? [];
  const evidenceLabels = compactEvidenceLabels(evidenceGroups);
  const images = message.images;
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const displayContent = isUser
    ? message.content
    : message.content
        .split(/(?:\n|^)\s*(?:#{1,3}\s*)?(?:\*{1,2})?(?:Sources?|来源)(?:\*{1,2})?\s*[:：](?:\*{1,2})?/i)[0]
        .replace(/^Early stopping required\.?$/gim, t("chat.responseInterrupted"))
        .replace(/\*\*([^*\n]+)\*\*/g, "$1")
        .trim();
  const referenceLabel = t("chat.referenceMaterials") === "chat.referenceMaterials"
    ? "参考资料"
    : t("chat.referenceMaterials");

  return (
    <>
      <div
        role="article"
        aria-label={isUser ? t("ui.your_message") : t("ui.assistant_message")}
        className={cn("flex mb-2", isUser ? "justify-end" : "justify-start")}
        data-testid={isUser ? "chat-message-user" : "chat-message-assistant"}
        data-role={message.role}
      >
        <div
          className={cn(
            "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm",
            isUser
              ? "bg-[var(--chat-user-bg,hsl(var(--primary)))] text-[var(--chat-user-fg,hsl(var(--primary-foreground)))] rounded-br-md"
              : "bg-[var(--chat-assistant-bg,hsl(var(--muted)))] text-[var(--chat-assistant-fg,hsl(var(--foreground)))] rounded-bl-md",
          )}
        >
          {/* Attached images (user messages) */}
          {isUser && images && images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {images.map((img, i) => (
                <button
                  key={`${img.filename ?? "img"}-${i}`}
                  type="button"
                  aria-label={`放大图片：${img.filename ?? `图片 ${i + 1}`}`}
                  className="rounded-md overflow-hidden border border-white/20 hover:opacity-80 transition-opacity"
                  onClick={() =>
                    setExpandedImage(`data:${img.media_type};base64,${img.data}`)
                  }
                >
                  <Image
                    src={`data:${img.media_type};base64,${img.data}`}
                    alt={img.filename ?? `图片 ${i + 1}`}
                    width={80}
                    height={80}
                    unoptimized
                    className="h-20 w-20 object-cover"
                  />
                </button>
              ))}
            </div>
          )}

          {/* Message content */}
          {displayContent && displayContent !== "(image)" ? (
            isUser ? (
              <div className="whitespace-pre-wrap break-words">{displayContent}</div>
            ) : (
              <MarkdownRenderer
                content={displayContent}
                className="chat-markdown max-w-none break-words text-sm leading-7 [&_h1]:mt-1 [&_h1]:text-lg [&_h2]:mt-4 [&_h2]:text-base [&_p]:my-1.5 [&_ul]:my-2 [&_ol]:my-2 [&_pre]:my-2 [&_table]:text-xs"
              />
            )
          ) : !images?.length ? (
            <span className="text-xs italic opacity-60">...</span>
          ) : null}

          {/* Action cards from metadata */}
          {!isUser && actions && actions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {actions.map((action, i) => (
                <ActionCard
                  key={`${action.action}-${i}`}
                  action={{
                    type: action.action,
                    label: action.action === "focus_topic"
                      ? "查看相关知识点"
                      : undefined,
                    payload: {
                      ...(action.extra ? { extra: action.extra } : {}),
                      ...(action.action === "data_updated" && action.value ? { section: action.value } : {}),
                      ...(action.action === "focus_topic" && action.value ? { nodeId: action.value } : {}),
                    },
                  }}
                />
              ))}
            </div>
          )}

          {!isUser && (evidenceGroups.length > 0 || contentRefs.length > 0) && (
            <details className="group mt-3 overflow-hidden rounded-xl border border-brand/15 bg-card/70 shadow-sm">
              <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold text-brand hover:bg-brand/[0.05]">
                <span className="flex size-7 items-center justify-center rounded-lg bg-brand/10"><BookOpen className="size-4" /></span>
                <span>{referenceLabel}</span>
                <ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180" />
              </summary>

              <div className="space-y-3 border-t border-brand/10 px-3 py-3">
                {evidenceLabels.length > 0 ? (
                  <div className="space-y-1">
                    <div className="flex flex-wrap gap-1">
                      {evidenceLabels.map((label) => (
                        <Badge key={label} variant="outline" className="text-[10px]">{label}</Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
                {contentRefs.length > 0 ? (
                  <div className="space-y-2">
                    {contentRefs.slice(0, 2).map((ref, index) => (
                      <div key={`${ref.title ?? "evidence"}-${index}`} className="rounded-lg border border-brand/10 bg-background/80 px-3 py-2 text-xs">
                        <p className="font-medium leading-5">{cleanReferenceTitle(ref.title)}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </details>
          )}
        </div>
      </div>

      {/* Expanded image overlay */}
      {expandedImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 cursor-pointer"
          onClick={() => setExpandedImage(null)}
          onKeyDown={(e) => { if (e.key === "Escape") setExpandedImage(null); }}
          role="dialog"
          aria-label={t("ui.expanded_image_view_click_or_press_escape_to_close")}
          aria-modal="true"
        >
          <Image
            src={expandedImage}
            alt={t("ui.expanded_view")}
            width={1440}
            height={1080}
            unoptimized
            className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain"
          />
        </div>
      )}
    </>
  );
}
