import { describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import type { ContentNode } from "@/lib/api";

import { resolveChapterNavigationNodes, SubsectionsNav, UnitNavigation } from "./unit-navigation";

const node = (id: string, title: string, order: number, children: ContentNode[] = []): ContentNode => ({
  id,
  title,
  order_index: order,
  children,
  type: "section",
  level: 1,
  content: null,
  source_type: "pdf",
  content_category: null,
});

describe("chapter navigation", () => {
  const first = node("first", "1.1 正数和负数", 1);
  const second = node("second", "1.2 有理数及其大小比较", 2);
  const parent = node("parent", "第一章 有理数", 0, [second, first]);
  const chapterTwo = node("chapter-two", "第二章 有理数的运算", 2);
  const book = node("book", "七年级数学", 0, [chapterTwo, parent]);
  const t = (key: string) => ({
    "unit.chapterNavigation": "本章学习目录",
    "unit.chapterNavigationHint": "选择小节继续学习",
    "unit.currentChapter": "当前",
    "unit.expandDirectory": "展开",
    "unit.viewDirectory": "查看目录",
    "unit.collapseDirectory": "收起",
    "unit.learningPath": "你正在学习",
    "unit.parentSiblings": "学习位置",
    "unit.topLevel": "顶层",
    "unit.whereToStart": "从哪里开始？",
    "unit.chooseFromDirectory": "请从下方学习目录选择一个小节",
    "unit.thisSectionFocus": "这节课要学什么",
    "unit.threeStudySteps": "跟着三步开始学习",
    "unit.stepChoose": "选小节",
    "unit.stepRead": "读笔记",
    "unit.stepPractice": "做练习",
    "unit.bookHome": "课本首页",
    "unit.chooseAnotherChapter": "还想学哪一章？",
    "unit.chooseAnotherSection": "还想学哪个小节？",
    "unit.backToBook": "返回课本首页",
    "unit.backToChapter": "返回本章",
    "unit.thisChapterFocus": "这章会学什么",
  }[key] ?? key);
  const tf = (key: string) => key;

  it("keeps the parent's complete directory when viewing a leaf subsection", () => {
    expect(resolveChapterNavigationNodes(first, parent).map((item) => item.id)).toEqual(["first", "second"]);
  });

  it("uses direct children when viewing a chapter", () => {
    expect(resolveChapterNavigationNodes(parent, null).map((item) => item.id)).toEqual(["first", "second"]);
  });

  it("keeps the full book directory after entering a subsection", () => {
    expect(resolveChapterNavigationNodes(first, parent, book).map((item) => item.id)).toEqual(["parent", "chapter-two"]);
  });

  it("marks the current subsection and keeps every sibling link visible", () => {
    render(<SubsectionsNav courseId="course" currentNodeId="first" subsections={[first, second]} t={t} />);
    expect(screen.getByTestId("chapter-navigation")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /1.1 正数和负数/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /1.2 有理数及其大小比较/ })).toHaveAttribute(
      "href",
      "/course/course/unit/second",
    );
  });

  it("shows chapters and their specific subsections while marking the active subsection", () => {
    render(<SubsectionsNav courseId="course" currentNodeId="first" subsections={[parent, chapterTwo]} t={t} />);
    expect(screen.getByRole("link", { name: /第一章 有理数/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /第一章 有理数/ })).toHaveAttribute("href", "/course/course/unit/first");
    expect(screen.getByRole("link", { name: /1.1 正数和负数/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /1.2 有理数及其大小比较/ })).toHaveAttribute("href", "/course/course/unit/second");
  });

  it("shows clear next steps instead of file-derived concept tags on the course overview", () => {
    render(<UnitNavigation courseId="course" nodePath={[parent]} parentNode={null} siblingNodes={[]} focusTerms={["pdf", "课本"]} wrongAnswerCount={0} reviewItemCount={0} t={t} tf={tf} />);
    expect(screen.getByText("从哪里开始？")).toBeInTheDocument();
    expect(screen.getByText(/选小节/)).toBeInTheDocument();
    expect(screen.queryByText("pdf")).not.toBeInTheDocument();
  });

  it("shows useful learning focus on a subsection", () => {
    render(<UnitNavigation courseId="course" nodePath={[book, parent, first]} parentNode={parent} siblingNodes={[second]} focusTerms={["正数", "负数"]} wrongAnswerCount={1} reviewItemCount={2} t={t} tf={tf} />);
    expect(screen.getByText("这节课要学什么")).toBeInTheDocument();
    expect(screen.getByText("正数")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: second.title })).toBeInTheDocument();
  });
});
