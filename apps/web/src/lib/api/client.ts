/**
 * Core API client for OpenTutor backend.
 *
 * Simple fetch-based client. Phase 1 may upgrade to tRPC or orpc.
 */

import { t } from "@/lib/i18n";
import { toUserFacingError } from "@/lib/display-mappers";
import { toast } from "sonner";
import { buildAuthHeaders } from "@/lib/auth";

// In the browser, always use relative "/api" so requests go through the
// Next.js rewrite (same origin, avoids CSP connect-src issues).
// On the server (SSR), use NEXT_PUBLIC_API_URL to reach the backend directly.
export const API_BASE =
  typeof window !== "undefined"
    ? "/api"
    : process.env.NEXT_PUBLIC_API_URL || "/api";

/** A successful mutation may change home tasks, progress or resume context.
 * Keeping this at the API boundary prevents every feature from inventing a
 * different cache-invalidation list. */
export const LEARNING_HOME_INVALIDATION_EVENT = "lumate:learning-state-changed";

function notifyLearningStateMutation(method: string): void {
  if (typeof window === "undefined" || method === "GET" || method === "HEAD") return;
  window.dispatchEvent(new Event(LEARNING_HOME_INVALIDATION_EVENT));
}

/**
 * Show a toast for API errors (non-chat requests).
 *
 * 后端 detail 常为英文技术文案，不应直接暴露给学生。这里统一转为中文友好
 * 提示；真实技术错误仅在控制台日志保留，便于排查。
 */
function showApiErrorToast(err: ApiError): void {
  if (typeof window === "undefined") return;
  // 保留技术细节到开发日志，不展示给用户。
  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.error("[api]", err.status, err.code ?? "", err.detail ?? err.message);
  }
  const description = toUserFacingError(err.status, t("ui.request_failed"));
  toast.error(t("ui.request_failed"), {
    id: err.status === 429 ? "api-rate-limit" : undefined,
    description,
    duration: 5000,
  });
}

export type JsonObject = Record<string, unknown>;
export type NullableDateTime = string | null;

export class ApiError extends Error {
  status: number;
  code?: string;
  /** 后端返回的原始 detail（可能为英文技术文案，仅用于日志）。 */
  detail?: string;

  constructor(message: string, options: { status: number; code?: string; detail?: string }) {
    // message 面向用户（中文），detail 保留原始技术信息。
    super(toUserFacingError(options.status, message));
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.detail = options.detail;
  }
}

export interface VersionedBatch {
  batch_id: string;
  version: number;
  replaced: boolean;
}

export interface SavedGeneratedAsset extends VersionedBatch {
  id: string;
}

export interface ContentMutationResult {
  nodes_created: number;
}

export interface GeneratedBatchSummaryBase {
  batch_id: string;
  title: string;
  current_version: number;
  is_active: boolean;
  updated_at: NullableDateTime;
}

export async function parseApiError(res: Response): Promise<ApiError> {
  const fallbackDetail = res.statusText || `API error: ${res.status}`;
  const payload = await res.json().catch(() => null) as
    | { detail?: string; message?: string; code?: string }
    | null;
  const detail = payload?.detail || payload?.message || fallbackDetail;

  return new ApiError(detail, {
    status: res.status,
    code: payload?.code,
    detail,
  });
}

const MAX_RETRIES = 4;
const RETRY_BASE_MS = 1500;
const REQUEST_TIMEOUT_MS = 30_000;

function isRetryable(status: number): boolean {
  // Retrying 429 responses multiplies a request burst and keeps the bucket
  // exhausted. Surface one deduplicated message and let the caller retry
  // after the server's Retry-After window instead.
  return status >= 500;
}

function retryDelay(attempt: number): number {
  return RETRY_BASE_MS * 2 ** attempt + Math.random() * 500;
}

function getCsrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return match?.[1];
}

function buildRequestHeaders(
  method: string,
  headers?: HeadersInit,
  includeJsonContentType: boolean = true,
): Headers {
  const csrfHeaders: Record<string, string> = {};
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      csrfHeaders["X-CSRF-Token"] = csrfToken;
    }
  }
  const merged = new Headers();
  if (includeJsonContentType) {
    merged.set("Content-Type", "application/json");
  }
  for (const [key, value] of Object.entries(csrfHeaders)) {
    merged.set(key, value);
  }
  if (headers) {
    const incoming = new Headers(headers);
    incoming.forEach((value, key) => merged.set(key, value));
  }
  return buildAuthHeaders(merged);
}

