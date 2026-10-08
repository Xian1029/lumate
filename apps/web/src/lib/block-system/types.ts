export type BlockType =
  | "notes"
  | "quiz"
  | "flashcards"
  | "progress"
  | "knowledge_graph"
  | "review"
  | "chapter_list"
  | "plan"
  | "wrong_answers"
  | "forecast"
  | "agent_insight"
  | "summary";

export type BlockSize = "small" | "medium" | "large" | "full";

/** Why this block is present in this workspace.  This is a lifecycle policy,
 * not a visual state: visibility and pinning are stored independently. */
export type BlockSource = "SYSTEM_REQUIRED" | "SYSTEM_OPTIONAL" | "USER_ADDED";
export type LegacyBlockSource = "template" | "user" | "agent";

/** The four learning modes defined in the PRD. */
export type LearningMode = "course_following" | "self_paced" | "exam_prep" | "maintenance";

export interface AgentBlockMeta {
  /** Why the agent added this block */
  reason: string;
  /** Whether user can dismiss */
  dismissible: boolean;
  /** Auto-remove after this ISO date */
  expiresAt?: string;
  /** Second-tier: needs user approval before becoming active */
  needsApproval?: boolean;
  /** CTA button text for approval (e.g. t("ui.add_flashcards")) */
  approvalCta?: string;
}

export interface BlockInstance {
  id: string;
  type: BlockType;
  position: number;
  size: BlockSize;
  config: Record<string, unknown>;
  /** Whether the instance is rendered in the normal workspace grid. */
  isVisible?: boolean;
  /** @deprecated Legacy layout input only; normalized layouts use isVisible. */
  visible?: boolean;
  /** Whether the learner deliberately keeps this instance at the top. */
  isPinned?: boolean;
  /** Legacy values are accepted only at the deserialize boundary. */
  source: BlockSource | LegacyBlockSource;
  agentMeta?: AgentBlockMeta;
}

/** Navigation is structural; all learning tools can be removed and restored. */
/** Structural navigation and the course-grounded AI notes are foundational
 * learning capabilities in every workspace. */
export const SYSTEM_REQUIRED_BLOCK_TYPES: readonly BlockType[] = ["chapter_list", "notes"];

export function defaultBlockSource(type: BlockType): BlockSource {
  return SYSTEM_REQUIRED_BLOCK_TYPES.includes(type) ? "SYSTEM_REQUIRED" : "SYSTEM_OPTIONAL";
}

export function canRemoveBlock(source: BlockSource | LegacyBlockSource): boolean {
  return source !== "SYSTEM_REQUIRED";
}

export interface SpaceLayout {
  templateId: string | null;
  blocks: BlockInstance[];
  columns: 1 | 2 | 3;
  /** When set, this block temporarily occupies the whole learning workspace. */
  focusedBlockId?: string | null;
  /** Active learning mode for this space. */
  mode?: LearningMode;
}
