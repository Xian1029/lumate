import { describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import { MarkdownRenderer, normalizeMarkdownEmphasis } from "./markdown-renderer";

describe("MarkdownRenderer", () => {
  it("repairs generated bold text with whitespace before the closing marker", () => {
    expect(normalizeMarkdownEmphasis("- [ ] **先看懂： **打开学习笔记")).toBe(
      "- [ ] **先看懂：** 打开学习笔记",
    );
    render(<MarkdownRenderer content="- [ ] **先看懂： **打开学习笔记" />);
    expect(screen.getByText("先看懂：").tagName).toBe("STRONG");
  });

  it("renders emphasis from escaped and full-width markers in older plans", () => {
    const escaped = normalizeMarkdownEmphasis("- [ ] \\*\\*再回想： \\*\\*用闪卡复习");
    const fullWidth = normalizeMarkdownEmphasis("- [ ] ＊＊试一试： ＊＊完成测验");
    expect(escaped).toBe("- [ ] **再回想：** 用闪卡复习");
    expect(fullWidth).toBe("- [ ] **试一试：** 完成测验");
  });

  it("renders historic checklist text as static Markdown", () => {
    render(
      <MarkdownRenderer
        content={'- [ ] \\\\*\\\\*先看懂： \\\\*\\\\*打开学习笔记，读一读“前言与目录”'}
      />,
    );
    expect(screen.getByText("先看懂：").tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*先看懂/)).not.toBeInTheDocument();
  });
  it("renders headings, lists, and a complete scrollable table", () => {
    render(
      <MarkdownRenderer
        content={[
          "## 小结",
          "",
          "- 先理解概念",
          "",
          "| 名称 | 说明 |",
          "| --- | --- |",
          "| 分数 | 表示整体的一部分 |",
        ].join("\n")}
      />,
    );

    expect(screen.getByRole("heading", { name: "小结" })).toBeInTheDocument();
    expect(screen.getByText("先理解概念")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("表示整体的一部分")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "学习表格，可横向滑动查看完整内容" })).toHaveAttribute("tabindex", "0");
  });
});
