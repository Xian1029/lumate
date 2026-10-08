import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { calculateQuizScore, QuizView, selectLatestExerciseSet } from "./quiz-view";
import { toast } from "sonner";

vi.mock("@/lib/api", async () => {
  const problems = [
    {
      id: "p1",
      question_type: "mc",
      question: "What color is the sky?",
      options: { a: "Red", b: "Blue", c: "Green", d: "Yellow" },
      difficulty_layer: 1,
      problem_metadata: { core_concept: "Atmosphere" },
    },
    {
      id: "p2",
      question_type: "fill_blank",
      question: "2 + 2 = ?",
      options: { a: "3", b: "4", c: "5", d: "6" },
      correct_answer: "b",
      explanation: "Two plus two equals four.",
      difficulty_layer: 1,
      problem_metadata: {},
    },
  ];
  return {
    listProblems: vi.fn().mockResolvedValue(problems),
    extractQuiz: vi.fn().mockResolvedValue({ problems_created: 5 }),
    submitAnswer: vi.fn().mockResolvedValue({
      is_correct: true,
      correct_answer: "b",
      explanation: "Blue is correct.",
      prerequisite_gaps: [],
    }),
  };
});

vi.mock("@/lib/i18n-context", () => ({
  useT: () => (key: string) => key,
}));

vi.mock("@/lib/i18n", () => ({
  getLocale: () => "en",
}));

vi.mock("sonner", () => ({
  toast: {
    warning: vi.fn(),
  },
}));

vi.mock("@/store/workspace", () => ({
  useWorkspaceStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ selectedNodeId: "lesson-1", sectionRefreshKey: { practice: 0 }, spaceLayout: { mode: "self_paced", blocks: [] } }),
    {
      getState: () => ({
        selectedNodeId: "lesson-1",
        sectionRefreshKey: { practice: 0 },
        spaceLayout: { mode: "self_paced", blocks: [] },
        addBlock: vi.fn(),
        reorderBlocks: vi.fn(),
        triggerRefresh: vi.fn(),
      }),
    },
  ),
}));

vi.mock("@/lib/block-system/feature-unlock", () => ({
  updateUnlockContext: vi.fn(),
  getUnlockContext: () => ({ practiceAttempts: 0, hasWrongAnswer: false }),
}));

vi.mock("@/components/shared/ai-feature-blocked", () => ({
  AiFeatureBlocked: () => <div data-testid="ai-blocked" />,
}));

vi.mock("./use-quiz-persistence", () => {
  const save = vi.fn();
  const load = vi.fn().mockReturnValue(null);
  const clear = vi.fn();
  const subscribe = vi.fn().mockReturnValue(() => undefined);
  return {
    useQuizPersistence: () => ({ save, load, clear, subscribe }),
  };
});

