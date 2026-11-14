// Per-item "how much of it did I actually eat" scaling.
//
// A photo often shows several items (or a shared table) that get eaten in
// different amounts — all the chicken, half the rice. Instead of typing that
// into a note and re-running the analysis, each analyzed item gets a fraction
// and the totals are rescaled locally.

export type Macros = { calories: number; protein_g: number; fat_g: number; carbs_g: number };

export type PortionItem = Macros & { name: string; portion: string };

export const PORTION_STEPS = [0, 0.25, 0.5, 0.75, 1] as const;

const MACRO_KEYS = ["calories", "protein_g", "fat_g", "carbs_g"] as const;

/**
 * Rescale the analysis totals by per-item fractions. Each macro is scaled by
 * the share of that macro the user actually ate, so all-1 fractions return
 * the model's totals exactly (they don't always equal the item sum). A macro
 * with no per-item breakdown falls back to the mean fraction.
 */
export function applyPortions(total: Macros, items: Macros[], fractions: number[]): Macros {
  const mean = fractions.length
    ? fractions.reduce((a, b) => a + b, 0) / fractions.length
    : 1;
  const out = { ...total };
  for (const k of MACRO_KEYS) {
    const full = items.reduce((a, it) => a + (it[k] || 0), 0);
    const eaten = items.reduce((a, it, i) => a + (it[k] || 0) * (fractions[i] ?? 1), 0);
    const ratio = full > 0 ? eaten / full : mean;
    out[k] = Math.round(total[k] * ratio * 10) / 10;
  }
  return out;
}

/** Items as they should be stored: macros scaled to what was eaten, with the
 *  fraction recorded whenever it isn't the whole thing. */
export function itemsWithPortions<T extends Macros>(items: T[], fractions: number[]): (T & { eaten_fraction?: number })[] {
  return items.map((it, i) => {
    const f = fractions[i] ?? 1;
    if (f === 1) return it;
    const scaled = { ...it, eaten_fraction: f };
    for (const k of MACRO_KEYS) scaled[k] = Math.round((it[k] || 0) * f * 10) / 10;
    return scaled;
  });
}

export function fullPortions(n: number): number[] {
  return Array(n).fill(1);
}

function sumMacros(items: Macros[]): Macros {
  const out: Macros = { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 };
  for (const it of items) for (const k of MACRO_KEYS) out[k] += it[k] || 0;
  return out;
}

/**
 * Swap items[index] for its corrected replacement(s). The total moves by the
 * difference only, so whatever the rest of the meal was worth — including any
 * gap between the model's total and its item sum — is left exactly as it was.
 * Replacements inherit the old item's eaten fraction.
 */
export function replaceItem<T extends Macros>(
  items: T[],
  total: Macros,
  fractions: number[],
  index: number,
  replacement: T[],
): { items: T[]; total: Macros; fractions: number[] } {
  const before = sumMacros([items[index]]);
  const after = sumMacros(replacement);
  const nextTotal = { ...total };
  for (const k of MACRO_KEYS) {
    nextTotal[k] = Math.max(0, Math.round((total[k] - before[k] + after[k]) * 10) / 10);
  }
  const f = fractions[index] ?? 1;
  return {
    items: [...items.slice(0, index), ...replacement, ...items.slice(index + 1)],
    total: nextTotal,
    fractions: [
      ...fractions.slice(0, index),
      ...replacement.map(() => f),
      ...fractions.slice(index + 1),
    ],
  };
}

/** Inverse of `itemsWithPortions`: a saved meal's items back at full portion,
 *  with their fractions. An item saved at 0 has lost its macros, so it comes
 *  back as a zero-calorie item. */
export function storedItemsToPortions(stored: unknown): { items: PortionItem[]; fractions: number[] } | null {
  if (!Array.isArray(stored) || stored.length === 0) return null;
  const items: PortionItem[] = [];
  const fractions: number[] = [];
  for (const raw of stored) {
    // Shortcut rows (protein shake, creatine) aren't food breakdowns.
    if (!raw || typeof raw.name !== "string" || typeof raw.calories !== "number") return null;
    const f = typeof raw.eaten_fraction === "number" ? raw.eaten_fraction : 1;
    const it: PortionItem = {
      name: raw.name,
      portion: String(raw.portion ?? ""),
      calories: 0,
      protein_g: 0,
      fat_g: 0,
      carbs_g: 0,
    };
    for (const k of MACRO_KEYS) {
      const v = Number(raw[k]) || 0;
      it[k] = f > 0 ? Math.round((v / f) * 10) / 10 : 0;
    }
    items.push(it);
    fractions.push(f);
  }
  return { items, fractions };
}

/** Macros actually eaten across items at the given fractions. */
export function eatenTotal(items: Macros[], fractions: number[]): Macros {
  return sumMacros(itemsWithPortions(items, fractions));
}
