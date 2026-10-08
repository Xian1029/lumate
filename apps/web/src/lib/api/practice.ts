import { request } from "./client";
import { getLocale } from "@/lib/i18n";

import type { GeneratedBatchSummaryBase, JsonObject, SavedGeneratedAsset } from "./client";

// ── Wrong Answers ──

interface WrongAnswerDetail {
  category?: string;
  confidence?: number;
  evidence?: string;
  related_concept?: string;
  diagnosis?: string;
  original_correct?: boolean;
  clean_correct?: boolean;
  diagnostic_problem_id?: string;
}

interface RetryWrongAnswerResult {
  is_correct: boolean;
  correct_answer: string | null;
  user_answer: string | null;
  explanation: string | null;
}

export interface DerivedQuestionResult {
  problem_id: string;
  original_problem_id?: string;
  question: string;
  question_type: string;
  options: Record<string, string> | null;
  correct_answer: string | null;
  explanation: string | null;
  is_diagnostic?: boolean;
  simplifications_made?: string[];
  core_concept_preserved?: string;
}

interface WrongAnswerDiagnosisResult {
  diagnosis?: string;
  original_correct?: boolean;
  clean_correct?: boolean | null;
  interpretation?: string;
  status?: string;
  diagnostic_problem_id?: string;
  message?: string;
}

export interface WrongAnswerStats {
  total: number;
  mastered: number;
  unmastered: number;
  by_category: Record<string, number>;
  by_diagnosis: Record<string, number>;
}

export interface WrongAnswer {
  id: string;
  problem_id: string;
  /** Stable source lesson of the original question, when recorded. */
  content_node_id: string | null;
  question: string | null;
  question_type: string | null;
  options: Record<string, string> | null;
  user_answer: string;
  correct_answer: string | null;
  explanation: string | null;
  error_category: string | null;
  diagnosis: string | null;
  error_detail: WrongAnswerDetail | null;
  knowledge_points: string[] | null;
  /** Number of confirmed incorrect submissions for this same question. */
  wrong_attempt_count: number;
  review_count: number;
  mastered: boolean;
  created_at?: string | null;
}

export async function listWrongAnswers(
  courseId: string,
  params?: { mastered?: boolean; error_category?: string; content_node_id?: string },
): Promise<WrongAnswer[]> {
  const search = new URLSearchParams();
  if (params?.mastered !== undefined) search.set("mastered", String(params.mastered));
  if (params?.error_category) search.set("error_category", params.error_category);
  if (params?.content_node_id) search.set("content_node_id", params.content_node_id);
  const qs = search.toString();
  return request(`/wrong-answers/${courseId}${qs ? `?${qs}` : ""}`);
}

export async function retryWrongAnswer(id: string, userAnswer: string) {
  return request<RetryWrongAnswerResult>(
    `/wrong-answers/${id}/retry`,
    { method: "POST", body: JSON.stringify({ user_answer: userAnswer }) },
  );
}

export async function deriveQuestion(
  id: string,
  options?: { forceNew?: boolean; asPractice?: boolean },
) {
  const search = new URLSearchParams();
  if (options?.forceNew) search.set("force_new", "true");
  if (options?.asPractice) search.set("as_practice", "true");
  const query = search.toString();
  return request<DerivedQuestionResult>(
    `/wrong-answers/${id}/derive${query ? `?${query}` : ""}`,
    { method: "POST" },
  );
}

export async function diagnoseWrongAnswer(id: string): Promise<WrongAnswerDiagnosisResult> {
  return request(`/wrong-answers/${id}/diagnose`, {
    method: "POST",
  });
}

export async function getWrongAnswerStats(courseId: string): Promise<WrongAnswerStats> {
  return request(`/wrong-answers/${courseId}/stats`);
}

// ── Quiz ──

export interface QuizProblem {
  id: string;
  question_type: string;
  question: string;
  options: Record<string, string> | null;
  order_index: number;
  content_node_id?: string | null;
  difficulty_layer?: number | null;
  problem_metadata?: Record<string, unknown> | null;
  answer_ready?: boolean;
  explanation_ready?: boolean;
  /**
   * If the learner has already submitted this problem, the server returns
   * these fields so the learner can review them without a separate API call.
   * Otherwise they are null (anti-spoiler behaviour before submission).
   */
  correct_answer?: string | null;
  explanation?: string | null;
  /** Server-authoritative: this user has submitted this question. */
  is_answered?: boolean;
  /** The learner-visible exercise set that created this question. */
  source_batch_id?: string | null;
}

export interface GeneratedQuizBatchSummary {
  batch_id: GeneratedBatchSummaryBase["batch_id"];
  title: GeneratedBatchSummaryBase["title"];
  current_version: GeneratedBatchSummaryBase["current_version"];
  problem_count: number;
  is_active: GeneratedBatchSummaryBase["is_active"];
  updated_at: GeneratedBatchSummaryBase["updated_at"];
}

