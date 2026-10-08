const REVIEW_COMPLETION_PREFIX = "opentutor_review_completed_";
export const REVIEW_INSIGHT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function markReviewSessionCompleted(courseId: string, completedAt = Date.now()): void {
  try {
    localStorage.setItem(`${REVIEW_COMPLETION_PREFIX}${courseId}`, String(completedAt));
  } catch {
    // Local persistence is a fallback; review ratings remain authoritative.
  }
}

export function wasReviewSessionRecentlyCompleted(courseId: string, now = Date.now()): boolean {
  try {
    const completedAt = Number(localStorage.getItem(`${REVIEW_COMPLETION_PREFIX}${courseId}`));
    return Number.isFinite(completedAt)
      && completedAt > 0
      && now - completedAt < REVIEW_INSIGHT_COOLDOWN_MS;
  } catch {
    return false;
  }
}
