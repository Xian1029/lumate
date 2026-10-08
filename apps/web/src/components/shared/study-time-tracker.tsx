"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { API_BASE, buildSecureRequestInit } from "@/lib/api/client";

type StudyActivity = "reading" | "notes" | "practice" | "review" | "graph";

interface StudyContext {
  courseId: string;
  contentNodeId: string | null;
  activity: StudyActivity;
  targetModule: "CONTENT" | "NOTE" | "PRACTICE" | "REVIEW" | "GRAPH";
}

interface PendingHeartbeat {
  heartbeat_id: string;
  client_session_id: string;
  course_id: string;
  content_node_id: string | null;
  target_module: StudyContext["targetModule"];
  active_seconds: number;
  elapsed_seconds: number;
  last_activity_at: string;
  activity_breakdown: Partial<Record<StudyActivity, number>>;
  ended: boolean;
}

const TICK_MS = 15_000;
const FLUSH_MS = 60_000;
const IDLE_MS = 90_000;
const LEASE_MS = 25_000;
const SESSION_GAP_MS = 10 * 60_000;
const QUEUE_KEY = "opentutor:pending-study-time";

function parseStudyContext(pathname: string, query: string): StudyContext | null {
  const match = pathname.match(/^\/course\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  const [, courseId, tail = ""] = match;
  if (tail === "profile" || tail === "plan") return null;

  const nodeMatch = tail.match(/^unit\/([^/]+)/);
  const params = new URLSearchParams(query);
  const activity: StudyActivity = tail.startsWith("notes")
    ? "notes"
    : tail.startsWith("review")
      ? "review"
      : tail.startsWith("practice") || tail.startsWith("wrong-answers")
        ? "practice"
        : tail.startsWith("graph")
          ? "graph"
          : "reading";
  const targetModule = activity === "notes" ? "NOTE"
    : activity === "practice" ? "PRACTICE"
      : activity === "review" ? "REVIEW"
        : activity === "graph" ? "GRAPH" : "CONTENT";
  return {
    courseId,
    contentNodeId: nodeMatch?.[1] ?? params.get("node"),
    activity,
    targetModule,
  };
}

function readPending(): PendingHeartbeat[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.slice(-50) : [];
  } catch {
    return [];
  }
}

function queuePending(payload: PendingHeartbeat): void {
  try {
    const pending = readPending();
    if (!pending.some((item) => item.heartbeat_id === payload.heartbeat_id)) pending.push(payload);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(pending.slice(-50)));
  } catch {
    // Tracking must never interrupt learning when storage is unavailable.
  }
}

