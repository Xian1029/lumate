import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import ReviewPage from "./page";

const mockPush = vi.fn();
const getReviewSession = vi.fn();
const getAiNoteForNode = vi.fn();
const submitReviewRating = vi.fn();
const trackApiFailure = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "course-1" }),
  useRouter: () => ({
    push: mockPush,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api", () => ({
  getReviewSession: (...args: unknown[]) => getReviewSession(...args),
  getAiNoteForNode: (...args: unknown[]) => getAiNoteForNode(...args),
  submitReviewRating: (...args: unknown[]) => submitReviewRating(...args),
}));

vi.mock("@/lib/error-telemetry", () => ({
  trackApiFailure: (...args: unknown[]) => trackApiFailure(...args),
}));

vi.mock("@/lib/i18n-context", () => ({
  useT: () => (key: string) => key,
  useTF: () => (key: string, params?: Record<string, unknown>) => {
    if (!params) return key;
    return `${key}:${JSON.stringify(params)}`;
  },
}));

describe("ReviewPage rating flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    getReviewSession.mockResolvedValue({
      course_id: "course-1",
      count: 2,
      items: [
        {
          concept_id: "concept-1",
          concept_label: "Concept One",
          mastery: 0.4,
          stability_days: 1.2,
          retrievability: 0.5,
          urgency: "urgent",
          cluster: null,
          last_reviewed: null,
          content_node_id: "node-1",
        },
        {
          concept_id: "concept-2",
          concept_label: "Concept Two",
          mastery: 0.7,
          stability_days: 2.5,
          retrievability: 0.8,
          urgency: "warning",
          cluster: "cluster-a",
          last_reviewed: null,
        },
      ],
    });
  });

  it("keeps current card on rating failure and advances only after successful retry", async () => {
    submitReviewRating
      .mockRejectedValueOnce(new Error("rate failed"))
      .mockResolvedValueOnce({
        concept_id: "concept-1",
        rating: "good",
        new_mastery: 0.5,
        new_stability_days: 2,
      });

    const { user } = render(<ReviewPage />);

    await screen.findByText("Concept One");
    await user.click(screen.getByRole("button", { name: "review.showDetails" }));
    await user.click(screen.getByRole("button", { name: "review.good" }));

    await screen.findByText("rate failed");
    expect(screen.getByText("Concept One")).toBeInTheDocument();
    expect(screen.queryByText("Concept Two")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "review.good" }));

    await waitFor(() => {
      expect(screen.getByText("Concept Two")).toBeInTheDocument();
    });

    expect(submitReviewRating).toHaveBeenCalledTimes(2);
    expect(submitReviewRating).toHaveBeenNthCalledWith(1, "course-1", "concept-1", "good");
    expect(submitReviewRating).toHaveBeenNthCalledWith(2, "course-1", "concept-1", "good");
    expect(trackApiFailure).toHaveBeenCalledTimes(1);
  });

  it("opens the related chapter note in place without navigating away", async () => {
    getAiNoteForNode.mockResolvedValue({
      id: "note-1",
      title: "整式的加减",
      markdown: "## 合并同类项\n同类项的系数相加。",
      format: "markdown",
      auto_generated: true,
      version: 1,
    });

    const { user } = render(<ReviewPage />);
    await screen.findByText("Concept One");
    await user.click(screen.getByRole("button", { name: "review.viewRelatedNote" }));

    expect(await screen.findByText("整式的加减")).toBeInTheDocument();
    expect(screen.getByText("同类项的系数相加。")).toBeInTheDocument();
    expect(getAiNoteForNode).toHaveBeenCalledWith("course-1", "node-1");
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "review.goToChapterLearning" })).toHaveAttribute(
      "href",
      "/course/course-1?node=node-1#notes",
    );
  });
});
