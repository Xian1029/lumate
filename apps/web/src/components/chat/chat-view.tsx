"use client";

import { t } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { Compass, Lightbulb, Puzzle } from "lucide-react";
import { useChatStore } from "@/store/chat";
import { useWorkspaceStore, type SectionId } from "@/store/workspace";
import { ChatHeader } from "@/components/chat/chat-header";
import { MessageList } from "@/components/chat/message-list";
import { GeneratedQuizCard } from "@/components/chat/generated-quiz-card";
import { ChatInput } from "@/components/chat/chat-input";
import { ToolStatus } from "@/components/chat/tool-status";
import { AiFeatureBlocked } from "@/components/shared/ai-feature-blocked";
import type { ChatAction } from "@/lib/api";
import { useCourseStore } from "@/store/course";
import { findNodeById } from "@/lib/content-tree";

interface ChatViewProps {
  courseId: string;
  courseName?: string;
  aiActionsEnabled?: boolean;
  onClose?: () => void;
}

/**
 * Main chat container.
 *
 * Sits at the bottom of the workspace (full width, like a VS Code terminal
 * panel). Layout: header + message list + tool-status bar + input bar.
 */
export function ChatView({
  courseId,
  aiActionsEnabled = true,
  onClose,
}: ChatViewProps) {
  const [readyCourseId, setReadyCourseId] = useState<string | null>(null);
  const sessionsReady = readyCourseId === courseId;
  const messages = useChatStore((s) => s.messages);
  const toolStatus = useChatStore((s) => s.toolStatus);
  const setCourseContext = useChatStore((s) => s.setCourseContext);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const isLoadingSessions = useChatStore((s) => s.isLoadingSessions);
  const registerFallbackOnAction = useChatStore((s) => s.registerFallbackOnAction);
  const setActiveSection = useWorkspaceStore((s) => s.setActiveSection);
  const activeSection = useWorkspaceStore((s) => s.activeSection);
  const selectedNodeId = useWorkspaceStore((s) => s.selectedNodeId);
  const contentTree = useCourseStore((s) => s.contentTree);
  const setSelectedNodeId = useWorkspaceStore((s) => s.setSelectedNodeId);
  const triggerRefresh = useWorkspaceStore((s) => s.triggerRefresh);

  // Set course context and load sessions on mount / courseId change.
  useEffect(() => {
    let cancelled = false;
    setCourseContext(courseId);
    void loadSessions(courseId, { restoreLatest: true }).finally(() => {
      if (!cancelled) setReadyCourseId(courseId);
    });
    return () => { cancelled = true; };
  }, [courseId, setCourseContext, loadSessions]);

  // Only greet after history restoration finishes, so a local welcome never
  // replaces an existing conversation. Clearing for a new chat triggers it again.
  useEffect(() => {
    if (!sessionsReady || isLoadingSessions || messages.length > 0) return;
    const currentNode = findNodeById(contentTree, selectedNodeId);
    const greeting = {
      id: `local-welcome-${courseId}-${Date.now()}`,
      role: "assistant" as const,
      content: currentNode
        ? `${t("chat.welcomeWithCourse")}“${currentNode.title}”${t("chat.welcomeWithCourseEnd")}`
        : t("chat.welcomeGeneral"),
      timestamp: new Date(),
    };
    useChatStore.setState((state) => ({
      messagesByCourse: { ...state.messagesByCourse, [courseId]: [greeting] },
      messages: state.activeCourseId === courseId ? [greeting] : state.messages,
    }));
  }, [contentTree, courseId, isLoadingSessions, messages.length, selectedNodeId, sessionsReady]);

  const showStarters = sessionsReady && messages.length === 1 && messages[0]?.id.startsWith("local-welcome-");
  const hasCurrentLesson = Boolean(findNodeById(contentTree, selectedNodeId));
  const starters = hasCurrentLesson
    ? [
        { icon: Lightbulb, label: t("chat.starterExplain") },
        { icon: Puzzle, label: t("chat.starterQuiz") },
        { icon: Compass, label: t("chat.starterGuide") },
      ]
    : [
        { icon: Lightbulb, label: t("chat.starterAskQuestion") },
        { icon: Compass, label: t("chat.starterChooseTopic") },
        { icon: Puzzle, label: t("chat.starterTalkGoal") },
      ];

  // Register the onAction handler to bridge chat actions to workspace sections.
  useEffect(() => {
    const blockTypeToSection = (blockType: string): SectionId => {
      if (blockType === "plan") return "plan";
      if (blockType === "progress" || blockType === "forecast") return "analytics";
      if (blockType === "quiz" || blockType === "flashcards" || blockType === "wrong_answers" || blockType === "review") {
        return "practice";
      }
      return "notes";
    };

    const handleAction = (action: ChatAction) => {
      const type = action.action;
      if (type === "data_updated") {
        const section = action.value as SectionId | undefined;
        if (section) {
          triggerRefresh(section);
          setActiveSection(section);
        }
        return;
      }

      if (type === "focus_topic") {
        const nodeId = action.value;
        if (nodeId) {
          setSelectedNodeId(nodeId);
          setActiveSection("notes");
        }
        return;
      }

      if (type === "set_learning_mode" || type === "suggest_mode") {
        setActiveSection("plan");
        triggerRefresh("plan");
        return;
      }

      if (type === "add_block" || type === "remove_block") {
        const [blockType] = (action.value ?? "").split(":");
        const section = blockTypeToSection(blockType);
        setActiveSection(section);
        triggerRefresh(section);
        return;
      }

      if (type === "resize_block") {
        const [blockType] = (action.value ?? "").split(":");
        const section = blockTypeToSection(blockType);
        setActiveSection(section);
        triggerRefresh(section);
        return;
      }

      if (type === "reorder_blocks" || type === "apply_template" || type === "agent_insight") {
        setActiveSection("notes");
        triggerRefresh("notes");
      }
    };

    return registerFallbackOnAction(handleAction);
  }, [registerFallbackOnAction, setActiveSection, setSelectedNodeId, triggerRefresh]);

  return (
    <div role="region" aria-label={t("ui.chat")} className="flex h-full flex-col bg-background/80">
      <ChatHeader courseId={courseId} onClose={onClose} />

      <div className="relative flex min-h-0 flex-1 flex-col">
        <MessageList messages={messages} />
        {isLoadingSessions ? (
          <div role="status" className="absolute inset-x-3 top-3 z-20 rounded-xl border border-brand/10 bg-background/95 px-3 py-2 text-center text-xs text-muted-foreground shadow-sm backdrop-blur">
            {t("chat.loadingHistory")}
          </div>
        ) : null}
      </div>

      {showStarters ? (
        <div className="shrink-0 border-t border-border/40 bg-gradient-to-b from-background to-brand/[0.04] px-3 py-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">{t("chat.pickAStarter")}</p>
          <div className="grid gap-2">
            {starters.map(({ icon: Icon, label }) => (
              <button
                key={label}
                type="button"
                disabled={!aiActionsEnabled || isStreaming}
                onClick={() => {
                  const node = findNodeById(contentTree, selectedNodeId);
                  void sendMessage(courseId, label, {
                    activeTab: activeSection,
                    tabContext: node ? {
                      selected_node_id: node.id,
                      selected_node_title: node.title,
                      selected_node_content: node.content?.slice(0, 4000) ?? "",
                      instruction: "Only answer from this current learning node. Do not infer a different chapter.",
                    } : { context_source: activeSection },
                  });
                }}
                className="flex min-h-10 items-center gap-2 rounded-xl border border-brand/15 bg-card px-3 py-2 text-left text-sm shadow-sm transition hover:-translate-y-0.5 hover:border-brand/35 hover:bg-brand/[0.06] disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand"><Icon className="size-4" /></span>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <ToolStatus status={toolStatus} />

      <GeneratedQuizCard courseId={courseId} />

      {!aiActionsEnabled ? <AiFeatureBlocked compact className="mx-3 mb-2" /> : null}

      <ChatInput courseId={courseId} disabled={!aiActionsEnabled} />
    </div>
  );
}
