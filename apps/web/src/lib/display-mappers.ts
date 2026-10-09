/**
 * 统一的中文显示映射层。
 *
 * 后端 / 存储层保留英文枚举值（NOTE、PRACTICE、IN_PROGRESS、NEEDS_REVIEW 等）
 * 作为程序内部值，任何「面向学生 / 家长 / 教师」的界面都必须通过这里的
 * 映射函数转换为自然中文，禁止把原始枚举或后端英文错误直接渲染到页面。
 *
 * 规则：本文件只负责「值 → 中文文案」的映射，不产生副作用、不依赖 React。
 */

/** 学习动作类型（HomeLearningAction.action_type / target_module）→ 中文。 */
export const ACTION_TYPE_LABELS: Record<string, string> = {
  CONTENT: "学习内容",
  NOTE: "学习笔记",
  PRACTICE: "练习",
  REVIEW: "复习",
  MASTERY_CHECK: "掌握检测",
  AI_TUTOR: "AI导师",
  FEYNMAN: "费曼讲解",
  FLASHCARD: "记忆卡片",
  LEARN: "学习内容",
  REFLECTION: "学习总结",
  ASSESSMENT: "掌握检测",
};

export function getActionTypeLabel(actionType: string | null | undefined): string {
  if (!actionType) return "学习内容";
  return ACTION_TYPE_LABELS[actionType.toUpperCase()] ?? "学习内容";
}

/** 学习任务状态（LearningTask.status / 后端 task 状态）→ 中文。 */
export const TASK_STATUS_LABELS: Record<string, string> = {
  PENDING: "待处理",
  READY: "待开始",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  POSTPONED: "已延后",
  MISSED: "待重新安排",
  SKIPPED: "已跳过",
  FAILED: "处理失败",
  PROCESSING: "处理中",
};

export function getTaskStatusLabel(status: string | null | undefined): string {
  if (!status) return "待处理";
  return TASK_STATUS_LABELS[status.toUpperCase()] ?? status;
}

/** 判题结果（grading match_type）→ 面向学生的自然反馈。 */
export const GRADING_RESULT_LABELS: Record<string, string> = {
  EXACT: "回答正确",
  NORMALIZED_EXACT: "回答正确",
  NUMERIC_EQUIVALENT: "回答正确",
  SEMANTIC_EQUIVALENT: "理解正确",
  PARTIALLY_CORRECT: "部分正确",
  INCORRECT: "回答有误",
  NEEDS_REVIEW: "正在进一步判断",
};

export function getGradingResultLabel(matchType: string | null | undefined): string {
  if (!matchType) return "";
  return GRADING_RESULT_LABELS[matchType.toUpperCase()] ?? "正在进一步判断";
}

/** 资料处理 / 解析状态 → 中文。 */
export const PROCESSING_STATUS_LABELS: Record<string, string> = {
  QUEUED: "排队中",
  PENDING: "待处理",
  PROCESSING: "处理中",
  PARSING: "解析中",
  IN_PROGRESS: "处理中",
  READY: "待开始",
  COMPLETED: "已完成",
  COMPLETE: "已完成",
  SUCCESS: "已完成",
  FAILED: "处理失败",
  PARTIAL: "部分成功",
  PARTIALLY_COMPLETED: "部分成功",
  CANCELLED: "已取消",
  // 解析管线各阶段
  UPLOADED: "已上传",
  EXTRACTING: "正在提取内容",
  CLASSIFYING: "正在分类资料",
  DISPATCHING: "正在生成学习内容",
  EMBEDDING: "正在建立语义索引",
};

export function getProcessingStatusLabel(status: string | null | undefined): string {
  if (!status) return "待处理";
  return PROCESSING_STATUS_LABELS[status.toUpperCase()] ?? status;
}

/** 学习计划状态 → 中文。 */
export const PLAN_STATUS_LABELS: Record<string, string> = {
  DRAFT: "草稿",
  GENERATING: "生成中",
  PENDING_APPROVAL: "待确认",
  CHANGES_REQUESTED: "待调整",
  ACTIVE: "执行中",
  PAUSED: "已暂停",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
};

export function getPlanStatusLabel(status: string | null | undefined): string {
  if (!status) return "草稿";
  return PLAN_STATUS_LABELS[status.toUpperCase()] ?? status;
}

/**
 * 将后端返回的错误信息转为面向用户的中文友好提示。
 * 后端 detail 常为英文技术文案（"Internal Server Error"、"Task not found" 等），
 * 不应直接暴露给学生。这里按状态码给出通用中文提示，原始 detail 仅用于日志。
 */
