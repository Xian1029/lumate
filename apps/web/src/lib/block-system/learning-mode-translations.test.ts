import { afterEach, describe, expect, it } from "vitest";
import { setLocale, t } from "@/lib/i18n";
import {
  buildLayoutFromMode,
  LEARNING_MODE_LIST,
  LEARNING_MODE_TRANSLATION_KEYS,
} from "./templates";

describe("learning mode translations", () => {
  afterEach(() => setLocale("zh"));

  it("offers exactly three modes and excludes retired maintenance mode", () => {
    expect(LEARNING_MODE_LIST.map((mode) => mode.id)).toEqual([
      "course_following", "self_paced", "exam_prep",
    ]);
  });

  it("has localized labels, descriptions, and badges for every mode", () => {
    for (const locale of ["en", "zh"] as const) {
      setLocale(locale);
      for (const mode of LEARNING_MODE_LIST) {
        const keys = LEARNING_MODE_TRANSLATION_KEYS[mode.id];
        expect(t(keys.label)).not.toBe(keys.label);
        expect(t(keys.description)).not.toBe(keys.description);
        expect(t(keys.badge)).not.toBe(keys.badge);
      }
    }
  });

  it("keeps persisted mode IDs and generated layouts unchanged across locales", () => {
    for (const mode of LEARNING_MODE_LIST) {
      setLocale("zh");
      const chineseLayout = buildLayoutFromMode(mode.id);
      setLocale("en");
      const englishLayout = buildLayoutFromMode(mode.id);

      expect(englishLayout).toEqual(chineseLayout);
      expect(englishLayout.mode).toBe(mode.id);
    }
  });

  it("includes notes and a plan in exam preparation mode", () => {
    const types = buildLayoutFromMode("exam_prep").blocks.map((block) => block.type);
    expect(types).toContain("notes");
    expect(types).toContain("plan");
    expect(types.indexOf("notes")).toBeLessThan(types.indexOf("quiz"));
  });
});