export interface GeneratedAssetBatchSummary extends GeneratedBatchSummaryBase {
  asset_count: number;
  preview: JsonObject;
  metadata?: JsonObject;
}

export interface PrerequisiteGap {
  concept: string;
  concept_id: string;
  mastery: number;
  gap_severity: number;
}

export interface BlankResult {
  index: number;
  student: string;
  expected: string;
  match_type: string;
  is_correct: boolean;
  confidence: number;
  reason: string;
  semantic_used: boolean;
}

export interface AnswerResult {
  is_correct: boolean;
  correct_answer: string | null;
  user_answer: string | null;
  explanation: string | null;
  prerequisite_gaps?: PrerequisiteGap[] | null;
  warnings?: string[];
  /** Unified grading (answer-grader-v2+) */
  match_type?: string | null;
  score?: number | null;
  needs_review?: boolean;
  per_blank_results?: BlankResult[] | null;
  grader_version?: string | null;
  /** Human-readable grading feedback, e.g. preferred phrasing for semantic matches. */
  feedback?: string | null;
}

export interface QuizNodeFailure {
  node_id?: string | null;
  title: string;
  reason: string;
  discarded_count: number;
  errors: string[];
}

export interface ExtractQuizResult {
  status: string;
  problems_created: number;
  validated_count: number;
  repaired_count: number;
  discarded_count: number;
  node_failures: QuizNodeFailure[];
  warnings: string[];
  problem_ids?: string[];
  batch_id?: string | null;
}

export interface SavedGeneratedQuizBatch {
  saved: number;
  problem_ids: string[];
  batch_id: string;
  version: number;
  replaced: boolean;
  discarded_count?: number;
  warnings?: string[];
}

export async function extractQuiz(
  courseId: string,
  contentNodeId?: string,
  mode?: string,
  difficulty?: "easy" | "medium" | "hard",
  avoidExisting = false,
): Promise<ExtractQuizResult> {
  return request("/quiz/extract", {
    method: "POST",
    body: JSON.stringify({
      course_id: courseId,
      content_node_id: contentNodeId,
      mode,
      difficulty,
      language: getLocale(),
      avoid_existing: avoidExisting,
    }),
  });
}

export async function listProblems(courseId: string, contentNodeId?: string): Promise<QuizProblem[]> {
  const query = contentNodeId ? `?content_node_id=${encodeURIComponent(contentNodeId)}` : "";
  return request(`/quiz/${courseId}${query}`);
}

export interface MasterySnapshot {
  mastery_score: number;
  gap_type: string | null;
  content_node_id: string | null;
  recorded_at: string;
}

export async function getMasteryHistory(
  courseId: string,
  contentNodeId?: string,
  limit = 50,
): Promise<MasterySnapshot[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (contentNodeId) query.set("content_node_id", contentNodeId);
  return request(`/quiz/${courseId}/mastery-history?${query.toString()}`);
}

export async function listGeneratedQuizBatches(courseId: string): Promise<GeneratedQuizBatchSummary[]> {
  return request(`/quiz/${courseId}/generated-batches`);
}

export async function saveGeneratedQuiz(
  courseId: string,
  rawContent: string,
  title?: string,
  replaceBatchId?: string,
): Promise<SavedGeneratedQuizBatch> {
  return request("/quiz/save-generated", {
    method: "POST",
    body: JSON.stringify({
      course_id: courseId,
      raw_content: rawContent,
      title,
      replace_batch_id: replaceBatchId,
    }),
  });
}

/**
 * Normalize a /quiz/submit response so the result always matches `AnswerResult`.
 *
 * The backend returns snake_case keys (correct_answer / user_answer / explanation /
 * prerequisite_gaps / is_correct / warnings) but intermediate response layers or
 * legacy code paths may convert some payloads to camelCase. We accept both shapes
 * so callers can reliably rely on the snake_case contract declared by AnswerResult.
 */
function _normalizeAnswerResult(raw: Record<string, unknown>): AnswerResult {
  const pick = (snake: string, camel: string) => {
    const v = raw[snake] !== undefined ? raw[snake] : raw[camel];
    return v;
  };
  return {
    is_correct: Boolean(pick("is_correct", "isCorrect")),
    correct_answer: (pick("correct_answer", "correctAnswer") as string | null | undefined) ?? null,
    user_answer: (pick("user_answer", "userAnswer") as string | null | undefined) ?? null,
    explanation: (pick("explanation", "explanation") as string | null | undefined) ?? null,
    prerequisite_gaps: pick("prerequisite_gaps", "prerequisiteGaps") as
      | AnswerResult["prerequisite_gaps"]
      | undefined,
    warnings: pick("warnings", "warnings") as string[] | undefined,
    match_type: (pick("match_type", "matchType") as string | null | undefined) ?? null,
    score: (pick("score", "score") as number | null | undefined) ?? null,
    needs_review: Boolean(pick("needs_review", "needsReview")),
    per_blank_results: pick("per_blank_results", "perBlankResults") as
      | AnswerResult["per_blank_results"]
      | undefined,
    grader_version: (pick("grader_version", "graderVersion") as string | null | undefined) ?? null,
    feedback: (pick("feedback", "feedback") as string | null | undefined) ?? null,
  };
}

