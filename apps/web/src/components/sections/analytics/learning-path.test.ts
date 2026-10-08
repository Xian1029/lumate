import { describe, expect, it } from "vitest";
import { buildLearningPathPlan } from "./learning-path";

const node = (id: string, status = "not_started") => ({
  id, label: id, level: 1, size: 12, color: "#94a3b8", status, mastery: status === "mastered" ? 1 : 0,
});

describe("buildLearningPathPlan", () => {
  it("recommends an in-progress available concept before a new one", () => {
    const plan = buildLearningPathPlan(
      [node("基础", "mastered"), node("进行中", "in_progress"), node("新知识")],
      [
        { source: "进行中", target: "基础", type: "prerequisite" },
        { source: "新知识", target: "基础", type: "prerequisite" },
      ],
    );
    expect(plan.recommended?.id).toBe("进行中");
    expect(plan.completedCount).toBe(1);
  });

  it("does not let an unrelated first-stage root block a ready successor", () => {
    const plan = buildLearningPathPlan(
      [node("正数和负数", "mastered"), node("有理数及其大小比较"), node("列代数式表示数量关系")],
      [{ source: "有理数及其大小比较", target: "正数和负数", type: "prerequisite" }],
    );
    expect(plan.recommended?.label).toBe("有理数及其大小比较");
    expect(plan.stages[0]?.unlocked).toBe(true);
    expect(plan.stages[1]?.unlocked).toBe(true);
    expect(plan.stages.flatMap((stage) => stage.nodes).find((item) => item.label === "有理数及其大小比较")?.statusLabel).toBe("available");
  });

  it("explains locked and converging knowledge using existing prerequisites", () => {
    const plan = buildLearningPathPlan(
      [node("甲"), node("乙"), node("丙")],
      [
        { source: "丙", target: "甲", type: "prerequisite" },
        { source: "丙", target: "乙", type: "prerequisite" },
      ],
    );
    const target = plan.nodes.find((item) => item.id === "丙");
    expect(target?.statusLabel).toBe("locked");
    expect(target?.lockReason).toBe("需完成 2 个前置知识点");
    expect(target?.relationHint).toBe("需完成以下全部前置知识");
  });

  it("keeps independent branches grouped by prerequisite depth without globally locking ready nodes", () => {
    const plan = buildLearningPathPlan(
      [node("数的基础"), node("数的运算"), node("代数基础"), node("整式")],
      [
        { source: "数的运算", target: "数的基础", type: "prerequisite" },
        { source: "整式", target: "代数基础", type: "prerequisite" },
      ],
    );
    expect(plan.stages).toHaveLength(2);
    expect(plan.stages[0]?.nodes.map((item) => item.label)).toEqual(["代数基础", "数的基础"]);
    expect(plan.stages[1]?.unlocked).toBe(false);
  });

  it("prioritizes the current textbook when comparable concepts are available", () => {
    const plan = buildLearningPathPlan(
      [{ ...node("甲"), material_id: "other", material_order: 0 }, { ...node("乙"), material_id: "current", material_order: 1 }],
      [],
      { activeMaterialId: "current" },
    );
    expect(plan.recommended?.id).toBe("乙");
  });

  it("only exposes genuine shared-prerequisite choices as alternatives", () => {
    const plan = buildLearningPathPlan(
      [node("基础", "mastered"), node("方向甲"), node("方向乙"), node("无关根节点")],
      [
        { source: "方向甲", target: "基础", type: "prerequisite" },
        { source: "方向乙", target: "基础", type: "prerequisite" },
      ],
    );
    expect(plan.recommended?.id).toBe("方向甲");
    expect(plan.alternatives.map((item) => item.id)).toEqual(["方向乙"]);
  });
});