export function toUserFacingError(
  status: number | null | undefined,
  fallback = "操作失败，请稍后重试。",
): string {
  switch (status) {
    case 400:
      return "请求内容有误，请检查后重试。";
    case 401:
      return "登录状态已过期，请重新登录。";
    case 403:
      return "你没有权限进行这项操作。";
    case 404:
      return "内容不存在或已被删除，请返回重试。";
    case 409:
      return "操作冲突，请刷新后重试。";
    case 422:
      return "填写的信息有误，请检查后重试。";
    case 429:
      return "操作太频繁了，请稍后再试。";
    case 500:
    case 502:
    case 503:
    case 504:
      return "服务暂时不可用，请稍后重试。";
    default:
      return fallback;
  }
}

/** 知识缺口类型（gap_type）→ 中文。 */
const GAP_TYPE_LABELS: Record<string, string> = {
  fundamental_gap: "基础薄弱",
  transfer_gap: "迁移困难",
  trap_vulnerability: "易踩陷阱",
  conceptual: "概念理解",
  procedural: "解题步骤",
  computational: "计算能力",
  reading: "审题理解",
  careless: "细心检查",
  other: "需要继续巩固",
  mastered: "已掌握",
};

/** 将服务端内部枚举的常见写法归一化，避免 "fundamental gap" 等值漏出到界面。 */
function normalizeDiagnosticValue(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * 后端诊断字段原则上只允许英文枚举；历史数据可能含中文人工标注。
 * 中文标注可以原样展示，未知英文值必须以中文兜底，不能暴露内部字段。
 */
function chineseOrFallback(value: string, fallback: string): string {
  return /[\u3400-\u9fff]/.test(value) ? value : fallback;
}

export function getGapTypeLabel(gapType: string | null | undefined): string {
  if (!gapType) return "知识缺口";
  return GAP_TYPE_LABELS[normalizeDiagnosticValue(gapType)] ?? chineseOrFallback(gapType, "学习情况待确认");
}

/** 错题诊断类型（diagnosis）→ 中文。 */
const DIAGNOSIS_TYPE_LABELS: Record<string, string> = {
  fundamental_gap: "基础薄弱",
  transfer_gap: "迁移困难",
  trap_vulnerability: "易踩陷阱",
  carelessness: "粗心",
  careless: "粗心",
  mastered: "已掌握",
};

export function getDiagnosisTypeLabel(diagnosis: string | null | undefined): string {
  if (!diagnosis) return "待分类";
  return DIAGNOSIS_TYPE_LABELS[normalizeDiagnosticValue(diagnosis)] ?? chineseOrFallback(diagnosis, "待进一步分析");
}

/** 复习紧急度（urgency）→ 中文。 */
const URGENCY_LABELS: Record<string, string> = {
  overdue: "已逾期",
  urgent: "需尽快复习",
  warning: "即将到期",
  ok: "状态良好",
};

export function getUrgencyLabel(urgency: string | null | undefined): string {
  if (!urgency) return "待复习";
  return URGENCY_LABELS[urgency] ?? "待复习";
}

/** 错因分类（error_category）→ 中文。 */
const ERROR_CATEGORY_LABELS: Record<string, string> = {
  conceptual: "概念不清",
  procedural: "方法错误",
  computational: "计算失误",
  reading: "审题不清",
  careless: "粗心",
  carelessness: "粗心",
};

export function getErrorCategoryLabel(category: string | null | undefined): string {
  if (!category) return "待分类";
  return ERROR_CATEGORY_LABELS[normalizeDiagnosticValue(category)] ?? chineseOrFallback(category, "待进一步分析");
}

/** 错因模式区域统一使用此函数，覆盖错因分类、诊断及掌握缺口。 */
export function getErrorSignalLabel(value: string | null | undefined): string {
  if (!value) return "待进一步分析";
  const normalized = normalizeDiagnosticValue(value);
  return ERROR_CATEGORY_LABELS[normalized]
    ?? DIAGNOSIS_TYPE_LABELS[normalized]
    ?? GAP_TYPE_LABELS[normalized]
    ?? chineseOrFallback(value, "待进一步分析");
}

/** 记忆类型（memory_type）→ 中文。 */
const MEMORY_TYPE_LABELS: Record<string, string> = {
  profile: "个人情况",
  knowledge: "知识记忆",
  plan: "学习计划",
  conversation: "对话记录",
};

export function getMemoryTypeLabel(memoryType: string | null | undefined): string {
  if (!memoryType) return "记忆";
  return MEMORY_TYPE_LABELS[memoryType] ?? memoryType;
}

/** 资料同步来源类型（source_type）→ 中文。 */
const SOURCE_TYPE_LABELS: Record<string, string> = {
  canvas: "在线课程平台",
  generic: "网页链接",
  url: "网页链接",
  file: "上传文件",
  pdf: "PDF 文档",
  manual: "手动创建",
};

export function getSourceTypeLabel(sourceType: string | null | undefined): string {
  if (!sourceType) return "其他来源";
  return SOURCE_TYPE_LABELS[sourceType] ?? sourceType;
}
