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

// ---------------------------------------------------------------
// Accuracy vs ground truth (fixtures imported from Nutrition5k)
// ---------------------------------------------------------------

// "Within 15%" matches the tolerance the coach prompts already treat as
// on-target, so the harness and the app judge closeness the same way.
export const DEFAULT_WITHIN_PCT = 15;

// Percent error explodes when the true value is near zero: a dish with 0.2 g of
// fat scores a 100% miss for being 0.2 g out, which is nutritionally
// meaningless but dominates any average. Macros below these floors are still
// reported but excluded from scoring.
export const MACRO_FLOORS: Record<MacroKey, number> = {
  calories: 40, // kcal
  protein_g: 4, // g
  fat_g: 4,
  carbs_g: 4,
};

export type MacroAccuracy = {
  predicted: number;
  expected: number;
  /** Signed error: positive = the model over-estimated. */
  error: number;
  /** Absolute percent error vs the expected value. */
  pctError: number;
  within: boolean;
  /** False when the true value is too small for percent error to be meaningful. */
  scored: boolean;
};

export type MassAccuracy = {
  predicted: number;
  expected: number;
  error: number;
  pctError: number;
  within: boolean;
};

export type CellAccuracy = {
  perMacro: Record<MacroKey, MacroAccuracy>;
  /** Mean absolute percent error across the SCORED macros. */
  mape: number;
  /** True when every scored macro lands inside the tolerance. */
  passed: boolean;
  /**
   * Total-mass accuracy — the Nutrition5k paper's key diagnostic. Comparing it
   * against the calorie error separates "saw the wrong portion" from "used the
   * wrong nutrient density".
   */
  mass: MassAccuracy | null;
};

/**
 * Score a cell's MEAN prediction (averaged over the repeats) against the
 * fixture's known macros. Using the mean rather than a single run separates
 * accuracy from run-to-run jitter, which `summarizeCell` reports separately.
 */
export function scoreAgainstTruth(
  summary: CellSummary,
  expected: Macros,
  withinPct: number = DEFAULT_WITHIN_PCT,
  mass?: { predicted: number; expected: number } | null,
): CellAccuracy {
  const perMacro = {} as Record<MacroKey, MacroAccuracy>;
  for (const key of MACRO_KEYS) {
    const p = summary.perMacro[key].mean;
    const e = Number(expected[key]) || 0;
    const pctError = e === 0 ? (p === 0 ? 0 : 100) : (Math.abs(p - e) / e) * 100;
    perMacro[key] = {
      predicted: p,
      expected: e,
      error: p - e,
      pctError,
      within: pctError <= withinPct,
      scored: e >= MACRO_FLOORS[key],
    };
  }

  const scoredKeys = MACRO_KEYS.filter((k) => perMacro[k].scored);
  const mape = scoredKeys.length
    ? scoredKeys.reduce((a, k) => a + perMacro[k].pctError, 0) / scoredKeys.length
    : 0;

  let massAcc: MassAccuracy | null = null;
  if (mass && mass.expected > 0 && mass.predicted > 0) {
    const pctError = (Math.abs(mass.predicted - mass.expected) / mass.expected) * 100;
    massAcc = {
      predicted: mass.predicted,
      expected: mass.expected,
      error: mass.predicted - mass.expected,
      pctError,
      within: pctError <= withinPct,
    };
  }

  return {
    perMacro,
    mape,
    passed: scoredKeys.length > 0 && scoredKeys.every((k) => perMacro[k].within),
    mass: massAcc,
  };
}

/** Roll several scored cells (one model across many dishes) into headline numbers. */
export function aggregateAccuracy(cells: CellAccuracy[]): {
  n: number;
  passRate: number;
  mape: number;
  perMacro: Record<
    MacroKey,
    { withinRate: number; mape: number; bias: number; n: number }
  >;
  mass: { withinRate: number; mape: number; bias: number; n: number } | null;
} {
  const n = cells.length;
  const perMacro = {} as Record<
    MacroKey,
    { withinRate: number; mape: number; bias: number; n: number }
  >;
  for (const key of MACRO_KEYS) {
    // Only macros above the floor count — see MACRO_FLOORS.
    const cs = cells.map((c) => c.perMacro[key]).filter((c) => c.scored);
    const d = cs.length || 1;
    perMacro[key] = {
      withinRate: cs.filter((c) => c.within).length / d,
      mape: cs.reduce((a, c) => a + c.pctError, 0) / d,
      // Mean signed error — reveals a systematic over/under-estimate.
      bias: cs.reduce((a, c) => a + c.error, 0) / d,
      n: cs.length,
    };
  }

  const masses = cells.map((c) => c.mass).filter((m): m is MassAccuracy => !!m);
  const md = masses.length || 1;

  return {
    n,
    passRate: n ? cells.filter((c) => c.passed).length / n : 0,
    mape: n ? cells.reduce((a, c) => a + c.mape, 0) / n : 0,
    perMacro,
    mass: masses.length
      ? {
          withinRate: masses.filter((m) => m.within).length / md,
          mape: masses.reduce((a, m) => a + m.pctError, 0) / md,
          bias: masses.reduce((a, m) => a + m.error, 0) / md,
          n: masses.length,
        }
      : null,
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
