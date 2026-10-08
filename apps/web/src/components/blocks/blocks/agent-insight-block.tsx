"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Sparkles, ArrowRight, GraduationCap, Compass, Clock, Shield, AlertTriangle,
  Flame, LayoutGrid, Brain, BookOpen, HandMetal, Bell, X, ChevronRight,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useWorkspaceStore } from "@/store/workspace";
import type { BlockComponentProps } from "@/lib/block-system/registry";
import type { BlockType, LearningMode } from "@/lib/block-system/types";
import { updateUnlockContext } from "@/lib/block-system/feature-unlock";
import { logAgentDecision } from "@/lib/api";
import { useT } from "@/lib/i18n-context";

const MODE_ICONS: Record<string, typeof GraduationCap> = {
  course_following: GraduationCap, self_paced: Compass, exam_prep: Clock, maintenance: Shield,
};

const INSIGHT_CONFIG: Record<string, {
  icon: typeof Sparkles; titleKey?: string; descKey?: string; ctaKey?: string;
  title?: string; description?: string; cta?: string; autoDismissMs?: number;
}> = {
  review_needed: { icon: Sparkles, titleKey: "insight.reviewNeeded.title", descKey: "insight.reviewNeeded.desc", ctaKey: "insight.reviewNeeded.cta" },
  weak_topic: { icon: AlertTriangle, titleKey: "insight.weakTopic.title", descKey: "insight.weakTopic.desc", ctaKey: "insight.weakTopic.cta" },
  streak_milestone: { icon: Flame, titleKey: "insight.streak.title", descKey: "insight.streak.desc", autoDismissMs: 10_000 },
  layout_suggestion: { icon: LayoutGrid, titleKey: "insight.layout.title", descKey: "insight.layout.desc", ctaKey: "insight.layout.cta" },
  feature_unlock: { icon: Sparkles, titleKey: "insight.featureUnlock.title", ctaKey: "insight.featureUnlock.cta" },
  cognitive_alert: { icon: Brain, titleKey: "insight.cognitiveAlert.title", descKey: "insight.cognitiveAlert.desc", ctaKey: "insight.cognitiveAlert.cta" },
  weak_topic_focus: { icon: BookOpen, titleKey: "insight.weakTopicFocus.title", descKey: "insight.weakTopicFocus.desc", ctaKey: "insight.weakTopicFocus.cta" },
  welcome_back: { icon: HandMetal, titleKey: "insight.welcomeBack.title", descKey: "insight.welcomeBack.desc", ctaKey: "insight.welcomeBack.cta", autoDismissMs: 15_000 },
  learning_companion: { icon: Compass, titleKey: "insight.companion.title", descKey: "insight.companion.desc" },
  mastery_gate: { icon: BookOpen, title: "先补好基础，再继续往前学", description: "有几个前置知识点还需要巩固。完成它们后，后面的学习会更轻松。", cta: "去复习基础" },
  review_session_cta: { icon: Sparkles, title: "现在花几分钟复习一下吧", description: "有些内容到了适合回顾的时间，复习能帮你记得更牢。", cta: "开始复习" },
};

function isChineseText(value: string | undefined) {
  return Boolean(value && /[\u3400-\u9fff]/.test(value));
}

