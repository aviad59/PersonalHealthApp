// Health & nutrition calculations.
// Formulas: Navy body-fat, Mifflin-St Jeor BMR, TDEE, macro split.

export type Sex = "male" | "female";

export type ActivityLevel =
  | "sedentary"
  | "light"
  | "moderate"
  | "active"
  | "very_active";

export const ACTIVITY_MULTIPLIER: Record<ActivityLevel, number> = {
  sedentary: 1.2,      // desk job, no exercise
  light: 1.375,        // 1-3 days/wk light exercise
  moderate: 1.55,      // 3-5 days/wk moderate
  active: 1.725,       // 6-7 days/wk hard
  very_active: 1.9,    // physical job + training
};

export const ACTIVITY_LABELS: Record<ActivityLevel, string> = {
  sedentary: "Sedentary — desk job, little exercise",
  light: "Light — 1-3 workouts/week",
  moderate: "Moderate — 3-5 workouts/week",
  active: "Active — 6-7 workouts/week",
  very_active: "Very active — physical job + training",
};

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
    // 495 / (1.0324 - 0.19077*log10(waist-neck) + 0.15456*log10(height)) - 450
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

export function tdee(bmr: number, activity: ActivityLevel): number {
  return bmr * ACTIVITY_MULTIPLIER[activity];
}

/**
 * Given TDEE, lean mass (kg), and goal mode, return personalized macro targets.
 * Recomp: slight deficit (-200), high protein (1.0 g/lb LBM ≈ 2.2 g/kg), moderate fat.
 * Cut:    -500, protein ~2.4 g/kg LBM.
 * Bulk:   +300, protein ~2.0 g/kg LBM.
 * Maintain: +0, protein ~2.0 g/kg LBM.
 */
export function macroTargets(opts: {
  tdee: number;
  leanMassKg: number;
  goalMode: GoalMode;
}): {
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
} {
  const { tdee, leanMassKg, goalMode } = opts;

  let kcal: number;
  let proteinPerKgLbm: number;
  let fatPerKgBw: number; // per kg body weight approximated via LBM/0.85

  switch (goalMode) {
    case "recomp":
      kcal = tdee - 200;
      proteinPerKgLbm = 2.2;
      fatPerKgBw = 0.9;
      break;
    case "cut":
      kcal = tdee - 500;
      proteinPerKgLbm = 2.4;
      fatPerKgBw = 0.8;
      break;
    case "bulk":
      kcal = tdee + 300;
      proteinPerKgLbm = 2.0;
      fatPerKgBw = 1.0;
      break;
    case "maintain":
    default:
      kcal = tdee;
      proteinPerKgLbm = 2.0;
      fatPerKgBw = 0.9;
      break;
  }

  const protein_g = Math.round(leanMassKg * proteinPerKgLbm);
  // Approximate total body weight from LBM (assume ~15% body fat fallback):
  const approxBw = leanMassKg / 0.85;
  const fat_g = Math.round(approxBw * fatPerKgBw);

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
        sessions: 5,
        note: "5 PPL or upper/lower split, 16-20 hard sets per muscle group",
      };
    case "very_active":
      return {
        sessions: 6,
        note: "6 sessions, 18-22 hard sets per muscle group, watch recovery",
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
  const bmr = mifflinBMR({
    sex: opts.sex,
    weightKg: opts.weightKg,
    heightCm: opts.heightCm,
    ageYears: opts.age,
  });
  const tdeeVal = tdee(bmr, opts.activity);
  const macros = macroTargets({
    tdee: tdeeVal,
    leanMassKg: lean_mass_kg,
    goalMode,
  });
  const wo = weeklyWorkoutTarget(opts.activity);
  // If the user supplied a personal target, prefer it; the volume note still
  // comes from the activity-derived bucket so the guidance text stays useful.
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
  };
}