describe("QuizView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives accuracy from unique answered questions and never exceeds 100%", () => {
    const problems = [{ id: "p1" }, { id: "p2" }];
    const answers = {
      p1: { answer: "A", is_correct: true },
      p2: { answer: "B", is_correct: true },
      staleProblem: { answer: "C", is_correct: true },
    };
    expect(calculateQuizScore(problems, answers, { correct: 49, total: 47 })).toEqual({
      correct: 2,
      total: 2,
    });
  });

  it("clamps legacy score data to the number of unique answered questions", () => {
    const problems = [{ id: "p1" }, { id: "p2" }];
    const legacyAnswers = { p1: { answer: "A" }, p2: { answer: "B" } };
    expect(calculateQuizScore(problems, legacyAnswers, { correct: 49, total: 47 })).toEqual({
      correct: 2,
      total: 2,
    });
  });

  it("selects only the newest server exercise batch instead of mixing old questions", () => {
    const selection = selectLatestExerciseSet([
      { id: "old-1", order_index: 3, source_batch_id: "batch-old" },
      { id: "old-2", order_index: 4, source_batch_id: "batch-old" },
      { id: "new-1", order_index: 5, source_batch_id: "batch-new" },
      { id: "new-2", order_index: 6, source_batch_id: "batch-new" },
    ] as never);

    expect(selection.batchId).toBe("batch-new");
    expect(selection.items.map((item) => item.id)).toEqual(["new-1", "new-2"]);
  });

  it("shows loading state initially", async () => {
    render(<QuizView courseId="test" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });

  it("renders quiz question after loading", async () => {
    render(<QuizView courseId="test" />);
    await waitFor(() => {
      expect(screen.getByText("What color is the sky?")).toBeInTheDocument();
    });
  });

  it("has role=form with aria-label", async () => {
    render(<QuizView courseId="test" />);
    await waitFor(() => screen.getByText("What color is the sky?"));
    expect(screen.getByRole("form", { name: "quiz.ariaLabel" })).toBeInTheDocument();
  });

  it("has role=radiogroup for answer options", async () => {
    render(<QuizView courseId="test" />);
    await waitFor(() => screen.getByText("What color is the sky?"));
    expect(screen.getByRole("radiogroup", { name: "quiz.answerOptions" })).toBeInTheDocument();
  });

  it("renders answer options as radio buttons", async () => {
    render(<QuizView courseId="test" />);
    await waitFor(() => screen.getByText("What color is the sky?"));
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(4);
  });

  it("selects option and submits answer on click", async () => {
    const { submitAnswer } = await import("@/lib/api");
    render(<QuizView courseId="test" />);
    await waitFor(() => screen.getByText("What color is the sky?"));

    const optionB = screen.getByTestId("quiz-option-b");
    fireEvent.click(optionB);

    await waitFor(() => {
      expect(submitAnswer).toHaveBeenCalledWith("p1", "b", expect.any(Number));
    });
  });

  it("shows explanation after answering", async () => {
    render(<QuizView courseId="test" />);
    await waitFor(() => screen.getByText("What color is the sky?"));

    fireEvent.click(screen.getByTestId("quiz-option-b"));

    await waitFor(() => {
      expect(screen.getByText(/Blue is correct/)).toBeInTheDocument();
    });
  });

  it("shows fallback feedback when explanation details are missing", async () => {
    const { submitAnswer } = await import("@/lib/api");
    vi.mocked(submitAnswer).mockResolvedValueOnce({
      is_correct: false,
      correct_answer: null,
      user_answer: null,
      explanation: null,
      prerequisite_gaps: [],
    });

    render(<QuizView courseId="test" />);
    await waitFor(() => screen.getByText("What color is the sky?"));

    fireEvent.click(screen.getByTestId("quiz-option-b"));

    await waitFor(() => {
      expect(screen.getByText("quiz.incorrect")).toBeInTheDocument();
      expect(screen.getByText("quiz.feedbackUnavailable")).toBeInTheDocument();
    });
    expect(toast.warning).toHaveBeenCalledWith("quiz.feedbackWarning");
  });

  it("navigates to next question", async () => {
    render(<QuizView courseId="test" />);
    await waitFor(() => screen.getByText("What color is the sky?"));

    const nextBtn = screen.getByText("quiz.next");
    fireEvent.click(nextBtn);

    await waitFor(() => {
      expect(screen.getByText("2 + 2 = ?")).toBeInTheDocument();
    });
  });

  it("uses Enter for a new line and only submits with the shortcut or button", async () => {
    const user = userEvent.setup();
    const { submitAnswer } = await import("@/lib/api");
    render(<QuizView courseId="test" />);
    await waitFor(() => screen.getByText("What color is the sky?"));

    await user.click(screen.getByText("quiz.next"));
    const input = await screen.findByRole("textbox", { name: "quiz.textAnswerLabel" });
    fireEvent.change(input, { target: { value: "第一行\n第二行" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input).toHaveValue("第一行\n第二行");
    expect(submitAnswer).not.toHaveBeenCalledWith("p2", expect.anything(), expect.any(Number));

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      expect(submitAnswer).toHaveBeenCalledWith("p2", "第一行\n第二行", expect.any(Number));
    });
  });

  it("disables previous button on first question", async () => {
    render(<QuizView courseId="test" />);
    await waitFor(() => screen.getByText("What color is the sky?"));
    expect(screen.getByText("quiz.prev")).toBeDisabled();
  });

  it("shows core concept badge", async () => {
    render(<QuizView courseId="test" />);
    await waitFor(() => screen.getByText("What color is the sky?"));
    expect(screen.getByText("Atmosphere")).toBeInTheDocument();
  });
});