export default function AgentInsightBlock({ courseId, blockId, config }: BlockComponentProps) {
  const router = useRouter();
  const t = useT();
  const [isOpen, setIsOpen] = useState(false);
  const setLearningMode = useWorkspaceStore((s) => s.setLearningMode);
  const dismissAgentBlock = useWorkspaceStore((s) => s.dismissAgentBlock);
  const addBlock = useWorkspaceStore((s) => s.addBlock);
  const applyBlockTemplate = useWorkspaceStore((s) => s.applyBlockTemplate);
  const insightType = config.insightType as string | undefined;
  const suggestedMode = config.suggestedMode as LearningMode | undefined;
  const reason = config.reason as string | undefined;
  const suggestionSignals = Array.isArray(config.suggestionSignals) ? config.suggestionSignals.filter((s): s is string => typeof s === "string") : [];
  const conceptNames = Array.isArray(config.concepts)
    ? (config.concepts as unknown[]).filter((value): value is string => typeof value === "string" && value.trim().length > 0 && !/^(unknown|none|null|未知|未命名)$/i.test(value.trim()))
    : [];
  const suggestedTemplate = config.suggestedTemplate as string | undefined;
  const topicName = config.topicName as string | undefined;
  const autoDismissMs = insightType ? INSIGHT_CONFIG[insightType]?.autoDismissMs : undefined;
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!autoDismissMs) return;
    dismissTimerRef.current = setTimeout(() => dismissAgentBlock(blockId), autoDismissMs);
    return () => clearTimeout(dismissTimerRef.current);
  }, [autoDismissMs, blockId, dismissAgentBlock]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setIsOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleCta = () => {
    if (insightType === "review_needed" || insightType === "review_session_cta") {
      router.push(`/course/${courseId}/review?originInsight=${encodeURIComponent(blockId)}`);
    } else if (insightType === "mode_suggestion" && suggestedMode) {
      void logAgentDecision({ course_id: courseId, action: "apply_mode_suggestion_direct", title: t("mode.switch"), reason, decision_type: "mode_suggestion", source: "agent_insight_panel", top_signal_type: "manual_override", metadata_json: { suggested_mode: suggestedMode, signals: suggestionSignals } }).catch(() => undefined);
      setLearningMode(suggestedMode);
      updateUnlockContext(courseId, { mode: suggestedMode });
    } else if (insightType === "weak_topic") {
      addBlock("quiz", topicName ? { topic: topicName } : {}, "agent");
    } else if (insightType === "layout_suggestion" && suggestedTemplate) {
      applyBlockTemplate(suggestedTemplate);
    } else if (insightType === "feature_unlock") {
      const blockType = config.suggestedBlockType as string | undefined;
      if (blockType) addBlock(blockType as BlockType, {}, "agent");
    } else if (insightType === "cognitive_alert") {
      useWorkspaceStore.getState().undoLayout();
    } else if (insightType === "weak_topic_focus" || insightType === "mastery_gate" || insightType === "welcome_back") {
      addBlock("review", { topics: config.weakTopics ?? conceptNames }, "agent");
    }
    setIsOpen(false);
    dismissAgentBlock(blockId);
  };
  const handleDismiss = () => {
    if (insightType === "mode_suggestion") {
      void logAgentDecision({ course_id: courseId, action: "dismiss_mode_suggestion", title: t("mode.switch"), reason, decision_type: "mode_suggestion", source: "agent_insight_panel", top_signal_type: "manual_override", metadata_json: { suggested_mode: suggestedMode, signals: suggestionSignals } }).catch(() => undefined);
    }
    setIsOpen(false);
    dismissAgentBlock(blockId);
  };

  const insightCfg = insightType ? INSIGHT_CONFIG[insightType] : undefined;
  const ModeIcon = insightType === "mode_suggestion" && suggestedMode ? MODE_ICONS[suggestedMode] ?? Sparkles : insightCfg?.icon ?? Sparkles;
  const title = insightType === "mode_suggestion" && suggestedMode ? `学习方式建议：${t(`mode.${suggestedMode}`)}` : insightCfg?.title ?? (insightCfg?.titleKey ? t(insightCfg.titleKey) : "你的 AI 学习提醒");
  const generatedDescription = insightType === "mastery_gate" && conceptNames.length
    ? `建议先巩固「${conceptNames.join("」「")}」，再继续学习后面的内容。`
    : insightType === "weak_topic" && topicName ? t("insight.weakTopic.topicDesc").replace("{topic}", topicName) : insightCfg?.description ?? (insightCfg?.descKey ? t(insightCfg.descKey) : "");
  const desc = isChineseText(reason) ? reason : generatedDescription;
  const ctaLabel = insightType === "mode_suggestion" ? `切换为${suggestedMode ? t(`mode.${suggestedMode}`) : "推荐方式"}` : insightCfg?.cta ?? (insightCfg?.ctaKey ? t(insightCfg.ctaKey) : undefined);

  return <>
    <button type="button" onClick={() => setIsOpen(true)} className="group flex w-full items-center gap-3 rounded-xl border border-brand/20 bg-gradient-to-r from-brand-muted/70 via-card to-card px-3.5 py-3 text-left transition hover:border-brand/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-haspopup="dialog" aria-expanded={isOpen}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground shadow-sm"><Bell className="size-4" /></span>
      <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-foreground">AI 学习提醒</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{title}</span></span>
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-brand">查看建议 <ChevronRight className="size-3.5" /></span>
    </button>

    {isOpen && typeof document !== "undefined" && createPortal(
      <div className="fixed inset-0 z-[80] flex items-start justify-center bg-foreground/10 px-4 pt-[max(5rem,env(safe-area-inset-top))] backdrop-blur-[1px] sm:justify-end sm:pt-24 sm:pr-6" role="presentation" onMouseDown={() => setIsOpen(false)}>
        <section role="dialog" aria-modal="true" aria-labelledby={`agent-insight-title-${blockId}`} className="w-full max-w-md overflow-hidden rounded-2xl border border-brand/25 bg-card shadow-[0_24px_70px_-28px_rgba(30,45,38,0.45)]" onMouseDown={(event) => event.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-border/60 bg-brand-muted/45 px-5 py-3.5"><div className="flex items-center gap-2 text-sm font-semibold text-foreground"><span className="flex size-7 items-center justify-center rounded-full bg-brand text-brand-foreground"><Sparkles className="size-3.5" /></span>你的 AI 学习助手</div><button type="button" onClick={() => setIsOpen(false)} className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-card hover:text-foreground" aria-label="暂时收起建议" title="暂时收起"><X className="size-4" /></button></div>
          <div className="p-5"><div className="flex gap-3"><span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-muted text-brand"><ModeIcon className="size-5" /></span><div className="min-w-0"><p className="text-xs font-medium text-brand">学习建议</p><h3 id={`agent-insight-title-${blockId}`} className="mt-1 text-lg font-bold tracking-tight text-foreground">{title}</h3></div></div>
            {desc && <p className="mt-4 text-sm leading-6 text-muted-foreground">{desc}</p>}
            {insightType === "mastery_gate" && conceptNames.length > 0 && <p className="mt-3 rounded-xl bg-muted/65 px-3 py-2 text-xs leading-5 text-muted-foreground">建议先巩固：{conceptNames.join("、")}</p>}
            <div className="mt-5 flex items-center justify-between gap-3"><button type="button" onClick={handleDismiss} className="rounded-lg px-2 py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground">不再提示</button>{ctaLabel && <button type="button" onClick={handleCta} className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{ctaLabel}<ArrowRight className="size-4" /></button>}</div>
          </div>
        </section>
      </div>, document.body,
    )}
  </>;
}
