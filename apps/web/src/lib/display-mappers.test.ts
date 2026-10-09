import { describe, it, expect } from "vitest";
import {
  getActionTypeLabel,
  getTaskStatusLabel,
  getGradingResultLabel,
  getProcessingStatusLabel,
  getGapTypeLabel,
  getDiagnosisTypeLabel,
  getErrorCategoryLabel,
  getErrorSignalLabel,
  getUrgencyLabel,
  getMemoryTypeLabel,
  getSourceTypeLabel,
  toUserFacingError,
} from "./display-mappers";

describe("display-mappers: 用户界面不得出现英文枚举", () => {
  it("学习动作类型映射为中文", () => {
    expect(getActionTypeLabel("CONTENT")).toBe("学习内容");
    expect(getActionTypeLabel("NOTE")).toBe("学习笔记");
    expect(getActionTypeLabel("PRACTICE")).toBe("练习");
    expect(getActionTypeLabel("REVIEW")).toBe("复习");
    expect(getActionTypeLabel("MASTERY_CHECK")).toBe("掌握检测");
    expect(getActionTypeLabel("AI_TUTOR")).toBe("AI导师");
    expect(getActionTypeLabel("FEYNMAN")).toBe("费曼讲解");
    expect(getActionTypeLabel("FLASHCARD")).toBe("记忆卡片");
    // 未知值兜底为中文而非英文原文
    expect(getActionTypeLabel("SOMETHING_NEW")).not.toBe("SOMETHING_NEW");
  });

  it("任务状态映射为中文", () => {
    expect(getTaskStatusLabel("IN_PROGRESS")).toBe("进行中");
    expect(getTaskStatusLabel("READY")).toBe("待开始");
    expect(getTaskStatusLabel("PENDING")).toBe("待处理");
    expect(getTaskStatusLabel("COMPLETED")).toBe("已完成");
    expect(getTaskStatusLabel("FAILED")).toBe("处理失败");
    expect(getTaskStatusLabel("PROCESSING")).toBe("处理中");
  });

  it("判题结果学生端不出现英文枚举", () => {
    for (const v of ["EXACT", "NORMALIZED_EXACT", "NUMERIC_EQUIVALENT"]) {
      expect(getGradingResultLabel(v)).toBe("回答正确");
    }
    expect(getGradingResultLabel("SEMANTIC_EQUIVALENT")).toBe("理解正确");
    expect(getGradingResultLabel("PARTIALLY_CORRECT")).toBe("部分正确");
    expect(getGradingResultLabel("INCORRECT")).toBe("回答有误");
    expect(getGradingResultLabel("NEEDS_REVIEW")).toBe("正在进一步判断");
  });

  it("诊断/缺口/错误分类映射", () => {
    expect(getGapTypeLabel("fundamental_gap")).toBe("基础薄弱");
    expect(getGapTypeLabel("trap_vulnerability")).toBe("易踩陷阱");
    expect(getGapTypeLabel("transfer_gap")).toBe("迁移困难");
    expect(getGapTypeLabel("conceptual")).toBe("概念理解");
    expect(getGapTypeLabel("procedural")).toBe("解题步骤");
    expect(getGapTypeLabel("computational")).toBe("计算能力");
    expect(getGapTypeLabel("reading")).toBe("审题理解");
    expect(getGapTypeLabel("careless")).toBe("细心检查");
    expect(getGapTypeLabel("mastered")).toBe("已掌握");
    expect(getDiagnosisTypeLabel("carelessness")).toBe("粗心");
    expect(getErrorCategoryLabel("conceptual")).toBe("概念不清");
    expect(getErrorCategoryLabel("computational")).toBe("计算失误");
    expect(getErrorSignalLabel("fundamental gap")).toBe("基础薄弱");
    expect(getErrorSignalLabel("trap-vulnerability")).toBe("易踩陷阱");
    expect(getErrorSignalLabel("UNRECOGNIZED_INTERNAL_VALUE")).toBe("待进一步分析");
    expect(getGapTypeLabel("UNKNOWN_GAP")).toBe("学习情况待确认");
    expect(getUrgencyLabel("overdue")).toBe("已逾期");
    expect(getUrgencyLabel("urgent")).toBe("需尽快复习");
  });

  it("记忆类型与来源类型映射", () => {
    expect(getMemoryTypeLabel("profile")).toBe("个人情况");
    expect(getMemoryTypeLabel("knowledge")).toBe("知识记忆");
    expect(getSourceTypeLabel("canvas")).toBe("在线课程平台");
    expect(getSourceTypeLabel("file")).toBe("上传文件");
  });

  it("后端错误按状态码转中文提示", () => {
    expect(toUserFacingError(401)).toContain("登录");
    expect(toUserFacingError(403)).toContain("权限");
    expect(toUserFacingError(404)).toContain("不存在");
    expect(toUserFacingError(429)).toContain("频繁");
    expect(toUserFacingError(500)).toContain("服务");
    expect(toUserFacingError(503)).toContain("服务");
    expect(toUserFacingError(null, "兜底提示")).toBe("兜底提示");
  });

  it("处理状态映射", () => {
    expect(getProcessingStatusLabel("completed")).toBe("已完成");
    expect(getProcessingStatusLabel("failed")).toBe("处理失败");
    expect(getProcessingStatusLabel("extracting")).toBe("正在提取内容");
  });
});
