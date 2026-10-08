import type { MasterySnapshot, WrongAnswer, ReviewItem } from "@/lib/api";
import { getErrorSignalLabel } from "@/lib/display-mappers";

export type TranslateFn = (key: string) => string;

export function matchesFocus(text: string | null | undefined, terms: string[]): boolean {
  if (!text || terms.length === 0) return false;
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

export function scoreWrongAnswerFocus(item: WrongAnswer, terms: string[]): number {
  if (terms.length === 0) return 0;
  const question = (item.question ?? "").toLowerCase();
  const diagnosis = (item.diagnosis ?? "").toLowerCase();
  const knowledgePoints = (item.knowledge_points ?? []).map((point) => point.toLowerCase());

  let score = 0;
  for (const term of terms) {
    if (question.includes(term)) score += 2;
    if (diagnosis.includes(term)) score += 1;
    for (const point of knowledgePoints) {
      if (point.includes(term) || term.includes(point)) {
        score += 3;
        break;
      }
    }
  }
  return score;
}

export interface RankedSignal {
  label: string;
  count: number;
}

export interface ErrorPatternSummary {
  diagnoses: RankedSignal[];
  categories: RankedSignal[];
  knowledgePoints: RankedSignal[];
}

export interface WrongAnswerFocus {
  label: string;
  type: string | null;
  count: number;
  unresolvedCount: number;
  recoveredCount: number;
  latestAt: string | null;
  representative: WrongAnswer;
}

/**
 * Turns individual mistakes into an evidence-based study diagnosis.  A group
 * is only called "recurring" when two or more real wrong-answer records have
 * the same knowledge point / diagnosed error type; one accidental miss stays
 * an individual item instead of being overstated as a weakness.
 */
export function buildWrongAnswerFocus(items: WrongAnswer[]): WrongAnswerFocus[] {
  const groups = new Map<string, WrongAnswer[]>();
  for (const item of items) {
    const point = item.knowledge_points?.find(Boolean)?.trim();
    const type = toSignalDisplayLabel(item.error_category ?? item.error_detail?.category ?? item.diagnosis ?? item.error_detail?.diagnosis);
    const label = point || type || "这道题的解题思路";
    const key = `${label}::${type ?? "unknown"}`.toLocaleLowerCase();
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const representative = group[0];
      const point = representative.knowledge_points?.find(Boolean)?.trim();
      const type = toSignalDisplayLabel(representative.error_category ?? representative.error_detail?.category ?? representative.diagnosis ?? representative.error_detail?.diagnosis);
      const recoveredCount = group.filter((item) => item.mastered).length;
      const latestAt = group
        .map((item) => item.created_at)
        .filter((value): value is string => Boolean(value))
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;
      return {
        label: point || type || "这道题的解题思路",
        type,
        count: group.length,
        unresolvedCount: group.length - recoveredCount,
        recoveredCount,
        latestAt,
        representative,
      };
    })
    .sort((a, b) => b.unresolvedCount - a.unresolvedCount || b.count - a.count)
    .slice(0, 4);
}

export interface MasteryTimelinePoint {
  recordedAt: string;
  masteryPercent: number;
  gapType: string | null;
  sampleCount: number;
}

/**
 * The database writes a snapshot after each answer.  Showing every write as a
 * timeline item is noisy, so retain the latest reading per day and only keep
 * meaningful changes (plus the first and latest evidence).
 */
