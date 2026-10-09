import { API_BASE, request } from "./client";

import type { NullableDateTime } from "./client";

// ── Ingestion Jobs ──

export interface IngestionPageStats {
  total: number;
  parsed: number;
  failed_pages: number[];
  unit: "pages" | "paragraphs" | "slides" | "sheets";
  outline_integrity?: {
    checked: boolean;
    no_outline?: boolean;
    handling?: "generated_sections_from_body";
    reason?: string;
    expected_sections?: number;
    parsed_sections?: number;
    coverage?: number;
    missing_sections?: string[];
    title_mismatches?: string[];
    duplicate_sections?: string[];
    order_mismatch?: boolean;
  };
}

export interface IngestionJobSummary {
  id: string;
  course_id?: string | null;
  filename: string;
  source_type: string;
  category: string | null;
  status: string;
  processing_attempt_id?: string;
  workflow_state?: ProcessingWorkflowState;
  failure_code?: string | null;
  is_current_attempt?: boolean;
  phase_label: string | null;
  progress_percent: number;
  nodes_created: number;
  embedding_status: "pending" | "running" | "completed" | "failed";
  error_message: string | null;
  page_stats?: IngestionPageStats | null;
  dispatched_to: Record<string, number> | null;
  created_at: NullableDateTime;
  updated_at: NullableDateTime;
}

export type ProcessingWorkflowState =
  | "UPLOADED" | "CLASSIFYING" | "NEEDS_CLASSIFICATION_CONFIRMATION"
  | "CLASSIFIED" | "DETECTING_STRUCTURE" | "PARSING" | "PARTIALLY_READY"
  | "READY" | "FAILED_RETRYABLE" | "FAILED_FINAL" | "CANCELLED";

export async function listIngestionJobs(courseId: string): Promise<IngestionJobSummary[]> {
  // This endpoint is polled. The caller renders a single recoverable state;
  // global request toasts here would otherwise fire forever after an attempt
  // is cancelled or replaced.
  return request(`/content/jobs/${courseId}`, {
    retry: false,
    suppressErrorToast: true,
  });
}

/**
 * Processing-center source.
 * Successful rows are returned only for published learning spaces; unfinished
 * provisional attempts remain visible solely while they can still recover.
 */
export interface GlobalIngestionJob extends IngestionJobSummary {
  course_id: string | null;
}

export async function listAllIngestionJobs(limit = 50): Promise<GlobalIngestionJob[]> {
  return request(`/content/jobs?limit=${limit}`);
}

export async function retryIngestionJob(jobId: string): Promise<GlobalIngestionJob> {
  return request(`/content/jobs/${jobId}/retry`, { method: "POST" });
}

/** Deletes failed processing history only; completed course materials remain intact. */
export async function clearFailedIngestionJobs(): Promise<{ deleted_count: number }> {
  return request("/content/jobs/failed", { method: "DELETE" });
}

// ── Multi-file upload planning (multi-subject split) ──

export interface UploadFileAnalysis {
  filename: string;
  subject: string | null;
  grade: string | null;
  publisher: string | null;
  volume: string | null;
  material_type: string | null;
  confidence: "high" | "medium" | "low";
}

export interface UploadPlanGroup {
  key: string;
  subject: string | null;
  grade: string | null;
  publisher: string | null;
  volume: string | null;
  suggested_name: string;
  files: UploadFileAnalysis[];
}

export interface UploadPlan {
  groups: UploadPlanGroup[];
  unclassified: UploadFileAnalysis[];
}

export async function planUploadSpaces(filenames: string[]): Promise<UploadPlan> {
  return request("/content/spaces/plan", {
    method: "POST",
    body: JSON.stringify({ files: filenames }),
  });
}

export interface UploadedCourseFile {
  id: string;
  job_id: string;
  filename: string | null;
  file_name: string | null;
  mime_type: string | null;
  created_at: NullableDateTime;
}

/** Files are opened through the API so the original PDF layout stays intact. */
export async function listCourseFiles(courseId: string): Promise<UploadedCourseFile[]> {
  return request(`/content/files/by-course/${courseId}`);
}

// ── Scrape Sources ──

export interface ScrapeSource {
  id: string;
  url: string;
  label: string | null;
  course_id: string;
  source_type: string;
  requires_auth: boolean;
  auth_domain: string | null;
  session_name: string | null;
  enabled: boolean;
  interval_hours: number;
  last_scraped_at: string | null;
  last_status: string | null;
  last_content_hash: string | null;
  consecutive_failures: number;
  created_at: string;
}

// ── Course Sync ──

export interface SyncResult {
  status: string;
  new_files: number;
  updated_files: number;
  unchanged_files: number;
  files_discovered: number;
  job_id: string;
  job_status: string;
  nodes_created: number;
  content_changed: boolean;
}

export async function syncCourse(courseId: string): Promise<SyncResult> {
  return request(`/courses/${courseId}/sync`, { method: "POST" });
}

// ── Scrape Sources ──

export async function createScrapeSource(body: {
  course_id: string;
  url: string;
  label?: string;
  source_type?: "generic" | "canvas";
  requires_auth?: boolean;
  auth_domain?: string;
  session_name?: string;
  interval_hours?: number;
}): Promise<ScrapeSource> {
  return request("/scrape/sources", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function listScrapeSources(courseId: string): Promise<ScrapeSource[]> {
  return request(`/scrape/sources?course_id=${courseId}`);
}

export async function updateScrapeSource(
  sourceId: string,
  body: { enabled?: boolean; interval_hours?: number; label?: string },
): Promise<ScrapeSource> {
  return request(`/scrape/sources/${sourceId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deleteScrapeSource(sourceId: string): Promise<void> {
  return request(`/scrape/sources/${sourceId}`, { method: "DELETE" });
}

export async function scrapeNow(sourceId: string): Promise<{ status: string; content_changed: boolean; last_status: string }> {
  // Full browser-based scrape can take well over 30s for large Canvas courses.
  // Use a dedicated 120s timeout and bypass apiClient auto-retry (each retry
  // would trigger a redundant full scrape).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${API_BASE}/scrape/sources/${sourceId}/scrape-now`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      credentials: "include",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { message?: string; detail?: string };
      throw new Error(body.message ?? body.detail ?? `Scrape failed (${res.status})`);
    }
    return res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}
