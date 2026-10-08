import { describe, expect, it } from "vitest";
import { buildErrorPatternRadar, buildMasteryTimelinePoints, buildWrongAnswerFocus, getNextLearningAction } from "./unit-utils";
import type { MasterySnapshot, WrongAnswer } from "@/lib/api";

const wrong = (category: string): WrongAnswer => ({
  id: category, problem_id: category, question: "题目", question_type: "mc", options: null,
  user_answer: "A", correct_answer: "B", explanation: null, error_category: category,
  diagnosis: null, error_detail: null, knowledge_points: ["数轴"], review_count: 0, mastered: false,
});

describe("unit next-step evidence", () => {
  it("does not render a radar from fewer than three diagnostic records", () => {
    expect(buildErrorPatternRadar([wrong("conceptual"), wrong("careless")])).toBeNull();
  });

  it("builds radar values only from recorded error categories", () => {
    const radar = buildErrorPatternRadar([wrong("conceptual"), wrong("conceptual"), wrong("careless")]);
    expect(radar?.find((item) => item.id === "conceptual")?.count).toBe(2);
    expect(radar?.find((item) => item.id === "careless")?.count).toBe(1);
  });

  it("only recommends review when there are actually urgent review items", () => {
    expect(getNextLearningAction({ urgentReviewCount: 0, wrongAnswerCount: 0, errorTrend: { recent7d: 0, previous7d: 0, delta: 0, direction: "flat" } })).toBe("practice");
    expect(getNextLearningAction({ urgentReviewCount: 2, wrongAnswerCount: 0, errorTrend: { recent7d: 0, previous7d: 0, delta: 0, direction: "flat" } })).toBe("review");
  });

  it("groups recurring mistakes by real knowledge evidence without labeling one miss as recurring", () => {
    const isolated = { ...wrong("conceptual"), id: "isolated", knowledge_points: ["相反数"] };
    const repeated = [
      { ...wrong("computational"), id: "one", knowledge_points: ["数轴"] },
      { ...wrong("computational"), id: "two", knowledge_points: ["数轴"] },
    ];
    const focus = buildWrongAnswerFocus([isolated, ...repeated]);
    expect(focus[0]).toMatchObject({ label: "数轴", count: 2, unresolvedCount: 2 });
    expect(focus.find((item) => item.label === "相反数")?.count).toBe(1);
  });

  it("reduces answer-level snapshots to meaningful daily learning milestones", () => {
    const snapshots: MasterySnapshot[] = [
      { mastery_score: 0.2, gap_type: "conceptual", content_node_id: "n", recorded_at: "2026-10-01T08:00:00Z" },
      { mastery_score: 0.22, gap_type: "conceptual", content_node_id: "n", recorded_at: "2026-10-01T08:10:00Z" },
      { mastery_score: 0.45, gap_type: "procedural", content_node_id: "n", recorded_at: "2026-10-03T08:00:00Z" },
      { mastery_score: 0.48, gap_type: "procedural", content_node_id: "n", recorded_at: "2026-10-04T08:00:00Z" },
      { mastery_score: 0.7, gap_type: null, content_node_id: "n", recorded_at: "2026-10-06T08:00:00Z" },
    ];
    const points = buildMasteryTimelinePoints(snapshots);
    expect(points).toHaveLength(4);
    expect(points[0]).toMatchObject({ masteryPercent: 22, sampleCount: 2 });
    expect(points.at(-1)?.masteryPercent).toBe(70);
  });
});
