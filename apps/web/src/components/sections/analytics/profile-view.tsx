"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getLearningProfile,
  restorePreference,
  restoreSignal,
  dismissMemory,
  restoreMemory,
  type LearningProfile,
  type Preference,
  type PreferenceSignal,
  type MemoryProfileItem,
} from "@/lib/api";
import { useT } from "@/lib/i18n-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { getPersona, getOptimalStudyWindows, formatStudyWindow } from "@/lib/learner-persona";
import { BookOpen, Clock3, Footprints, Sprout } from "lucide-react";

interface ProfileViewProps {
  courseId: string;
}

const DIMENSION_LABELS: Record<string, string> = {
  language: "交流语言",
  detail_level: "讲解节奏",
  layout_preset: "页面安排",
  note_format: "笔记方式",
  explanation_style: "思考方式",
  visual_preference: "图像帮助",
  quiz_difficulty: "练习难度",
  learning_mode: "学习模式",
};

const VALUE_LABELS: Record<string, string> = {
  zh: "使用中文",
  en: "使用英文",
  detailed: "喜欢讲得细一点",
  concise: "喜欢简单直接",
  balanced: "内容安排刚刚好",
  step_by_step: "喜欢一步一步整理",
  socratic: "喜欢通过提问来思考",
  diagram_heavy: "图示越清楚越容易理解",
  adaptive: "练习会跟着我的情况变化",
  easy: "先从轻松题开始",
  hard: "喜欢挑战难题",
};

function friendlyPreference(pref: Preference): string | null {
  const dimension = DIMENSION_LABELS[pref.dimension];
  const value = VALUE_LABELS[String(pref.value)];
  if (!dimension || !value) return null;
  return value.startsWith(dimension) ? value : `${dimension}：${value}`;
}

function friendlySignal(signal: PreferenceSignal): string | null {
  const value = String(signal.value).toLowerCase();
  if (value.includes("chapter_list")) return "我常用课程目录寻找学习内容";
  if (value.includes("notes")) return "我喜欢边看笔记边学习";
  if (value.includes("progress")) return "我会关注自己的学习进度";
  if (value.includes("quiz")) return "我正在通过小测验巩固知识";
  if (value.includes("flashcard")) return "我会用闪卡帮助记忆";
  return null;
}

