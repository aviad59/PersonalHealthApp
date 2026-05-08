"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { type Lang, readLangCookie } from "@/lib/i18n";

const LangContext = createContext<Lang>("en");

export function useLang(): Lang {
  return useContext(LangContext);
}

export default function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = useState<Lang>("en");

  useEffect(() => {
    const l = readLangCookie();
    setLang(l);
    document.documentElement.lang = l;
    document.documentElement.dir = l === "he" ? "rtl" : "ltr";
  }, []);

  useEffect(() => {
    function onLangChange(e: Event) {
      const l = (e as CustomEvent<Lang>).detail;
      setLang(l);
      document.documentElement.lang = l;
      document.documentElement.dir = l === "he" ? "rtl" : "ltr";
    }
    window.addEventListener("langchange", onLangChange);
    return () => window.removeEventListener("langchange", onLangChange);
  }, []);

  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}
