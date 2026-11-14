"use client";

import { useState } from "react";
import { t, Lang } from "@/lib/i18n";
import { PORTION_STEPS, type PortionItem } from "@/lib/portions";

const STEP_LABEL: Record<number, string> = { 0: "0", 0.25: "¼", 0.5: "½", 0.75: "¾" };

/** Analyzed items, each with one-tap "how much did I eat" chips. The parent
 *  owns the fractions and rescales its totals with `applyPortions`. With
 *  `onFix`, each item also gets a "fix" prompt so one misread food can be
 *  corrected without re-running the whole meal. */
export default function ItemPortions({
  items,
  fractions,
  onChange,
  onFix,
  lang,
  disabled,
  compact,
}: {
  items: PortionItem[];
  fractions: number[];
  onChange: (next: number[]) => void;
  /** Re-cost item `index` from the user's correction; rejects on failure. */
  onFix?: (index: number, prompt: string) => Promise<void>;
  lang: Lang;
  disabled?: boolean;
  /** Smaller type for the batch / inbox cards. */
  compact?: boolean;
}) {
  const [fixOpen, setFixOpen] = useState<number | null>(null);
  const [fixText, setFixText] = useState("");
  const [fixBusy, setFixBusy] = useState(false);
  const [fixErr, setFixErr] = useState<string | null>(null);

  if (!items?.length) return null;
  const text = compact ? "text-[12px]" : "text-[13px]";
  const locked = disabled || fixBusy;

  function openFix(i: number) {
    setFixOpen(fixOpen === i ? null : i);
    setFixText("");
    setFixErr(null);
  }

  async function submitFix(i: number) {
    if (!onFix || !fixText.trim() || fixBusy) return;
    setFixBusy(true);
    setFixErr(null);
    try {
      await onFix(i, fixText.trim());
      setFixOpen(null);
      setFixText("");
    } catch (e: any) {
      setFixErr(e?.message ?? "fix failed");
    } finally {
      setFixBusy(false);
    }
  }

  return (
    <ul className={`${text} text-ink/70 space-y-2 mt-2`}>
      {items.map((it, i) => {
        const f = fractions[i] ?? 1;
        return (
          <li key={i} className={f === 0 ? "opacity-50" : ""}>
            <div className="flex justify-between gap-2">
              <span className="min-w-0" dir={/[֐-׿]/.test(it.name) ? "rtl" : "ltr"}>
                {it.name} <span className="text-ink/40">({it.portion})</span>
              </span>
              <span className="shrink-0 flex items-center gap-2">
                <span className="nums">{Math.round(it.calories * f)} {t(lang, "macro_kcal")}</span>
                {onFix && (
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => openFix(i)}
                    aria-label={t(lang, "meal_item_fix")}
                    className={`text-[11px] disabled:opacity-40 ${fixOpen === i ? "text-ink" : "text-accent-brand"}`}
                  >
                    {t(lang, "meal_item_fix")}
                  </button>
                )}
              </span>
            </div>
            <div className="flex gap-1.5 mt-1.5">
              {PORTION_STEPS.map((step) => (
                <button
                  key={step}
                  type="button"
                  disabled={locked}
                  onClick={() => onChange(fractions.map((x, j) => (j === i ? step : x)))}
                  aria-pressed={f === step}
                  className={`h-8 min-w-[2.5rem] rounded-full border px-2.5 text-[12px] disabled:opacity-40 transition-colors ${
                    f === step
                      ? "border-accent-brand bg-accent-brand/20 text-ink font-semibold"
                      : "border-border bg-bg-elev text-ink/55"
                  }`}
                >
                  {step === 1 ? t(lang, "meal_portion_all") : STEP_LABEL[step]}
                </button>
              ))}
            </div>
            {fixOpen === i && (
              <div className="mt-1.5 space-y-1">
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    autoFocus
                    value={fixText}
                    onChange={(e) => setFixText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) submitFix(i);
                      if (e.key === "Escape") setFixOpen(null);
                    }}
                    dir={fixText ? (/[֐-׿]/.test(fixText) ? "rtl" : "ltr") : lang === "he" ? "rtl" : "ltr"}
                    placeholder={t(lang, "meal_item_fix_placeholder")}
                    disabled={disabled || fixBusy}
                    className="flex-1 min-w-0 rounded-lg bg-bg-elev border border-border px-2.5 py-1.5 text-[12px] focus:outline-none focus:border-ink/30"
                  />
                  <button
                    type="button"
                    onClick={() => submitFix(i)}
                    disabled={disabled || fixBusy || !fixText.trim()}
                    className="rounded-lg bg-accent-brand px-3 py-1.5 text-[12px] font-semibold text-on-brand disabled:opacity-40"
                  >
                    {fixBusy ? "…" : t(lang, "meal_clarify_update")}
                  </button>
                </div>
                {fixErr && <div className="text-[11px] text-bad">{fixErr}</div>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