export async function submitAnswer(problemId: string, answer: string, answerTimeMs?: number): Promise<AnswerResult> {
  const raw = await request<Record<string, unknown>>("/quiz/submit", {
    method: "POST",
    body: JSON.stringify({ problem_id: problemId, user_answer: answer, answer_time_ms: answerTimeMs }),
  });
  const normalized = _normalizeAnswerResult(raw ?? {});
  // Safety net: if the normalized payload is still missing correct_answer or
  // explanation (for example due to a middleware JSON transform stripping keys),
  // log it in development so maintainers can spot regressions.
  if (process.env.NODE_ENV !== "production") {
    const missing: string[] = [];
    if (!normalized.correct_answer) missing.push("correct_answer");
    if (!normalized.explanation) missing.push("explanation");
    if (missing.length > 0) {
      console.warn(
        "[OpenTutor Quiz submitAnswer] normalized response is missing keys:",
        missing,
        "raw payload keys:",
        Object.keys(raw ?? {}),
      );
    }
  }
  return normalized;
}

// ── Flashcards ──

interface FlashcardFsrsState {
  difficulty: number;
  stability: number;
  reps: number;
  lapses: number;
  state: string;
  due: string | null;
  last_review?: string | null;
}

interface FlashcardReviewResult {
  card: Flashcard;
  next_review: string | null;
}

export interface DueFlashcardsResult {
  cards: Flashcard[];
  due_count: number;
  total_batches: number;
}

export interface Flashcard {
  id: string;
  front: string;
  back: string;
  difficulty: string;
  fsrs: FlashcardFsrsState;
  course_id?: string;
  content_node_id?: string | null;
  batch_id?: string;
  card_index?: number;
  knowledge_points?: string[];
  concept?: string;
}

export async function generateFlashcards(
  courseId: string,
  count: number = 5,
  mode?: string,
  excludeFronts?: string[],
  contentNodeId?: string,
): Promise<{ cards: Flashcard[]; count: number }> {
  return request("/flashcards/generate", {
    method: "POST",
    body: JSON.stringify({
      course_id: courseId,
      content_node_id: contentNodeId,
      count,
      mode,
      language: getLocale(),
      exclude_fronts: excludeFronts?.slice(0, 30) ?? [],
    }),
  });
}

export async function saveGeneratedFlashcards(
  courseId: string,
  cards: Flashcard[],
  title?: string,
  replaceBatchId?: string,
): Promise<SavedGeneratedAsset> {
  return request("/flashcards/generated/save", {
    method: "POST",
    body: JSON.stringify({
      course_id: courseId,
      cards,
      title,
      replace_batch_id: replaceBatchId,
    }),
  });
}

export async function listGeneratedFlashcardBatches(courseId: string): Promise<GeneratedAssetBatchSummary[]> {
  return request(`/flashcards/generated/${courseId}`);
}

export async function reviewFlashcard(
  card: Flashcard,
  rating: number,
): Promise<FlashcardReviewResult> {
  return request("/flashcards/review", {
    method: "POST",
    body: JSON.stringify({
      card,
      rating,
      batch_id: card.batch_id,
      card_index: card.card_index,
    }),
  });
}

export async function getDueFlashcards(
  courseId: string,
): Promise<DueFlashcardsResult> {
  return request(`/flashcards/due/${courseId}`);
}

export interface LectorFlashcard extends Flashcard {
  card_index?: number;
  lector_priority?: number;
  lector_reason?: string;
}

export interface LectorOrderResult {
  cards: LectorFlashcard[];
  count: number;
  lector_concepts: number;
}

export async function getLectorOrderedFlashcards(
  courseId: string,
): Promise<LectorOrderResult> {
  return request(`/flashcards/lector-order/${courseId}`);
}

// ── Confusion Pairs ──

export interface ConfusionPair {
  concept_a: string;
  concept_b: string;
  weight: number;
  description_a?: string | null;
  description_b?: string | null;
}

export interface ConfusionPairsResult {
  pairs: ConfusionPair[];
  count: number;
}

export async function getConfusionPairs(courseId: string): Promise<ConfusionPairsResult> {
  return request(`/flashcards/confusion-pairs/${courseId}`);
}

// ── Wrong Answer Review ──

interface WrongAnswerReviewResult {
  review: string;
  wrong_answer_count: number;
  wrong_answer_ids: string[];
}

export async function getWrongAnswerReview(courseId: string): Promise<WrongAnswerReviewResult> {
  const search = new URLSearchParams({ course_id: courseId, language: getLocale() });
  return request(`/workflows/wrong-answer-review?${search.toString()}`);
}
