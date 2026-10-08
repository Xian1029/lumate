type Translate = (key: string) => string;

const QUESTION_TYPE_KEYS: Record<string, string> = {
  unknown: "ui.question_type_unknown",
  mc: "ui.question_type_multiple_choice",
  multiple_choice: "ui.question_type_multiple_choice",
  single_choice: "ui.question_type_multiple_choice",
  select_all: "ui.question_type_select_all",
  multiple_select: "ui.question_type_select_all",
  true_false: "ui.question_type_true_false",
  short_answer: "ui.question_type_short_answer",
  fill_blank: "ui.question_type_fill_blank",
  fill_in_the_blank: "ui.question_type_fill_blank",
  coding: "ui.question_type_coding",
  code: "ui.question_type_coding",
  matching: "ui.question_type_matching",
  numeric: "ui.question_type_numeric",
  calculation: "ui.question_type_numeric",
  essay: "ui.question_type_essay",
};

export function questionTypeLabel(value: string | null | undefined, translate: Translate): string {
  const normalized = (value || "unknown")
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s-]+/g, "_");
  const key = QUESTION_TYPE_KEYS[normalized] ?? "ui.question_type_unknown";
  return translate(key);
}