export function ProfileView({ courseId }: ProfileViewProps) {
  const t = useT();
  const [profile, setProfile] = useState<LearningProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDismissed, setShowDismissed] = useState(false);

  const fetchProfile = useCallback(async () => {
    try {
      const data = await getLearningProfile(courseId);
      setProfile(data);
    } catch {
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  const handleRestorePreference = useCallback(
    async (pref: Preference) => {
      try {
        await restorePreference(pref.id);
        toast.success(t("profile.restored"));
        await fetchProfile();
      } catch {
        toast.error(t("ui.failed_restore_pref"));
      }
    },
    [fetchProfile, t],
  );

  const handleRestoreSignal = useCallback(
    async (signal: PreferenceSignal) => {
      try {
        await restoreSignal(signal.id);
        toast.success(t("profile.restored"));
        await fetchProfile();
      } catch {
        toast.error(t("ui.failed_restore_signal"));
      }
    },
    [fetchProfile, t],
  );

  const handleDismissMemory = useCallback(
    async (mem: MemoryProfileItem) => {
      try {
        await dismissMemory(mem.id);
        toast.success(t("ui.memory_dismissed"));
        await fetchProfile();
      } catch {
        toast.error(t("ui.failed_dismiss_memory"));
      }
    },
    [fetchProfile, t],
  );

  const handleRestoreMemory = useCallback(
    async (mem: MemoryProfileItem) => {
      try {
        await restoreMemory(mem.id);
        toast.success(t("ui.memory_restored"));
        await fetchProfile();
      } catch {
        toast.error(t("ui.failed_restore_memory"));
      }
    },
    [fetchProfile, t],
  );

  if (loading) {
    return (
      <div className="flex-1 p-8">
        <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  if (!profile || (profile.preferences.length === 0 && profile.memories.length === 0)) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <h3 className="text-sm font-medium mb-1">{t("course.profile")}</h3>
        <p className="text-xs text-muted-foreground max-w-xs">
          {t("profile.emptySignals")}
        </p>
      </div>
    );
  }

  const hasDismissed =
    profile.dismissed_preferences.length > 0 || profile.dismissed_signals.length > 0 || profile.dismissed_memories.length > 0;

  const persona = getPersona();
  const studyWindows = getOptimalStudyWindows();
  const preferenceInsights = Array.from(new Set(profile.preferences.map(friendlyPreference).filter(Boolean))) as string[];
  const signalInsights = Array.from(new Set(profile.signals.map(friendlySignal).filter(Boolean))) as string[];
  const friendlyMemories = profile.memories.filter((item) => /[\u3400-\u9fff]/.test(item.summary));
  const friendlyStrengths = profile.summary?.strength_areas.filter((item) => /[\u3400-\u9fff]/.test(item)) ?? [];
  const friendlyGrowthAreas = profile.summary?.weak_areas.filter((item) => /[\u3400-\u9fff]/.test(item)) ?? [];
  const learnerLevel = Math.min(6, Math.floor(persona.totalSessions / 5) + 1);
  const levelProgress = persona.totalSessions % 5;

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-5">
      <div className="overflow-hidden rounded-2xl border border-brand/15 bg-gradient-to-br from-emerald-50 via-card to-amber-50 p-5 dark:from-emerald-950/20 dark:to-amber-950/10">
        <div className="flex items-start gap-3">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-card text-2xl shadow-sm">🌟</span>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">{t("profile.kidTitle")}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("profile.kidIntro")}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge className="rounded-full bg-brand text-primary-foreground">{t("profile.explorerBadge")} · Lv.{learnerLevel}</Badge>
              <span className="text-[11px] text-muted-foreground">{5 - levelProgress}{t("profile.nextLevelHint")}</span>
            </div>
            <div className="mt-2 flex gap-1" aria-label={t("profile.levelProgress")}>
              {[0, 1, 2, 3, 4].map((step) => (
                <span key={step} className={`h-2 flex-1 rounded-full ${step < levelProgress ? "bg-amber-400" : "bg-white/80 dark:bg-white/10"}`} />
              ))}
            </div>
          </div>
        </div>
      </div>
      {/* Local Learner Persona */}
      {persona.totalSessions > 0 && (
        <div className="rounded-2xl card-shadow bg-card p-4 space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Clock3 className="size-4 text-brand" />{t("profile.rhythmTitle")}</h3>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-muted-foreground">{t("ui.sessions_tracked")}</p>
              <p className="text-foreground font-medium">{persona.totalSessions}</p>
            </div>
            {persona.avgSessionMinutes > 0 && (
              <div>
                <p className="text-muted-foreground">{t("ui.avg_session")}</p>
                <p className="text-foreground font-medium">{Math.round(persona.avgSessionMinutes)} {t("profile.minutes")}</p>
              </div>
            )}
            {persona.noteFormat !== "auto" && (
              <div>
                <p className="text-muted-foreground">{t("ui.note_format")}</p>
                <p className="text-foreground font-medium capitalize">{persona.noteFormat.replace(/_/g, " ")}</p>
              </div>
            )}
            {persona.difficultyPreference !== "adaptive" && (
              <div>
                <p className="text-muted-foreground">{t("ui.difficulty")}</p>
                <p className="text-foreground font-medium capitalize">{persona.difficultyPreference}</p>
              </div>
            )}
          </div>
          {studyWindows.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">{t("ui.optimal_study_windows")}</p>
              <div className="flex flex-wrap gap-1.5">
                {studyWindows.map((w, i) => (
                  <Badge key={i} variant="outline" className="rounded-full bg-brand/[0.04] text-xs">
                    {formatStudyWindow(w)} · {w.count}{t("profile.times")}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {persona.stickingPoints.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">{t("ui.sticking_points")}</p>
              <div className="flex flex-wrap gap-1.5">
                {persona.stickingPoints.slice(0, 5).map((s) => (
                  <Badge key={s} variant="outline" className="text-xs text-orange-600">
                    {s}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {preferenceInsights.length > 0 && (
        <section className="rounded-2xl border border-violet-100 bg-violet-50/45 p-4 dark:border-violet-900/50 dark:bg-violet-950/10">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><BookOpen className="size-4 text-violet-500" />{t("profile.preferencesTitle")}</h3>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {preferenceInsights.slice(0, 6).map((item) => (
              <div key={item} className="rounded-xl bg-card px-3 py-2.5 text-xs leading-5 shadow-sm">{item}</div>
            ))}
          </div>
        </section>
      )}

      {signalInsights.length > 0 && (
        <section className="rounded-2xl border border-sky-100 bg-sky-50/45 p-4 dark:border-sky-900/50 dark:bg-sky-950/10">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Footprints className="size-4 text-sky-500" />{t("profile.footprintsTitle")}</h3>
          <div className="mt-3 space-y-2">
            {signalInsights.slice(0, 4).map((item) => (
              <div key={item} className="flex items-center gap-2 text-xs leading-5"><span className="size-2 rounded-full bg-sky-400" />{item}</div>
            ))}
          </div>
        </section>
      )}

      {/* Active memories */}
      {friendlyMemories.length > 0 && (
        <section className="rounded-2xl border border-emerald-100 bg-emerald-50/40 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/10">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Sprout className="size-4 text-emerald-500" />{t("profile.discoveriesTitle")}</h3>
          <div className="space-y-1.5">
            {friendlyMemories.slice(0, 5).map((mem) => (
              <div
                key={mem.id}
                className="group flex items-start gap-2 rounded-xl bg-muted/30 px-3.5 py-2.5 text-xs"
              >
                <span className="flex-1">{mem.summary}</span>
                <button
                  type="button"
                  className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive group-hover:inline-flex"
                  onClick={() => void handleDismissMemory(mem)}
                  title={t("ui.dismiss_this_memory")}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Summary */}
      {profile.summary && (
        <div className="space-y-2">
          {friendlyStrengths.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t("profile.strengthsTitle")}
              </h4>
              <div className="flex flex-wrap gap-1">
                {friendlyStrengths.map((s) => (
                  <Badge key={s} variant="outline" className="text-xs text-green-600">
                    {s}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {friendlyGrowthAreas.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t("profile.growthTitle")}
              </h4>
              <div className="flex flex-wrap gap-1">
                {friendlyGrowthAreas.map((w) => (
                  <Badge key={w} variant="outline" className="text-xs text-orange-600">
                    {w}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Dismissed items (toggle) */}
      {hasDismissed && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => setShowDismissed((v) => !v)}
          >
            {showDismissed ? t("profile.hideStored") : t("profile.showStored")}（{profile.dismissed_preferences.length + profile.dismissed_signals.length + profile.dismissed_memories.length}）
          </Button>
          {showDismissed && (
            <div className="mt-2 space-y-2 rounded-xl border border-dashed border-border/60 p-3.5">
              {profile.dismissed_preferences.map((pref) => (
                <div
                  key={pref.id}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <span className="flex-1 line-through">
                    {friendlyPreference(pref) ?? t("profile.onePreference")}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto p-1 text-xs"
                    onClick={() => void handleRestorePreference(pref)}
                  >
                    {t("profile.restore")}
                  </Button>
                </div>
              ))}
              {profile.dismissed_signals.map((signal) => (
                <div
                  key={signal.id}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <span className="flex-1 line-through">
                    {friendlySignal(signal) ?? t("profile.oneFootprint")}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto p-1 text-xs"
                    onClick={() => void handleRestoreSignal(signal)}
                  >
                    {t("profile.restore")}
                  </Button>
                </div>
              ))}
              {profile.dismissed_memories.map((mem) => (
                <div
                  key={mem.id}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <span className="flex-1 line-through">{/[\u3400-\u9fff]/.test(mem.summary) ? mem.summary : t("profile.oneMemory")}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto p-1 text-xs"
                    onClick={() => void handleRestoreMemory(mem)}
                  >
                    {t("profile.restore")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
