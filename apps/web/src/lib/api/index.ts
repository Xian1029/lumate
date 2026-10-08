/**
 * Barrel re-export for the modular API layer.
 *
 * Every public type and function that was previously exported from
 * the monolithic api.ts is re-exported here so that all existing
 * `import { ... } from "@/lib/api"` statements continue to work.
 */

export type { JsonObject, NullableDateTime } from "./client";

export { listLearningPlans, createLearningPlan, getLearningPlan, deleteLearningPlan, listLearningPlanTasks, createLearningTask, updateLearningPlan, planAction, startLearningPlan, regenerateLearningPlan, getLearningPlanDashboard, getLearningHomeOverview, getCourseLearningPlanDashboard, taskAction, postponeLearningTask, planStatusLabel, taskStatusLabel, taskTypeLabel } from "./learning-plans";
export type { LearningPlan, LearningTask, StartLearningPlanResult, HomeLearningTask, LearningPlanSummary, LearningPlanDashboard, LearningHomeOverview, HomeLearningAction, HomeLearningSpace, HomeProcessingUpload, HomeReviewItem, WorkspaceLearningProgress, LearningPlanStatus, LearningTaskStatus, LearningTaskType } from "./learning-plans";

export {
  listCourseOverview,
  getHealthStatus,
  createCourse,
  activateCourse,
  cancelSetupCourse,
  updateCourse,
  deleteCourse,
  getContentTree,
  restructureNotes,
  saveGeneratedNotes,
  listGeneratedNoteBatches,
  getAiNoteForNode,
  listPersonalNotes,
  createPersonalNote,
  updatePersonalNote,
  deletePersonalNote,
  uploadFile,
  scrapeUrl,
  listAuthSessions,
  canvasBrowserLogin,
  fetchCanvasCourseInfo,
  updateCourseLayout,
} from "./courses";

export type {
  CourseWorkspaceFeatures,
  CourseAutoScrapeSettings,
  CourseMetadata,
  Course,
  CourseOverviewCard,
  HealthStatus,
  ContentNode,
  RestructuredNotes,
  AuthSessionSummary,
  AiNoteForNode,
  PersonalNote,
  PersonalNoteStyle,
} from "./courses";

export {
  streamChat,
  listChatSessions,
  getChatSessionMessages,
  deleteChatSession,
  getChatGreeting,
} from "./chat";

export type {
  ChatAction,
  ChatHistoryMessage,
  ChatSessionSummary,
  ChatProvenance,
  ChatMessageMetadata,
  ClarifyOption,
  PlanProgressEvent,
  ImageAttachment,
  BlockUpdateOp,
  CognitiveState,
} from "./chat";

export {
  listWrongAnswers,
  retryWrongAnswer,
  deriveQuestion,
  diagnoseWrongAnswer,
  getWrongAnswerStats,
  extractQuiz,
  getMasteryHistory,
  listProblems,
  listGeneratedQuizBatches,
  saveGeneratedQuiz,
  submitAnswer,
  generateFlashcards,
  saveGeneratedFlashcards,
  listGeneratedFlashcardBatches,
  reviewFlashcard,
  getDueFlashcards,
  getLectorOrderedFlashcards,
  getWrongAnswerReview,
  getConfusionPairs,
} from "./practice";

export type {
  DerivedQuestionResult,
  WrongAnswerStats,
  WrongAnswer,
  QuizProblem,
  GeneratedQuizBatchSummary,
  SavedGeneratedQuizBatch,
  ExtractQuizResult,
  MasterySnapshot,
  QuizNodeFailure,
  GeneratedAssetBatchSummary,
  AnswerResult,
  PrerequisiteGap,
  DueFlashcardsResult,
  Flashcard,
  LectorFlashcard,
  LectorOrderResult,
  ConfusionPair,
  ConfusionPairsResult,
} from "./practice";

export {
  getCourseProgress,
  getLearningOverview,
  getGlobalTrends,
  getMemoryStats,
  triggerConsolidation,
  getKnowledgeGraph,
  getExamPrepPlan,
  saveStudyPlan,
  listStudyPlanBatches,
  getStudyPlans,
  listAgentTasks,
  submitAgentTask,
  approveAgentTask,
  rejectAgentTask,
  listStudyGoals,
  createStudyGoal,
  updateStudyGoal,
  getNextAction,
  getNextLearningAction,
  listTemplates,
  applyTemplate,
  getForgettingForecast,
  getMisconceptionDashboard,
  getReviewSession,
  submitReviewRating,
  listAgendaRuns,
  logAgentDecision,
  getVelocity,
  getCompletionForecast,
  getTransferOpportunities,
  getWeeklyReport,
} from "./progress";

export type {
  CourseProgress,
  WeeklyReport,
  MisconceptionItem,
  MisconceptionDashboard,
  LearningOverview,
  LearningTrends,
  MemoryStats,
  ForgettingPrediction,
  ForgettingForecast,
  KnowledgeGraphNode,
  KnowledgeGraphEdge,
  ReviewItem,
  ReviewSession,
  AgentTask,
  AgentTaskStepResult,
  AgentTaskReview,
  AgentTaskVerifierDiagnostics,
  LearningTemplate,
  TemplateApplyResult,
  NextActionResponse,
  NextLearningAction,
  StudyGoal,
  CreateGoalRequest,
  UpdateGoalRequest,
  AgendaRun,
  AgendaDecisionLogRequest,
  StudyPlanResponse,
  VelocityResult,
  CompletionForecast,
  TransferOpportunity,
} from "./progress";

export {
  getLearningProfile,
  setPreference,
  getLlmRuntimeConfig,
  updateLlmRuntimeConfig,
  testLlmRuntimeConnection,
  getOllamaModels,
  listPreferenceSignals,
  dismissPreference,
  restorePreference,
  dismissSignal,
  restoreSignal,
  dismissMemory,
  restoreMemory,
} from "./preferences";

export type {
  Preference,
  MemoryProfileItem,
  LearningProfile,
  LlmRuntimeConfig,
  LlmConnectionTestResult,
  OllamaModel,
  PreferenceSignal,
} from "./preferences";

export {
  getUsageSummary,
  downloadExportSession,
  getAnkiExportUrl,
  getCalendarExportUrl,
} from "./usage";

export type {
  UsageSummary,
} from "./usage";

export {
  listIngestionJobs,
  listAllIngestionJobs,
  retryIngestionJob,
  clearFailedIngestionJobs,
  planUploadSpaces,
  listCourseFiles,
  syncCourse,
  createScrapeSource,
  listScrapeSources,
  updateScrapeSource,
  deleteScrapeSource,
  scrapeNow,
} from "./ingestion";

export type {
  IngestionJobSummary,
  GlobalIngestionJob,
  IngestionPageStats,
  ProcessingWorkflowState,
  UploadFileAnalysis,
  UploadPlanGroup,
  UploadPlan,
  UploadedCourseFile,
  SyncResult,
  ScrapeSource,
} from "./ingestion";

export {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  markTaskNotificationsRead,
} from "./notifications";

export type {
  AppNotification,
  NotificationsResponse,
} from "./notifications";

export { getFeatureFlags } from "./features";
export type { FeatureFlags } from "./features";

export { interviewTurn, getDemoCourse } from "./onboarding";
export type {
  OnboardingRequest,
  OnboardingResponse,
  OnboardingAction,
  SpaceLayoutResponse,
  DemoCourseResponse,
} from "./onboarding";
