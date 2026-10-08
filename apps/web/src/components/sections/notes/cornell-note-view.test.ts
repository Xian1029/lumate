import { describe, expect, it } from "vitest";

import { extractCornellCues, extractCornellSummary } from "./cornell-note-view";

describe("Cornell note helpers", () => {
  it("extracts unique headings and emphasized keywords as cues", () => {
    const markdown = "# 正数和负数\n**相反意义的量**用于描述方向相反的变化。\n## 数轴\n**相反意义的量**";
    expect(extractCornellCues(markdown)).toEqual(["正数和负数", "数轴", "相反意义的量"]);
  });

  it("creates a short readable summary without markdown marks", () => {
    const markdown = "# 有理数\n正数大于零。负数小于零。后面的内容不应进入两句小结。";
    expect(extractCornellSummary(markdown)).toBe("有理数 正数大于零。负数小于零。");
  });
});
