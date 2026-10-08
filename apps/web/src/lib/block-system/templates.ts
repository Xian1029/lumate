import { defaultBlockSource, type BlockInstance, type SpaceLayout, type BlockType, type BlockSize, type LearningMode } from "./types";

/** Helper to create a block instance for template definitions. */
function b(
  type: BlockType,
  size: BlockSize,
  config: Record<string, unknown> = {},
  position = 0,
): Omit<BlockInstance, "id"> & { id: string } {
  return {
    id: "", // will be assigned at apply time
    type,
    position,
    size,
    config,
    isVisible: true,
    isPinned: false,
    source: defaultBlockSource(type),
  };
}

export interface TemplateDefinition {
  id: string;
  /** Translation keys are resolved by the consuming screen at render time. */
  nameKey: string;
  descriptionKey: string;
  /** Default learning mode attached to this template. */
  defaultMode: LearningMode;
  blocks: Array<Omit<BlockInstance, "id"> & { id: string }>;
  columns: 1 | 2 | 3;
}

export const TEMPLATES: Record<string, TemplateDefinition> = {
  stem_student: {
    id: "stem_student",
    nameKey: "ui.tpl_stem",
    descriptionKey: "ui.tpl_step",
    defaultMode: "course_following",
    columns: 2,
    blocks: [
      b("chapter_list", "full", {}),
      b("notes", "full", { note_format: "step_by_step" }),
      b("progress", "full"),
      b("quiz", "medium", { difficulty: "adaptive" }),
      b("knowledge_graph", "medium"),
      b("forecast", "full"),
    ],
  },
  humanities_scholar: {
    id: "humanities_scholar",
    nameKey: "ui.tpl_humanities",
    descriptionKey: "ui.tpl_narrative",
    defaultMode: "course_following",
    columns: 2,
    blocks: [
      b("chapter_list", "full"),
      b("notes", "full", { note_format: "summary" }),
      b("progress", "full"),
      b("review", "medium"),
      b("knowledge_graph", "full"),
      b("forecast", "full"),
    ],
  },
  visual_learner: {
    id: "visual_learner",
    nameKey: "ui.tpl_visual_learner",
    descriptionKey: "ui.tpl_visual",
    defaultMode: "self_paced",
    columns: 2,
    blocks: [
      b("chapter_list", "full"),
      b("notes", "full", { note_format: "mind_map" }),
      b("progress", "full"),
      b("knowledge_graph", "large"),
      b("quiz", "medium", { difficulty: "adaptive" }),
      b("forecast", "full"),
    ],
  },
  quick_reviewer: {
    id: "quick_reviewer",
    nameKey: "ui.tpl_quick_reviewer",
    descriptionKey: "ui.tpl_quiz",
    defaultMode: "exam_prep",
    columns: 2,
    blocks: [
      b("chapter_list", "full"),
      b("notes", "full"),
      b("progress", "full"),
      b("quiz", "large", { difficulty: "hard" }),
      b("flashcards", "medium"),
      b("wrong_answers", "medium"),
      b("knowledge_graph", "full"),
      b("forecast", "full"),
    ],
  },
  blank_canvas: {
    id: "blank_canvas",
    nameKey: "ui.tpl_blank",
    descriptionKey: "ui.tpl_scratch",
    defaultMode: "self_paced",
    columns: 2,
    blocks: [],
  },
};

const TEMPLATE_DISPLAY_ORDER = [
  "stem_student",
  "humanities_scholar",
  "visual_learner",
  "quick_reviewer",
  "blank_canvas",
] as const;

/** Templates shown in onboarding/template picker. */
export const TEMPLATE_LIST = TEMPLATE_DISPLAY_ORDER.map((id) => TEMPLATES[id]);

// ── Learning Mode Definitions ──

export interface LearningModeDefinition {
  id: LearningMode;
  icon: string;
  /** Default block layout for this mode. */
  blocks: Array<Omit<BlockInstance, "id"> & { id: string }>;
  columns: 1 | 2 | 3;
}

/**
 * Resolve display copy at render time. The stable mode ID is what gets saved
 * with a course, so a language change never changes behavior or layout.
 */
export const LEARNING_MODE_TRANSLATION_KEYS: Record<
  LearningMode,
  { label: string; description: string; badge: string }
> = {
  course_following: { label: "mode.course_following", description: "mode.course_following.desc", badge: "mode.badge.course_following" },
  self_paced: { label: "mode.self_paced", description: "mode.self_paced.desc", badge: "mode.badge.self_paced" },
  exam_prep: { label: "mode.exam_prep", description: "mode.exam_prep.desc", badge: "mode.badge.exam_prep" },
  maintenance: { label: "mode.maintenance", description: "mode.maintenance.desc", badge: "mode.badge.maintenance" },
};

export const LEARNING_MODES: Record<LearningMode, LearningModeDefinition> = {
  course_following: {
    id: "course_following",
    icon: "GraduationCap",
    columns: 2,
    blocks: [
      b("chapter_list", "full"),
      b("notes", "full"),
      b("progress", "full"),
      b("quiz", "medium"),
      b("flashcards", "medium"),
      b("knowledge_graph", "full"),
      b("forecast", "full"),
    ],
  },
  self_paced: {
    id: "self_paced",
    icon: "Compass",
    columns: 2,
    blocks: [
      b("chapter_list", "full"),
      b("notes", "full"),
      b("progress", "full"),
      b("flashcards", "full"),
      b("knowledge_graph", "full"),
      b("forecast", "full"),
    ],
  },
  exam_prep: {
    id: "exam_prep",
    icon: "Clock",
    columns: 2,
    blocks: [
      b("chapter_list", "full"),
      b("notes", "full", { note_format: "summary", purpose: "exam_review" }),
      b("quiz", "large", { difficulty: "hard" }),
      b("progress", "full"),
      b("plan", "full"),
      b("knowledge_graph", "full"),
      b("forecast", "full"),
    ],
  },
  maintenance: {
    id: "maintenance",
    icon: "Shield",
    columns: 2,
    blocks: [
      b("chapter_list", "full"),
      b("review", "large"),
      b("flashcards", "medium"),
      b("progress", "full"),
      b("knowledge_graph", "full"),
      b("forecast", "full"),
    ],
  },
};

/** User-selectable modes. Maintenance remains only for legacy data migration. */
export const LEARNING_MODE_LIST = Object.values(LEARNING_MODES).filter(
  (mode) => mode.id !== "maintenance",
);

/** Generate a SpaceLayout from a template, assigning unique IDs and positions. */
export function buildLayoutFromTemplate(templateId: string): SpaceLayout | null {
  const template = TEMPLATES[templateId];
  if (!template) return null;

  const blocks: BlockInstance[] = template.blocks.map((block, index) => ({
    ...block,
    id: `${templateId}-${block.type}-${index}`,
    position: index,
  }));

  return {
    templateId,
    blocks,
    columns: template.columns,
    mode: template.defaultMode,
  };
}

/** Generate a SpaceLayout from a learning mode, assigning unique IDs and positions. */
export function buildLayoutFromMode(mode: LearningMode): SpaceLayout {
  const effectiveMode: LearningMode = mode === "maintenance" ? "self_paced" : mode;
  const def = LEARNING_MODES[effectiveMode];
  const blocks: BlockInstance[] = def.blocks.map((block, index) => ({
    ...block,
    id: `mode-${effectiveMode}-${block.type}-${index}`,
    position: index,
  }));

  return {
    templateId: null,
    blocks,
    columns: def.columns,
    mode: effectiveMode,
  };
}
