// Health & nutrition calculations.
// Formulas: Navy body-fat, Mifflin-St Jeor BMR, TDEE (NEAT-only), macro split.

export type Sex = "male" | "female";

// NEAT (non-exercise activity thermogenesis) only.
// Logged workouts add their own kcal on top via the Today endpoint, so this
// multiplier should NOT include planned training.
export type ActivityLevel =
  | "sedentary"
  | "light"
  | "moderate"
  | "active"
  | "very_active";

export const ACTIVITY_MULTIPLIER: Record<ActivityLevel, number> = {
  sedentary: 1.2,    // desk job, mostly seated, little incidental walking
  light: 1.35,       // some walking, light errands, on feet a few hours/day
  moderate: 1.5,     // on feet most of the day, regular walking, light NEAT
  active: 1.65,      // physically demanding job (warehouse, hands-on trades)
  very_active: 1.8,  // very physical labor (construction, agriculture)
};

export const ACTIVITY_LABELS: Record<ActivityLevel, string> = {
  sedentary: "Sedentary — desk job, mostly seated",
  light: "Light — some walking through the day",
  moderate: "Moderate — on your feet most of the day",
  active: "Active — physically demanding job",
  very_active: "Very active — heavy physical labor",
};

// Subtitle clarifying that workouts are counted separately.
export const ACTIVITY_HINT =
  "Pick how active you are OUTSIDE of workouts. Logged workouts add their own calories on top.";

export type GoalMode = "recomp" | "cut" | "bulk" | "maintain";

/**
 * U.S. Navy body-fat formula.
 * Expects measurements in cm.
 * hipsCm is required for female, ignored for male.
 */
export function navyBodyFat(opts: {
  sex: Sex;
  heightCm: number;
  neckCm: number;
  waistCm: number;
  hipsCm?: number | null;
}): number {
  const { sex, heightCm, neckCm, waistCm, hipsCm } = opts;
  if (sex === "male") {
    const bf =
      495 /
        (1.0324 -
          0.19077 * Math.log10(waistCm - neckCm) +
          0.15456 * Math.log10(heightCm)) -
      450;
    return clamp(bf, 3, 60);
  } else {
    if (!hipsCm) throw new Error("hips_cm is required for female body-fat calculation");
    const bf =
      495 /
        (1.29579 -
          0.35004 * Math.log10(waistCm + hipsCm - neckCm) +
          0.221 * Math.log10(heightCm)) -
      450;
    return clamp(bf, 5, 60);
  }
}

/** Mifflin-St Jeor BMR in kcal/day. */
export function mifflinBMR(opts: {
  sex: Sex;
  weightKg: number;
  heightCm: number;
  ageYears: number;
}): number {
  const { sex, weightKg, heightCm, ageYears } = opts;
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  return sex === "male" ? base + 5 : base - 161;
}

/**
 * Katch-McArdle BMR in kcal/day — based purely on lean body mass, so it
 * accounts for muscle mass that Mifflin (weight/height/age only) can't.
 * More accurate for lean/muscular people; less so when body-fat is unknown.
 */
export function katchBMR(leanMassKg: number): number {
  return 370 + 21.6 * leanMassKg;
}

/**
 * Blended BMR: the average of Mifflin-St Jeor and Katch-McArdle. Hedges the
 * weaknesses of each — Mifflin ignores body composition, Katch depends on a
 * body-fat estimate that carries error.
 */
export function blendedBMR(mifflin: number, katch: number): number {
  return (mifflin + katch) / 2;
}

export function tdee(bmr: number, activity: ActivityLevel): number {
  return bmr * ACTIVITY_MULTIPLIER[activity];
}

/**
 * Per-goal energy delta and macro ratios. Protein is set off LEAN mass (so
 * fat mass doesn't inflate the target) and sits at the higher end of the
 * evidence-based range for muscle retention, especially in a deficit.
 */
export const GOAL_PARAMS: Record<
  GoalMode,
  { deltaKcal: number; proteinPerKgLbm: number; fatPerKgBw: number }
> = {
  recomp: { deltaKcal: -200, proteinPerKgLbm: 2.4, fatPerKgBw: 0.9 },
  cut: { deltaKcal: -500, proteinPerKgLbm: 2.6, fatPerKgBw: 0.8 },
  bulk: { deltaKcal: 300, proteinPerKgLbm: 2.2, fatPerKgBw: 1.0 },
  maintain: { deltaKcal: 0, proteinPerKgLbm: 2.2, fatPerKgBw: 0.9 },
};

/**
 * Given TDEE, lean mass (kg), body weight (kg), and goal mode, return
 * personalized macro targets. Protein is derived from lean mass; fat from
 * real body weight; carbs fill the remaining calories.
 */
