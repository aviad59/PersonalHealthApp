"use client";

import { t, Lang } from "@/lib/i18n";
import { PORTION_STEPS, type PortionItem } from "@/lib/portions";

const STEP_LABEL: Record<number, string> = { 0: "0", 0.25: "¼", 0.5: "½", 0.75: "¾" };

/** Analyzed items, each with one-tap "how much did I eat" chips. The parent
 *  owns the fractions and rescales its totals with `applyPortions`. */
export default function ItemPortions({
  items,
  fractions,
  onChange,
  lang,
  disabled,
  compact,
}: {
  items: PortionItem[];
  fractions: number[];
  onChange: (next: number[]) => void;
  lang: Lang;
  disabled?: boolean;
  /** Smaller type for the batch / inbox cards. */
  compact?: boolean;
}) {
  if (!items?.length) return null;
  const text = compact ? "text-[12px]" : "text-[13px]";
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
              <span className="shrink-0 nums">{Math.round(it.calories * f)} {t(lang, "macro_kcal")}</span>
            </div>
            <div className="flex gap-1.5 mt-1.5">
              {PORTION_STEPS.map((step) => (
                <button
                  key={step}
                  type="button"
                  disabled={disabled}
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
          </li>
        );
      })}
    </ul>
  );
}
