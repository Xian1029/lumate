import { beforeEach, describe, expect, it } from "vitest";
import {
  markReviewSessionCompleted,
  REVIEW_INSIGHT_COOLDOWN_MS,
  wasReviewSessionRecentlyCompleted,
} from "./review-session-state";

describe("review session completion state", () => {
  beforeEach(() => localStorage.clear());

  it("suppresses a repeated review insight during the completion cooldown", () => {
    markReviewSessionCompleted("course-1", 1_000);
    expect(wasReviewSessionRecentlyCompleted("course-1", 1_000 + REVIEW_INSIGHT_COOLDOWN_MS - 1)).toBe(true);
  });

  it("allows a new review insight after the cooldown", () => {
    markReviewSessionCompleted("course-1", 1_000);
    expect(wasReviewSessionRecentlyCompleted("course-1", 1_000 + REVIEW_INSIGHT_COOLDOWN_MS)).toBe(false);
  });
});
