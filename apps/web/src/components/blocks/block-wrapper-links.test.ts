import { describe, expect, it } from "vitest";
import { getBlockFullPageHref } from "./block-wrapper";

describe("block full-page links", () => {
  it("keeps the selected knowledge point when flashcards expand", () => {
    expect(getBlockFullPageHref("flashcards", "course-1", "node/1")).toBe(
      "/course/course-1/practice?tab=flashcards&node=node%2F1",
    );
  });

  it("keeps backward-compatible course-level links when no node is selected", () => {
    expect(getBlockFullPageHref("flashcards", "course-1", null)).toBe(
      "/course/course-1/practice?tab=flashcards",
    );
  });
});
