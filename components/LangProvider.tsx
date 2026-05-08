"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { type Lang, type TextSize, readLangCookie, readTextSizeCookie, applyTextSize } from "@/lib/i18n";

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

    applyTextSize(readTextSizeCookie());
  }, []);

  useEffect(() => {
    function onLangChange(e: Event) {
      const l = (e as CustomEvent<Lang>).detail;
      setLang(l);
      document.documentElement.lang = l;
      document.documentElement.dir = l === "he" ? "rtl" : "ltr";
    }
    function onTextSizeChange(e: Event) {
      applyTextSize((e as CustomEvent<TextSize>).detail);
    }
    window.addEventListener("langchange", onLangChange);
    window.addEventListener("textsizechange", onTextSizeChange);
    return () => {
      window.removeEventListener("langchange", onLangChange);
      window.removeEventListener("textsizechange", onTextSizeChange);
    };
  }, []);

  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}
