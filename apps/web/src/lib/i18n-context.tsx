"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { type Locale, setLocale as setI18nLocale, t as rawT, tf as rawTF } from "./i18n";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
  tf: (key: string, vars?: Record<string, string | number | null | undefined>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("zh");

  useEffect(() => {
    // Only Chinese is exposed by the current product. Normalize preferences
    // from older builds so all screens and API requests use one locale.
    setI18nLocale("zh");
    document.documentElement.lang = "zh-CN";
    setLocaleState("zh");
  }, []);

  const setLocale = useCallback((_newLocale: Locale) => {
    setI18nLocale("zh");
    document.documentElement.lang = "zh-CN";
    setLocaleState("zh");
  }, []);

  const t = useCallback(
    (key: string) => rawT(key),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale],
  );
  const tf = useCallback(
    (key: string, vars?: Record<string, string | number | null | undefined>) => rawTF(key, vars),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale],
  );

  // Some older screens call the raw `t()` helper rather than subscribing to this
  // context. Remounting this presentation boundary makes those screens evaluate
  // their copy again, without changing any persisted workspace or course state.
  return (
    <I18nContext.Provider value={{ locale, setLocale, t, tf }}>
      <div key={locale}>{children}</div>
    </I18nContext.Provider>
  );
}

export function useT() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used inside <LocaleProvider>");
  return ctx.t;
}

export function useLocale() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useLocale must be used inside <LocaleProvider>");
  return { locale: ctx.locale, setLocale: ctx.setLocale };
}

export function useTF() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useTF must be used inside <LocaleProvider>");
  return ctx.tf;
}