export function buildMasteryTimelinePoints(snapshots: MasterySnapshot[], maxPoints = 4): MasteryTimelinePoint[] {
  const byDay = new Map<string, MasterySnapshot>();
  const sampleCount = new Map<string, number>();
  for (const snapshot of [...snapshots].sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime())) {
    const date = new Date(snapshot.recorded_at);
    if (Number.isNaN(date.getTime())) continue;
    const key = date.toISOString().slice(0, 10);
    byDay.set(key, snapshot);
    sampleCount.set(key, (sampleCount.get(key) ?? 0) + 1);
  }
  const daily = [...byDay.entries()].map(([key, snapshot]) => ({
    recordedAt: snapshot.recorded_at,
    masteryPercent: Math.round(Math.max(0, Math.min(1, snapshot.mastery_score)) * 100),
    gapType: snapshot.gap_type,
    sampleCount: sampleCount.get(key) ?? 1,
  }));
  if (daily.length <= maxPoints) return daily;

  const meaningful = daily.filter((point, index) => {
    if (index === 0 || index === daily.length - 1) return true;
    const previous = daily[index - 1];
    return Math.abs(point.masteryPercent - previous.masteryPercent) >= 5 || point.gapType !== previous.gapType;
  });
  if (meaningful.length <= maxPoints) return meaningful;
  const indices = new Set<number>([0, meaningful.length - 1]);
  for (let slot = 1; slot < maxPoints - 1; slot += 1) {
    indices.add(Math.round((slot * (meaningful.length - 1)) / (maxPoints - 1)));
  }
  return meaningful.filter((_, index) => indices.has(index));
}

export type ErrorRadarDimension = {
  id: "conceptual" | "procedural" | "computational" | "reading" | "careless";
  count: number;
};

export const MIN_ERROR_RADAR_EVIDENCE = 3;

const RADAR_DIAGNOSIS_DIMENSION: Record<string, ErrorRadarDimension["id"]> = {
  "fundamental gap": "conceptual",
  "missing prerequisite": "conceptual",
  "surface memorization": "conceptual",
  "partial understanding": "conceptual",
  "procedural only": "procedural",
  "trap vulnerability": "reading",
  carelessness: "careless",
};

/**
 * Evidence-only error profile. Each value is a count of real wrong-answer
 * records with a matching diagnostic/category—not a manufactured percentage.
 */
export function buildErrorPatternRadar(items: WrongAnswer[]): ErrorRadarDimension[] | null {
  const counts = new Map<ErrorRadarDimension["id"], number>([
    ["conceptual", 0], ["procedural", 0], ["computational", 0], ["reading", 0], ["careless", 0],
  ]);
  let evidence = 0;

  for (const item of items) {
    const rawCategory = String(item.error_category ?? item.error_detail?.category ?? "")
      .trim().toLowerCase().replace(/[_-]+/g, " ");
    const rawDiagnosis = String(item.diagnosis ?? item.error_detail?.diagnosis ?? "")
      .trim().toLowerCase().replace(/[_-]+/g, " ");
    const category = (["conceptual", "procedural", "computational", "reading", "careless"] as const)
      .find((value) => rawCategory === value);
    const diagnosis = RADAR_DIAGNOSIS_DIMENSION[rawDiagnosis];
    const dimension = category ?? diagnosis;
    if (!dimension) continue;
    counts.set(dimension, (counts.get(dimension) ?? 0) + 1);
    evidence += 1;
  }

  if (evidence < MIN_ERROR_RADAR_EVIDENCE) return null;
  return [...counts.entries()].map(([id, count]) => ({ id, count }));
}

export interface MasterySummary {
  avgMastery: number;
  avgRetrievability: number;
  urgent: number;
  warning: number;
  stale: number;
}

export interface ErrorTrendSummary {
  recent7d: number;
  previous7d: number;
  delta: number;
  direction: "up" | "down" | "flat";
}

export type QuizDifficulty = "easy" | "medium" | "hard";

export interface DifficultyRecommendation {
  level: QuizDifficulty;
  reasonKey: string;
}

export type NextLearningAction = "review" | "targeted_practice" | "practice";

/** One explicit recommendation prevents UI from independently guessing a CTA. */
export function getNextLearningAction(input: {
  urgentReviewCount: number;
  wrongAnswerCount: number;
  errorTrend: ErrorTrendSummary;
}): NextLearningAction {
  if (input.urgentReviewCount > 0) return "review";
  if (input.wrongAnswerCount > 0 || input.errorTrend.recent7d > 0) return "targeted_practice";
  return "practice";
}

function toDisplayLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.replace(/_/g, " ");
}

