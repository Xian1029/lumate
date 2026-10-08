import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/api";
import { CourseSpacesSection } from "./dashboard-spaces";

const toastSuccess = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: vi.fn(),
  },
}));

vi.mock("@/components/course/mode-selector", () => ({
  ModeBadge: () => null,
}));

const course: Course = {
  id: "course-1",
  name: "Linear Algebra",
  description: "Vectors and matrices",
  created_at: "2026-09-01T00:00:00Z",
};

const translations: Record<string, string> = {
  "home.yourSpaces": "Your Spaces",
  "home.spaceOpen": "Open space “{name}”",
  "home.spaceDelete.action": "Delete space “{name}”",
  "home.spaceDelete.title": "Delete this space?",
  "home.spaceDelete.description": "This permanently deletes “{name}”.",
  "home.spaceDelete.confirm": "Delete permanently",
  "home.spaceDelete.deleting": "Deleting…",
  "home.spaceDelete.success": "Space deleted",
  "home.spaceDelete.failed": "Failed to delete space",
  "general.cancel": "Cancel",
  "general.delete": "Delete",
  "dashboard.scenePrefix": "Scene",
};

describe("CourseSpacesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires confirmation before deleting a space and does not navigate", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onDelete = vi.fn().mockResolvedValue(undefined);

    render(
      <CourseSpacesSection
        courses={[course]}
        locale="en"
        onNavigate={onNavigate}
        onDelete={onDelete}
        t={(key) => translations[key] ?? key}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete space “Linear Algebra”" }));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByText("This permanently deletes “Linear Algebra”.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("course-1"));
    expect(toastSuccess).toHaveBeenCalledWith("Space deleted");
  });
});
