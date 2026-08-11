// Consistency stats for the analyzer lab. Instead of scoring the model against
// a (hard-to-obtain) ground truth, we run the SAME meal several times and
// measure how much its macro estimates jitter. Low variability = the analyzer
// is stable/reliable; high variability = it's essentially guessing. All pure
// math, no I/O.

export type Macros = {
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
};

export const MACRO_KEYS = ["calories", "protein_g", "fat_g", "carbs_g"] as const;
export type MacroKey = (typeof MACRO_KEYS)[number];

/** One analysis attempt for a (fixture, model) cell. */
export type RunAttempt = {
  predicted: Macros | null;
  confidence: string | null;
  latencyMs: number;
  error?: string;
};

export type MacroStat = {
  mean: number;
  std: number;
  /** Coefficient of variation: std / mean, as a percent. The headline
   *  "jitter" number — comparable across macros of different magnitudes. */
  cv: number;
  min: number;
  max: number;
};

export type CellSummary = {
  okRuns: number;
  failedRuns: number;
  meanLatencyMs: number;
  perMacro: Record<MacroKey, MacroStat>;
  confidences: Record<string, number>;
  /** Mean CV across the four macros — a single "how stable" score (lower = better). */
  avgCv: number;
};

function stat(values: number[]): MacroStat {
  if (values.length === 0) return { mean: 0, std: 0, cv: 0, min: 0, max: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  const cv = mean === 0 ? 0 : (std / mean) * 100;
  return {
    mean,
    std,
    cv,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** Reduce a set of repeated attempts into per-macro variability stats. */
export function summarizeCell(attempts: RunAttempt[]): CellSummary {
  const ok = attempts.filter((a) => a.predicted && !a.error);

  const perMacro = {} as Record<MacroKey, MacroStat>;
  for (const key of MACRO_KEYS) {
    perMacro[key] = stat(ok.map((a) => Number(a.predicted![key]) || 0));
  }

  const confidences: Record<string, number> = {};
  for (const a of ok) {
    const c = a.confidence || "unknown";
    confidences[c] = (confidences[c] || 0) + 1;
  }

  const avgCv =
    MACRO_KEYS.reduce((a, k) => a + perMacro[k].cv, 0) / MACRO_KEYS.length;

  return {
    okRuns: ok.length,
    failedRuns: attempts.length - ok.length,
    meanLatencyMs: ok.length
      ? ok.reduce((a, b) => a + b.latencyMs, 0) / ok.length
      : 0,
    perMacro,
    confidences,
    avgCv,
  };
}

/**
 * Cross-model agreement for one fixture: how far apart are the different
 * models' mean calorie estimates, relative to their average? High spread means
 * the models disagree (so at least one is off); low spread is reassuring even
 * without a ground truth.
 */
export function crossModelSpread(
  means: number[],
): { spreadPct: number; min: number; max: number; mean: number } {
  const vals = means.filter((m) => Number.isFinite(m) && m > 0);
  if (vals.length < 2) return { spreadPct: 0, min: 0, max: 0, mean: 0 };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const spreadPct = mean === 0 ? 0 : ((max - min) / mean) * 100;
  return { spreadPct, min, max, mean };
}
