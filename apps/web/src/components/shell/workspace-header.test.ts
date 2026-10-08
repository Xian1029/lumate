import { describe, expect, it } from "vitest";

import { getWorkspaceBackHref } from "./workspace-header";

describe("workspace header return destination", () => {
  const courseId = "course-1";

  it("returns from every block full-page route to the current course workspace", () => {
    const fullPageRoutes = [
      "notes",
      "practice",
      "graph",
      "plan",
      "review",
      "profile",
      "wrong-answers",
    ];

    for (const route of fullPageRoutes) {
      expect(getWorkspaceBackHref(`/course/${courseId}/${route}`, courseId)).toBe(`/course/${courseId}`);
    }
  });

  it("keeps the course workspace back button pointing to the home page", () => {
    expect(getWorkspaceBackHref(`/course/${courseId}`, courseId)).toBe("/");
  });

  it("does not treat another course or an unrelated page as the current course", () => {
    expect(getWorkspaceBackHref("/course/course-2/notes", courseId)).toBe("/");
    expect(getWorkspaceBackHref("/settings", courseId)).toBe("/");
  });
});
