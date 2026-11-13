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
