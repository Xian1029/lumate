import { describe, expect, it } from "vitest";
import { latestIngestionJobsBySource } from "./ingestion-progress";
import type { IngestionJobSummary } from "@/lib/api";

function job(id: string, status: string, createdAt: string): IngestionJobSummary {
  return {
    id,
    filename: "七年级下册.pdf",
    source_type: "file",
    category: "textbook",
    status,
    phase_label: null,
    progress_percent: 20,
    nodes_created: 0,
    embedding_status: "failed",
    error_message: status === "failed" ? "解析失败" : null,
    dispatched_to: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe("latestIngestionJobsBySource", () => {
  it("shows only the newest failure after repeated uploads", () => {
    const result = latestIngestionJobsBySource([
      job("old", "failed", "2026-09-10T10:00:00Z"),
      job("new", "failed", "2026-09-10T10:01:00Z"),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("new");
  });

  it("replaces an old failure with the newest successful state", () => {
    const result = latestIngestionJobsBySource([
      job("failed", "failed", "2026-09-10T10:00:00Z"),
      job("completed", "completed", "2026-09-10T10:02:00Z"),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("completed");
  });
});
