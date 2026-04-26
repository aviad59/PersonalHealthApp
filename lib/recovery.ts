// Recovery readiness score (0–100) + per-muscle status.
//
// Inputs (all optional — we degrade gracefully):
//   - daily protein totals over the last 3 days, vs profile.goal_protein_g
//   - daily calorie totals over the last 3 days, vs profile.goal_calories
//   - cached workouts (recent) so we know which muscles were trained when
//   - sleep hours from Zepp (not yet available — placeholder hook)
//
// Output:
//   - overall score 0..100
//   - per-muscle readiness { ready | cautious | rest } with days since last hit
//   - 1-sentence rationale
//
// Tuning is deliberately conservative so the score moves with real data, not noise.

import { HevyWorkout, inferMuscleGroups } from "@/lib/hevy";

export type DailyTotals = {
  date: string;
  calories: number;
  protein_g: number;
};

export type RecoveryInput = {
  goalCalories: number | null | undefined;
  goalProteinG: number | null | undefined;
  last3Days: DailyTotals[]; // newest-last is fine, we don't rely on order
  recentWorkouts: HevyWorkout[]; // last ~14 days is enough
  sleepHoursLast3?: number[];     // optional, may be undefined per night
};

export type MuscleStatus = {
  muscle: string;
  daysSince: number | null; // null if never seen in data window
  readiness: "rest" | "cautious" | "ready";
};

export type RecoveryResult = {
  score: number;
  band: "low" | "moderate" | "good" | "high";
  proteinAdherencePct: number; // 0..100
  calorieDeviationPct: number; // 0..100 (closer to 0 = closer to target)
  backToBackSessions: boolean;
  byMuscle: MuscleStatus[];
  rationale: string;
  signalsUsed: {
    protein: boolean;
    calories: boolean;
    workouts: boolean;
    sleep: boolean;
  };
};

const MUSCLES = [
  "chest",
  "back",
  "shoulders",
  "biceps",
  "triceps",
  "quads",
  "hamstrings",
  "glutes",
  "calves",
  "core",
];

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (24 * 3600 * 1000));
}

export function computeRecovery(input: RecoveryInput): RecoveryResult {
  const signals = {
    protein: !!input.goalProteinG && input.last3Days.length > 0,
    calories: !!input.goalCalories && input.last3Days.length > 0,
    workouts: input.recentWorkouts.length > 0,
    sleep: !!(input.sleepHoursLast3 && input.sleepHoursLast3.length > 0),
  };

  let score = 100;

  // ---- Protein adherence (last 3 days vs target) ----
  let proteinPct = 100;
  if (signals.protein && input.goalProteinG) {
    const ratios = input.last3Days.map(
      (d) => d.protein_g / (input.goalProteinG as number),
    );
    proteinPct = clamp(Math.round(avg(ratios) * 100), 0, 200);
    // hits and misses
    if (proteinPct < 70) score -= 25;
    else if (proteinPct < 85) score -= 12;
    else if (proteinPct < 100) score -= 5;
  }

  // ---- Calorie adherence (deviation from target) ----
  let calDevPct = 0;
  if (signals.calories && input.goalCalories) {
    const ratios = input.last3Days.map(
      (d) => d.calories / (input.goalCalories as number),
    );
    const meanRatio = avg(ratios);
    calDevPct = clamp(Math.round(Math.abs(meanRatio - 1) * 100), 0, 100);
    if (calDevPct > 30) score -= 20;
    else if (calDevPct > 15) score -= 10;
    else if (calDevPct > 10) score -= 5;
  }

  // ---- Recent training load: back-to-back days ----
  let backToBack = false;
  if (signals.workouts) {
    const datesSet = new Set(
      input.recentWorkouts
        .map((w) => (w.start_time || "").slice(0, 10))
        .filter(Boolean),
    );
    const today = new Date();
    const yest = new Date(today.getTime() - 24 * 3600 * 1000);
    const toKey = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (datesSet.has(toKey(today)) && datesSet.has(toKey(yest))) {
      backToBack = true;
      score -= 10;
    }
  }

  // ---- Sleep (optional, future Zepp hook) ----
  if (signals.sleep && input.sleepHoursLast3) {
    const meanSleep = avg(input.sleepHoursLast3);
    if (meanSleep < 6) score -= 15;
    else if (meanSleep < 7) score -= 7;
  }

  score = clamp(score, 0, 100);

  // ---- Per-muscle days-since-last ----
  const todayMs = Date.now();
  const lastByMuscle: Record<string, number> = {};
  for (const w of input.recentWorkouts) {
    const t = Date.parse(w.start_time);
    if (!Number.isFinite(t)) continue;
    const seen = new Set<string>();
    for (const ex of w.exercises) {
      for (const g of inferMuscleGroups(ex.title)) {
        if (g === "other") continue;
        seen.add(g);
      }
    }
    for (const g of seen) {
      const days = Math.floor((todayMs - t) / (24 * 3600 * 1000));
      if (lastByMuscle[g] === undefined || days < lastByMuscle[g]) {
        lastByMuscle[g] = days;
      }
    }
  }

  const byMuscle: MuscleStatus[] = MUSCLES.map((m) => {
    const d = lastByMuscle[m];
    if (d === undefined) {
      return { muscle: m, daysSince: null, readiness: "ready" };
    }
    let readiness: MuscleStatus["readiness"];
    if (d <= 0) readiness = "rest";
    else if (d === 1) readiness = "cautious";
    else readiness = "ready";
    return { muscle: m, daysSince: d, readiness };
  });

  // ---- Band + rationale ----
  let band: RecoveryResult["band"];
  if (score >= 85) band = "high";
  else if (score >= 70) band = "good";
  else if (score >= 50) band = "moderate";
  else band = "low";

  const reasons: string[] = [];
  if (signals.protein) {
    if (proteinPct < 85)
      reasons.push(`protein ~${proteinPct}% of target last 3 days`);
    else if (proteinPct >= 100)
      reasons.push(`protein on target (${proteinPct}%)`);
  }
  if (signals.calories && calDevPct > 15) {
    reasons.push(`calories ${calDevPct}% off target`);
  }
  if (backToBack) reasons.push("trained yesterday and today");
  if (!signals.protein && !signals.workouts) {
    reasons.push("not enough data yet — log a meal or workout");
  }

  const rationale =
    reasons.length === 0
      ? "Nutrition and training signals look balanced."
      : reasons.join("; ");

  return {
    score,
    band,
    proteinAdherencePct: proteinPct,
    calorieDeviationPct: calDevPct,
    backToBackSessions: backToBack,
    byMuscle,
    rationale,
    signalsUsed: signals,
  };
}