export interface SecureRequestOptions extends Omit<RequestInit, "headers"> {
  headers?: HeadersInit;
  includeJsonContentType?: boolean;
}

export function buildSecureHeaders(
  method: string,
  headers?: HeadersInit,
  includeJsonContentType: boolean = true,
): Headers {
  return buildRequestHeaders(method.toUpperCase(), headers, includeJsonContentType);
}

export function buildSecureRequestInit(options?: SecureRequestOptions): RequestInit {
  const {
    method = "GET",
    headers,
    includeJsonContentType = true,
    credentials = "include",
    ...rest
  } = options ?? {};
  const normalizedMethod = method.toUpperCase();
  return {
    ...rest,
    method: normalizedMethod,
    credentials,
    headers: buildSecureHeaders(normalizedMethod, headers, includeJsonContentType),
  };
}

function parseFilenameFromDisposition(contentDisposition: string | null): string | null {
  if (!contentDisposition) return null;
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const simpleMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
  return simpleMatch?.[1] ?? null;
}

export interface ApiRequestOptions extends RequestInit {
  /** Use for page-entry reads where a missing local API must fail fast instead
   * of leaving the screen in a misleading multi-retry loading state. */
  retry?: boolean;
  /** Background polling owns its inline error/recovery UI and must not create
   * a toast on every interval. Interactive requests should keep the default. */
  suppressErrorToast?: boolean;
}

export async function request<T>(path: string, options?: ApiRequestOptions): Promise<T> {
  const { retry = true, suppressErrorToast = false, ...requestOptions } = options ?? {};
  const fetchOptions = buildSecureRequestInit({
    ...requestOptions,
    includeJsonContentType: true,
  });

  let lastError: Error | undefined;

  const maxRetries = retry ? MAX_RETRIES : 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        ...fetchOptions,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const err = await parseApiError(res);
        if (attempt < maxRetries && isRetryable(res.status)) {
          lastError = err;
          await new Promise((r) => setTimeout(r, retryDelay(attempt)));
          continue;
        }
        if (!suppressErrorToast) showApiErrorToast(err);
        throw err;
      }

      if (res.status === 204) {
        notifyLearningStateMutation(fetchOptions.method || "GET");
        return undefined as T;
      }

      const text = await res.text();
      notifyLearningStateMutation(fetchOptions.method || "GET");
      return text ? (JSON.parse(text) as T) : (undefined as T);
    } catch (err) {
      clearTimeout(timeoutId);
      // Abort errors are retryable (request timed out)
      if (err instanceof DOMException && err.name === "AbortError" && attempt < MAX_RETRIES) {
        lastError = new TypeError(t("ui.request_timeout"));
        await new Promise((r) => setTimeout(r, retryDelay(attempt)));
        continue;
      }
      // Network errors (fetch throws TypeError for network failures).
      // Only retry genuine network errors, not JSON.parse or other TypeErrors.
      if (
        err instanceof TypeError &&
        attempt < maxRetries &&
        (err.message.includes("fetch") || err.message.includes("network") || err.message === t("ui.failed_to_fetch") || err.message.includes("NetworkError"))
      ) {
        lastError = err;
        await new Promise((r) => setTimeout(r, retryDelay(attempt)));
        continue;
      }
      throw err;
    }
  }

  throw lastError!;
}

export interface BinaryResponse {
  blob: Blob;
  fileName: string | null;
  contentType: string;
}

export async function requestBlob(path: string, options?: RequestInit): Promise<BinaryResponse> {
  const fetchOptions = buildSecureRequestInit({
    ...(options ?? {}),
    includeJsonContentType: false,
  });

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        ...fetchOptions,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const err = await parseApiError(res);
        if (attempt < MAX_RETRIES && isRetryable(res.status)) {
          lastError = err;
          await new Promise((r) => setTimeout(r, retryDelay(attempt)));
          continue;
        }
        showApiErrorToast(err);
        throw err;
      }

      const blob = await res.blob();
      const fileName = parseFilenameFromDisposition(res.headers.get("Content-Disposition"));
      return {
        blob,
        fileName,
        contentType: res.headers.get("Content-Type") || "application/octet-stream",
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof DOMException && err.name === "AbortError" && attempt < MAX_RETRIES) {
        lastError = new TypeError(t("ui.request_timeout"));
        await new Promise((r) => setTimeout(r, retryDelay(attempt)));
        continue;
      }
      if (err instanceof TypeError && attempt < MAX_RETRIES) {
        lastError = err;
        await new Promise((r) => setTimeout(r, retryDelay(attempt)));
        continue;
      }
      throw err;
    }
  }

  throw lastError!;
}