export function macroTargets(opts: {
  tdee: number;
  leanMassKg: number;
  bodyWeightKg: number;
  goalMode: GoalMode;
}): {
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
} {
  const { tdee, leanMassKg, bodyWeightKg, goalMode } = opts;
  const params = GOAL_PARAMS[goalMode] ?? GOAL_PARAMS.maintain;
  const kcal = tdee + params.deltaKcal;

  const protein_g = Math.round(leanMassKg * params.proteinPerKgLbm);
  const fat_g = Math.round(bodyWeightKg * params.fatPerKgBw);

  const proteinKcal = protein_g * 4;
  const fatKcal = fat_g * 9;
  let carbsKcal = kcal - proteinKcal - fatKcal;
  if (carbsKcal < 0) carbsKcal = 0;
  const carbs_g = Math.round(carbsKcal / 4);

  return {
    calories: Math.round(kcal),
    protein_g,
    fat_g,
    carbs_g,
  };
}

export function weeklyWorkoutTarget(activity: ActivityLevel): {
  sessions: number;
  note: string;
} {
  // Note: this is now NEAT-derived; the user can override via their explicit
  // weekly_workout_target in the profile.
  switch (activity) {
    case "sedentary":
      return {
        sessions: 3,
        note: "3 full-body sessions/week, 10-12 hard sets per muscle group",
      };
    case "light":
      return {
        sessions: 3,
        note: "3 upper/lower sessions, 12-14 hard sets per muscle group",
      };
    case "moderate":
      return {
        sessions: 4,
        note: "4 upper/lower or PPL sessions, 14-18 hard sets per muscle group",
      };
    case "active":
      return {
        sessions: 4,
        note: "4 sessions, 14-18 hard sets — recovery is partly used by your job",
      };
    case "very_active":
      return {
        sessions: 3,
        note: "3 sessions, 12-14 hard sets — heavy job already taxes recovery",
      };
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

/** Convenience: full computed bundle from raw body metrics. */
export function computeGoalsFromMetrics(opts: {
  age: number;
  sex: Sex;
  heightCm: number;
  weightKg: number;
  neckCm: number;
  waistCm: number;
  hipsCm?: number | null;
  activity: ActivityLevel;
  goalMode?: GoalMode;
  /** Optional override: user's preferred workouts/week (1–7). */
  weeklyWorkoutTarget?: number | null;
}) {
  const goalMode: GoalMode = opts.goalMode ?? "recomp";
  const body_fat_pct = navyBodyFat({
    sex: opts.sex,
    heightCm: opts.heightCm,
    neckCm: opts.neckCm,
    waistCm: opts.waistCm,
    hipsCm: opts.hipsCm,
  });
  const lean_mass_kg = opts.weightKg * (1 - body_fat_pct / 100);
  const bmr_mifflin = mifflinBMR({
    sex: opts.sex,
    weightKg: opts.weightKg,
    heightCm: opts.heightCm,
    ageYears: opts.age,
  });
  const bmr_katch = katchBMR(lean_mass_kg);
  // Blend the two BMR models: Mifflin (weight/height/age) + Katch-McArdle
  // (lean mass) so muscle mass is accounted for without over-trusting the
  // body-fat estimate.
  const bmr = blendedBMR(bmr_mifflin, bmr_katch);
  const activity_multiplier = ACTIVITY_MULTIPLIER[opts.activity];
  const tdeeVal = tdee(bmr, opts.activity);
  const macros = macroTargets({
    tdee: tdeeVal,
    leanMassKg: lean_mass_kg,
    bodyWeightKg: opts.weightKg,
    goalMode,
  });
  const params = GOAL_PARAMS[goalMode] ?? GOAL_PARAMS.maintain;
  const wo = weeklyWorkoutTarget(opts.activity);
  const sessions =
    opts.weeklyWorkoutTarget != null && opts.weeklyWorkoutTarget > 0
      ? clamp(Math.round(opts.weeklyWorkoutTarget), 1, 7)
      : wo.sessions;
  return {
    body_fat_pct: Math.round(body_fat_pct * 10) / 10,
    lean_mass_kg: Math.round(lean_mass_kg * 10) / 10,
    bmr: Math.round(bmr),
    tdee: Math.round(tdeeVal),
    goal_mode: goalMode,
    goal_calories: macros.calories,
    goal_protein_g: macros.protein_g,
    goal_fat_g: macros.fat_g,
    goal_carbs_g: macros.carbs_g,
    weekly_workout_target: sessions,
    weekly_volume_note: wo.note,
    // Step-by-step derivation, surfaced on the Profile preview so the user
    // can see how each number was reached.
    breakdown: {
      bmr_mifflin: Math.round(bmr_mifflin),
      bmr_katch: Math.round(bmr_katch),
      bmr_blended: Math.round(bmr),
      activity_multiplier,
      tdee: Math.round(tdeeVal),
      goal_delta_kcal: params.deltaKcal,
      protein_per_kg_lbm: params.proteinPerKgLbm,
      fat_per_kg_bw: params.fatPerKgBw,
      lean_mass_kg: Math.round(lean_mass_kg * 10) / 10,
      body_weight_kg: opts.weightKg,
    },
  };
}

// ---------------------------------------------------------------
// Weight-trend analysis & calorie adjustment suggestion
// ---------------------------------------------------------------

export type WeightEntry = { date: string; weight_kg: number };

export type WeightTrend = {
  count: number;
  earliest: string | null;
  latest: string | null;
  ma7_kg: number | null;
  ma28_kg: number | null;
  slope_kg_per_week: number | null;
  expected_slope_kg_per_week: number; // for the user's goal_mode
  suggestion: {
    delta_kcal: number;
    reason: string;
  } | null;
};

const EXPECTED_SLOPE: Record<GoalMode, number> = {
  cut: -0.5,
  bulk: 0.3,
  recomp: 0,
  maintain: 0,
};

/** Compute trend stats and a calorie-adjustment suggestion. */
export function analyzeWeightTrend(
  entries: WeightEntry[],
  goalMode: GoalMode,
): WeightTrend {
  const sorted = [...entries].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const expected = EXPECTED_SLOPE[goalMode];
  if (sorted.length === 0) {
    return {
      count: 0,
      earliest: null,
      latest: null,
      ma7_kg: null,
      ma28_kg: null,
      slope_kg_per_week: null,
      expected_slope_kg_per_week: expected,
      suggestion: null,
    };
  }

  const last = sorted[sorted.length - 1];
  const first = sorted[0];

  const ma = (n: number): number | null => {
    const slice = sorted.slice(-n);
    if (slice.length < Math.min(3, n)) return null;
    const sum = slice.reduce((s, e) => s + e.weight_kg, 0);
    return Math.round((sum / slice.length) * 10) / 10;
  };

  const ma7 = ma(7);
  const ma28 = ma(28);

  // Linear regression on the last 28 entries (or all if fewer).
  const recent = sorted.slice(-28);
  let slope_kg_per_week: number | null = null;
  if (recent.length >= 7) {
    // x = days since first entry in window, y = weight
    const x0 = dateToMs(recent[0].date);
    const xs = recent.map((e) => (dateToMs(e.date) - x0) / (1000 * 60 * 60 * 24));
    const ys = recent.map((e) => e.weight_kg);
    const meanX = xs.reduce((s, v) => s + v, 0) / xs.length;
    const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - meanX) * (ys[i] - meanY);
      den += (xs[i] - meanX) ** 2;
    }
    if (den > 0) {
      const slopePerDay = num / den;
      slope_kg_per_week = Math.round(slopePerDay * 7 * 100) / 100;
    }
  }

  // Suggestion logic: needs ≥ 3 weeks of data and a meaningful gap.
  let suggestion: WeightTrend["suggestion"] = null;
  if (
    slope_kg_per_week !== null &&
    daysBetween(first.date, last.date) >= 21
  ) {
    const gap = slope_kg_per_week - expected;
    // Threshold: 0.25 kg/week off target = real signal.
    if (Math.abs(gap) >= 0.25) {
      // Roughly 7700 kcal per kg of body weight change.
      // Per-day kcal shift = gap * 7700 / 7 = gap * 1100.
      // Round to nearest 100 and clamp to ±300/day per check-in.
      let delta = -Math.round((gap * 1100) / 100) * 100;
      delta = clamp(delta, -300, 300);
      if (delta !== 0) {
        const direction = delta > 0 ? "raise" : "lower";
        const why =
          goalMode === "cut"
            ? slope_kg_per_week > expected
              ? `cutting but losing only ${slope_kg_per_week.toFixed(2)} kg/wk (target ≈ ${expected})`
              : `dropping fast at ${slope_kg_per_week.toFixed(2)} kg/wk (target ≈ ${expected})`
            : goalMode === "bulk"
            ? slope_kg_per_week < expected
              ? `bulking but only +${slope_kg_per_week.toFixed(2)} kg/wk (target ≈ +${expected})`
              : `gaining fast at +${slope_kg_per_week.toFixed(2)} kg/wk (target ≈ +${expected})`
            : `weight trending ${slope_kg_per_week > 0 ? "up" : "down"} at ${slope_kg_per_week.toFixed(2)} kg/wk on ${goalMode}`;
        suggestion = {
          delta_kcal: delta,
          reason: `${why}. Suggest ${direction} daily calories by ${Math.abs(delta)}.`,
        };
      }
    }
  }

  return {
    count: sorted.length,
    earliest: first.date,
    latest: last.date,
    ma7_kg: ma7,
    ma28_kg: ma28,
    slope_kg_per_week,
    expected_slope_kg_per_week: expected,
    suggestion,
  };
}

function dateToMs(s: string): number {
  // s is YYYY-MM-DD; treat as UTC midnight to avoid TZ drift in slope calc
  return Date.UTC(
    parseInt(s.slice(0, 4), 10),
    parseInt(s.slice(5, 7), 10) - 1,
    parseInt(s.slice(8, 10), 10),
  );
}
function daysBetween(a: string, b: string): number {
  return Math.round((dateToMs(b) - dateToMs(a)) / (1000 * 60 * 60 * 24));
}
