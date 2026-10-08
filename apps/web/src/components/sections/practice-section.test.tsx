import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PracticeSection } from "./practice-section";

vi.mock("@/lib/i18n-context", () => ({ useT: () => (key: string) => key }));
vi.mock("@/store/workspace", () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: { practiceActiveTab: null }) => unknown) => selector({ practiceActiveTab: null }),
    { getState: () => ({ setPracticeTab: vi.fn() }) },
  ),
}));
vi.mock("./practice/quiz-view", () => ({ QuizView: () => <div data-testid="quiz-content" /> }));
vi.mock("./practice/flashcard-view", () => ({ FlashcardView: () => <div data-testid="flashcard-content" /> }));
vi.mock("./practice/review-view", () => ({ ReviewView: () => <div data-testid="quiz-review-content" /> }));
vi.mock("./practice/flashcard-review-view", () => ({ FlashcardReviewView: () => <div data-testid="flashcard-review-content" /> }));

describe("PracticeSection scopes", () => {
  it("shows only quiz and its review in quiz scope", async () => {
    render(<PracticeSection courseId="course" scope="quiz" defaultTab="quiz" />);
    expect(screen.getByRole("tab", { name: "course.quiz" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "course.review" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "course.cards" })).not.toBeInTheDocument();
    expect(await screen.findByTestId("quiz-content")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "course.review" }));
    expect(await screen.findByTestId("quiz-review-content")).toBeInTheDocument();
    expect(screen.queryByTestId("flashcard-review-content")).not.toBeInTheDocument();
  });

  it("shows only flashcards and their review in flashcard scope", async () => {
    render(<PracticeSection courseId="course" scope="flashcards" defaultTab="flashcards" />);
    expect(screen.getByRole("tab", { name: "course.cards" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "course.review" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "course.quiz" })).not.toBeInTheDocument();
    expect(await screen.findByTestId("flashcard-content")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "course.review" }));
    expect(await screen.findByTestId("flashcard-review-content")).toBeInTheDocument();
    expect(screen.queryByTestId("quiz-review-content")).not.toBeInTheDocument();
  });
});
