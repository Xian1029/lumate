import { describe, expect, it } from "vitest";
import { cleanNoteTextForTest } from "./notes-section";

describe("AI note text cleanup", () => {
  it("repairs recognizable UTF-8 mojibake and removes control characters", () => {
    expect(cleanNoteTextForTest("\u0000ä¸­æ–‡\u0007")).toBe("中文");
  });

  it("preserves ordinary unicode content", () => {
    expect(cleanNoteTextForTest("Résumé — 中文")).toBe("Résumé — 中文");
  });
});