/** 诊断和错因分类是内部枚举，聚合前即转换为中文，避免任何展示路径漏出英文。 */
function toSignalDisplayLabel(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return getErrorSignalLabel(value);
}

function rankSignals(counter: Map<string, number>, limit = 5): RankedSignal[] {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

export function buildErrorPatternSummary(items: WrongAnswer[]): ErrorPatternSummary {
  const diagnosisCounter = new Map<string, number>();
  const categoryCounter = new Map<string, number>();
  const pointCounter = new Map<string, number>();

  for (const item of items) {
    const diagnosis = toSignalDisplayLabel(item.diagnosis ?? item.error_detail?.diagnosis);
    if (diagnosis) diagnosisCounter.set(diagnosis, (diagnosisCounter.get(diagnosis) ?? 0) + 1);

    const category = toSignalDisplayLabel(item.error_category ?? item.error_detail?.category);
    if (category) categoryCounter.set(category, (categoryCounter.get(category) ?? 0) + 1);

    for (const point of item.knowledge_points ?? []) {
      const label = toDisplayLabel(point);
      if (!label) continue;
      pointCounter.set(label, (pointCounter.get(label) ?? 0) + 1);
    }
  }

  return {
    diagnoses: rankSignals(diagnosisCounter),
    categories: rankSignals(categoryCounter),
    knowledgePoints: rankSignals(pointCounter),
  };
}

export function buildMasterySummary(items: ReviewItem[]): MasterySummary {
  if (items.length === 0) {
    return {
      avgMastery: 0,
      avgRetrievability: 0,
      urgent: 0,
      warning: 0,
      stale: 0,
    };
  }

  const now = Date.now();
  const avgMastery = Math.round(
    (items.reduce((sum, item) => sum + (item.mastery ?? 0), 0) / items.length) * 100,
  );
  const avgRetrievability = Math.round(
    (items.reduce((sum, item) => sum + (item.retrievability ?? 0), 0) / items.length) * 100,
  );
  const urgent = items.filter((item) => item.urgency === "urgent" || item.urgency === "overdue").length;
  const warning = items.filter((item) => item.urgency === "warning").length;
  const stale = items.filter((item) => {
    if (!item.last_reviewed) return true;
    const last = new Date(item.last_reviewed).getTime();
    if (Number.isNaN(last)) return true;
    return now - last > 14 * 24 * 60 * 60 * 1000;
  }).length;

  return { avgMastery, avgRetrievability, urgent, warning, stale };
}

export function buildErrorTrendSummary(items: WrongAnswer[]): ErrorTrendSummary {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let recent7d = 0;
  let previous7d = 0;

  for (const item of items) {
    if (!item.created_at) continue;
    const ts = new Date(item.created_at).getTime();
    if (Number.isNaN(ts)) continue;
    const ageMs = now - ts;
    if (ageMs < 0) continue;
    if (ageMs <= 7 * dayMs) recent7d += 1;
    else if (ageMs <= 14 * dayMs) previous7d += 1;
  }

  const delta = recent7d - previous7d;
  const direction: ErrorTrendSummary["direction"] =
    delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return { recent7d, previous7d, delta, direction };
}

export function recommendQuizDifficulty(
  mastery: MasterySummary,
  trend: ErrorTrendSummary,
  wrongCount: number,
): DifficultyRecommendation {
  if (mastery.avgMastery < 55 || mastery.urgent >= 3 || trend.delta >= 2 || wrongCount >= 8) {
    return { level: "easy", reasonKey: "unit.difficulty.reason.recovery" };
  }
  if (mastery.avgMastery < 80 || mastery.warning >= 2 || trend.delta > 0 || wrongCount >= 4) {
    return { level: "medium", reasonKey: "unit.difficulty.reason.balanced" };
  }
  return { level: "hard", reasonKey: "unit.difficulty.reason.challenge" };
}

export function modeHintFromDifficulty(level: QuizDifficulty): "course_following" | "self_paced" | "exam_prep" {
  if (level === "hard") return "exam_prep";
  if (level === "easy") return "course_following";
  return "self_paced";
}
