import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuizResult } from "./quiz-result";

vi.mock("@/lib/i18n-context", () => ({
  useT: () => (key: string) => ({
    "quiz.correct": "答得很好",
    "quiz.incorrect": "再检查一下",
    "quiz.answerRecorded": "答案已记录",
    "quiz.correctAnswerLabel": "正确答案：",
    "quiz.feedbackUnavailable": "暂时无法显示解析",
  }[key] ?? key),
}));

describe("QuizResult", () => {
  it("never uses an English boolean answer as the incorrect-state badge", () => {
    render(
      <QuizResult
        questionType="tf"
        result={{
          is_correct: false,
          user_answer: "错误",
          correct_answer: "True",
          explanation: "这个说法是正确的。",
          prerequisite_gaps: [],
        }}
      />,
    );

    expect(screen.getByText("再检查一下")).toBeInTheDocument();
    expect(screen.getByText("正确", { selector: "span.text-foreground" })).toBeInTheDocument();
    expect(screen.queryByText("TRUE")).not.toBeInTheDocument();
  });

  it("shows age-neutral positive feedback for a correct answer", () => {
    render(
      <QuizResult
        questionType="fill_blank"
        result={{
          is_correct: true,
          user_answer: "a^2/b",
          correct_answer: "a²/b",
          explanation: "写法不同，但表示同一个代数式。",
          prerequisite_gaps: [],
        }}
      />,
    );
    expect(screen.getByText("答得很好")).toBeInTheDocument();
  });
});
