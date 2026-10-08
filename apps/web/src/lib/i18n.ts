import en from "@/locales/en.json";
import zh from "@/locales/zh.json";

export type Locale = "en" | "zh";

const SUPPORTED_LOCALES: Locale[] = ["en", "zh"];
const LOCALE_STORAGE_KEY = "opentutor-locale";
// Kept for users of earlier builds that stored the same preference under this key.
const LEGACY_LOCALE_STORAGE_KEY = "opentutor_locale";

const translations: Record<Locale, Record<string, string>> = { en, zh };

let currentLocale: Locale = "zh";

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
      localStorage.removeItem(LEGACY_LOCALE_STORAGE_KEY);
    } catch { /* quota */ }
  }
}

function systemLocale(): Locale {
  if (typeof navigator === "undefined") return "zh";
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function savedLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  const saved = (localStorage.getItem(LOCALE_STORAGE_KEY)
    ?? localStorage.getItem(LEGACY_LOCALE_STORAGE_KEY)) as Locale | null;
  return saved && SUPPORTED_LOCALES.includes(saved) ? saved : null;
}

export function getLocale(): Locale {
  currentLocale = savedLocale() ?? systemLocale();
  return currentLocale;
}

export function t(key: string): string {
  return translations[currentLocale]?.[key] ?? translations.en[key] ?? key;
}

export function tf(
  key: string,
  vars?: Record<string, string | number | null | undefined>,
): string {
  let message = t(key);
  if (!vars) return message;
  for (const [name, value] of Object.entries(vars)) {
    const token = `{${name}}`;
    message = message.split(token).join(value == null ? "" : String(value));
  }
  return message;
}

export function initLocale(): void {
  currentLocale = savedLocale() ?? systemLocale();
}
