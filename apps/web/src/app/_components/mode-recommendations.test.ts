import { describe, expect, it } from "vitest";
import type { StudyGoal } from "@/lib/api";
import {
  buildGoalDeadlineSnapshots,
  evaluateModeSuggestion,
} from "./mode-recommendations";

function makeGoal(overrides: Partial<StudyGoal>): StudyGoal {
  return {
    id: "goal-1",
    user_id: "user-1",
    course_id: "course-1",
    title: "Midterm",
    objective: "Study",
    success_metric: null,
    current_milestone: null,
    next_action: null,
    status: "active",
    confidence: null,
    target_date: null,
    metadata_json: null,
    linked_task_count: 0,
    created_at: null,
    updated_at: null,
    completed_at: null,
    ...overrides,
  };
}

const t = (key: string) => key;
const tf = (key: string, values: Record<string, string | number>) =>
  `${key}:${JSON.stringify(values)}`;

describe("mode recommendations", () => {
  it("builds deadline snapshots from active goals", () => {
    const now = new Date("2026-03-30T00:00:00.000Z").getTime();
    const deadlines = buildGoalDeadlineSnapshots([
      makeGoal({ title: "Essay", target_date: "2026-04-02T00:00:00.000Z" }),
      makeGoal({ id: "goal-2", title: "No date", target_date: null }),
    ], now);

    expect(deadlines).toHaveLength(1);
    expect(deadlines[0].goal.title).toBe("Essay");
    expect(deadlines[0].daysLeft).toBe(3);
  });

  it("uses an upcoming deadline without treating in-progress nodes as errors", () => {
    const now = new Date("2026-03-30T00:00:00.000Z").getTime();
    const deadlines = buildGoalDeadlineSnapshots([
      makeGoal({ target_date: "2026-04-01T00:00:00.000Z" }),
    ], now);
    const suggestion = evaluateModeSuggestion({
      currentMode: "course_following",
      deadlines,
      t,
      tf,
    });

    expect(suggestion?.recommendationKey).toBe("deadline");
    expect(suggestion?.suggestedMode).toBe("exam_prep");
  });

  it("returns to self-paced after all exam deadlines have passed", () => {
    const now = new Date("2026-03-30T00:00:00.000Z").getTime();
    const deadlines = buildGoalDeadlineSnapshots([
      makeGoal({ target_date: "2026-03-20T00:00:00.000Z" }),
    ], now);
    const suggestion = evaluateModeSuggestion({
      currentMode: "exam_prep",
      deadlines,
      t,
      tf,
    });

    expect(suggestion?.recommendationKey).toBe("exam_passed");
    expect(suggestion?.suggestedMode).toBe("self_paced");
  });

  it("does not switch modes solely because mastery is high", () => {
    const suggestion = evaluateModeSuggestion({
      currentMode: "self_paced",
      deadlines: [],
      t,
      tf,
    });

    expect(suggestion).toBeNull();
  });
});