async function postHeartbeat(payload: PendingHeartbeat): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/progress/study-sessions/heartbeat`, {
      ...buildSecureRequestInit({
        method: "POST",
        includeJsonContentType: true,
        keepalive: true,
        body: JSON.stringify(payload),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function drainPending(): Promise<void> {
  const pending = readPending();
  if (pending.length === 0) return;
  const remaining: PendingHeartbeat[] = [];
  for (const payload of pending) {
    if (!(await postHeartbeat(payload))) remaining.push(payload);
  }
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  } catch {
    // Best effort.
  }
}

function getSessionId(context: StudyContext): string {
  const key = `opentutor:study-session:${context.courseId}:${context.contentNodeId ?? "course"}`;
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) || "null") as
      | { id?: string; lastSeen?: number }
      | null;
    if (stored?.id && stored.lastSeen && Date.now() - stored.lastSeen < SESSION_GAP_MS) {
      sessionStorage.setItem(key, JSON.stringify({ id: stored.id, lastSeen: Date.now() }));
      return stored.id;
    }
    const id = crypto.randomUUID();
    sessionStorage.setItem(key, JSON.stringify({ id, lastSeen: Date.now() }));
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/** Records focused learning time without counting idle or background tabs. */
export function StudyTimeTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const context = useMemo(() => parseStudyContext(pathname, query), [pathname, query]);
  const tabId = useRef<string>(crypto.randomUUID());
  const lastActivityAt = useRef(0);
  const lastTickAt = useRef(0);
  const activeSeconds = useRef(0);
  const elapsedSeconds = useRef(0);
  const breakdown = useRef<Partial<Record<StudyActivity, number>>>({});
  const clientSessionId = useRef<string | null>(null);

  const ownsLease = useCallback(() => {
    if (!context) return false;
    const key = `opentutor:study-owner:${context.courseId}`;
    const now = Date.now();
    try {
      const current = JSON.parse(localStorage.getItem(key) || "null") as
        | { tabId?: string; expiresAt?: number }
        | null;
      if (current?.tabId !== tabId.current && (current?.expiresAt ?? 0) > now) return false;
      localStorage.setItem(key, JSON.stringify({ tabId: tabId.current, expiresAt: now + LEASE_MS }));
      const verified = JSON.parse(localStorage.getItem(key) || "null") as { tabId?: string } | null;
      return verified?.tabId === tabId.current;
    } catch {
      return true;
    }
  }, [context]);

  const releaseLease = useCallback(() => {
    if (!context) return;
    const key = `opentutor:study-owner:${context.courseId}`;
    try {
      const current = JSON.parse(localStorage.getItem(key) || "null") as { tabId?: string } | null;
      if (current?.tabId === tabId.current) localStorage.removeItem(key);
    } catch {
      // Best effort.
    }
  }, [context]);

  const flush = useCallback(async (ended = false) => {
    if (!context || !clientSessionId.current) return;
    const active = activeSeconds.current;
    const elapsed = elapsedSeconds.current;
    if (elapsed <= 0) return;

    const payload: PendingHeartbeat = {
      heartbeat_id: crypto.randomUUID(),
      client_session_id: clientSessionId.current,
      course_id: context.courseId,
      content_node_id: context.contentNodeId,
      target_module: context.targetModule,
      active_seconds: Math.min(active, elapsed, 120),
      elapsed_seconds: Math.min(elapsed, 300),
      last_activity_at: new Date(lastActivityAt.current).toISOString(),
      activity_breakdown: { ...breakdown.current },
      ended,
    };
    activeSeconds.current = 0;
    elapsedSeconds.current = 0;
    breakdown.current = {};
    if (!(await postHeartbeat(payload))) queuePending(payload);
  }, [context]);

  useEffect(() => {
    if (!context) return;
    clientSessionId.current = getSessionId(context);
    lastActivityAt.current = Date.now();
    lastTickAt.current = Date.now();
    void drainPending();

    const markActivity = () => {
      if (!document.hidden && document.hasFocus()) lastActivityAt.current = Date.now();
    };
    const tick = () => {
      const now = Date.now();
      const seconds = Math.max(0, Math.min(20, Math.round((now - lastTickAt.current) / 1000)));
      lastTickAt.current = now;
      if (document.hidden || !document.hasFocus() || !ownsLease()) return;
      elapsedSeconds.current += seconds;
      if (now - lastActivityAt.current <= IDLE_MS) {
        activeSeconds.current += seconds;
        breakdown.current[context.activity] = (breakdown.current[context.activity] ?? 0) + seconds;
      }
    };
    const handleVisibility = () => {
      lastTickAt.current = Date.now();
      if (document.hidden) {
        releaseLease();
        void flush(false);
      }
      else markActivity();
    };
    const handlePageHide = () => void flush(true);

    window.addEventListener("pointerdown", markActivity, { passive: true });
    window.addEventListener("keydown", markActivity);
    window.addEventListener("scroll", markActivity, { passive: true });
    window.addEventListener("input", markActivity);
    window.addEventListener("focus", markActivity);
    window.addEventListener("online", drainPending);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);
    const tickTimer = window.setInterval(tick, TICK_MS);
    const flushTimer = window.setInterval(() => void flush(false), FLUSH_MS);

    return () => {
      tick();
      releaseLease();
      void flush(true);
      window.clearInterval(tickTimer);
      window.clearInterval(flushTimer);
      window.removeEventListener("pointerdown", markActivity);
      window.removeEventListener("keydown", markActivity);
      window.removeEventListener("scroll", markActivity);
      window.removeEventListener("input", markActivity);
      window.removeEventListener("focus", markActivity);
      window.removeEventListener("online", drainPending);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [context, flush, ownsLease, releaseLease]);

  return null;
}
