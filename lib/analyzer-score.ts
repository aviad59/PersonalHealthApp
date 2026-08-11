// Pure scoring for the analyzer eval harness. Given the model's predicted
// macros and the fixture's ground-truth macros, compute per-macro error and
// aggregate accuracy. Kept free of any I/O so it's trivial to reason about
// and could be unit-tested in isolation.

export type Macros = {
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
};

export const MACRO_KEYS = ["calories", "protein_g", "fat_g", "carbs_g"] as const;
export type MacroKey = (typeof MACRO_KEYS)[number];

// Matches the "within 15% = on track" threshold the coach prompts already use.
export const DEFAULT_WITHIN_PCT = 15;

export type MacroScore = {
  key: MacroKey;
  predicted: number;
  expected: number;
  absError: number;
  /** Percent error vs the expected value (0–∞). */
  pctError: number;
  within: boolean;
};

export type FixtureScore = {
  fixtureId: string;
  label: string;
  expected: Macros;
  predicted: Macros | null;
  macros: MacroScore[];
  /** True when every macro is within the threshold. */
  passed: boolean;
  confidence?: string | null;
  latencyMs?: number;
  usage?: { input_tokens: number; output_tokens: number };
  /** Set when this fixture failed to analyze/parse rather than scoring. */
  error?: string;
};

function pctError(predicted: number, expected: number): number {
  if (expected === 0) return predicted === 0 ? 0 : 100;
  return (Math.abs(predicted - expected) / expected) * 100;
}

/** Score one prediction against expected totals. */
export function scoreMacros(
  predicted: Macros,
  expected: Macros,
  withinPct: number = DEFAULT_WITHIN_PCT,
): MacroScore[] {
  return MACRO_KEYS.map((key) => {
    const p = Number(predicted[key]) || 0;
    const e = Number(expected[key]) || 0;
    const pe = pctError(p, e);
    return {
      key,
      predicted: p,
      expected: e,
      absError: Math.abs(p - e),
      pctError: pe,
      within: pe <= withinPct,
    };
  });
}

export type PerMacroAggregate = {
  /** Fraction (0–1) of fixtures within the threshold for this macro. */
  withinRate: number;
  /** Mean absolute percent error for this macro. */
  mape: number;
  /** Mean absolute error (in the macro's own units). */
  mae: number;
};

export type Aggregate = {
  n: number;
  scored: number;
  errored: number;
  perMacro: Record<MacroKey, PerMacroAggregate>;
  /** Fraction of scored fixtures that passed on every macro. */
  passRate: number;
};

/** Aggregate a set of fixture scores into headline accuracy numbers. */
export function aggregate(scores: FixtureScore[]): Aggregate {
  const scored = scores.filter((s) => s.predicted && !s.error);
  const errored = scores.length - scored.length;

  const perMacro = {} as Record<MacroKey, PerMacroAggregate>;
  for (const key of MACRO_KEYS) {
    const cells = scored
      .map((s) => s.macros.find((m) => m.key === key))
      .filter((m): m is MacroScore => !!m);
    const n = cells.length || 1;
    perMacro[key] = {
      withinRate: cells.filter((c) => c.within).length / n,
      mape: cells.reduce((a, c) => a + c.pctError, 0) / n,
      mae: cells.reduce((a, c) => a + c.absError, 0) / n,
    };
  }

  return {
    n: scores.length,
    scored: scored.length,
    errored,
    perMacro,
    passRate: scored.length
      ? scored.filter((s) => s.passed).length / scored.length
      : 0,
  };
}
