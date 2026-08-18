// Workout score (0–100) + per-muscle status, computed entirely from Hevy data
// (plus the user's own weekly session target).
//
// It answers "am I training well right now?" across four things a lifter can
// actually act on:
//   1. Consistency  — are the sessions happening at the planned rate?
//   2. Progression  — is training volume trending up, or sliding?
//   3. Balance      — is every region getting worked, or is something skipped?
//   4. Intensity    — are sets being taken close enough to failure to drive
//                     adaptation, without living at redline?
//
// Every component degrades gracefully: whatever can't be measured (no RPE
// logged, no history for a trend) is dropped and the score is normalised over
// the components that remain, so a missing signal never silently caps the
// score.

import {
  HevyWorkout,
  inferMuscleGroups,
  workoutVolumeKg,
  avgRpeAcrossWorkouts,
} from "@/lib/hevy";
import { dateKey, diffDaysKey, todayStr } from "@/lib/db";

export type MuscleStatus = {
  muscle: string;
  daysSince: number | null; // null if never seen in the data window
  readiness: "rest" | "cautious" | "ready";
};

export type ScoreComponent = {
  /** Points earned out of `max`. */
  score: number;
  max: number;
  /** False when the signal is missing; the component is then excluded. */
  available: boolean;
  /** Short human-readable value, e.g. "3 / 4 sessions". */
  detail: string;
};

export type WorkoutScoreResult = {
  score: number;
  band: "low" | "moderate" | "good" | "high";
  components: {
    consistency: ScoreComponent;
    progression: ScoreComponent;
    balance: ScoreComponent;
    intensity: ScoreComponent;
  };
  /** Distinct training days in the last 7. */
  sessionsLast7: number;
  weeklyTarget: number;
  volumeLast7Kg: number;
  volumePrevAvgKg: number | null;
  volumeChangePct: number | null;
  avgRpeLast7: number | null;
  /** Regions with no working sets in the last 7 days. */
  neglectedRegions: string[];
  daysSinceLastSession: number | null;
  byMuscle: MuscleStatus[];
  rationale: string;
};

export type WorkoutScoreInput = {
  /** At least 28 days of history, so the volume trend has a baseline. */
  recentWorkouts: HevyWorkout[];
  weeklyWorkoutTarget: number | null | undefined;
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

// Coverage is judged by region rather than by individual muscle, so a lifter
// isn't marked down for skipping calves in a given week.
const REGIONS: Record<string, string[]> = {
  push: ["chest", "shoulders", "triceps"],
  pull: ["back", "biceps"],
  legs: ["quads", "hamstrings", "glutes", "calves"],
  core: ["core"],
};
// Push/pull/legs carry the weight; core is a smaller bonus.
const REGION_POINTS: Record<string, number> = { push: 7, pull: 7, legs: 7, core: 4 };

const DEFAULT_WEEKLY_TARGET = 3;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Calendar day (APP_TZ) a workout belongs to, or "" if unparseable. */
function workoutDay(w: HevyWorkout): string {
  const t = Date.parse(w.start_time || "");
  return Number.isFinite(t) ? dateKey(new Date(t)) : "";
}

export function computeWorkoutScore(
  input: WorkoutScoreInput,
): WorkoutScoreResult {
  const today = todayStr();
  const target = Math.max(1, input.weeklyWorkoutTarget || DEFAULT_WEEKLY_TARGET);

  // Bucket workouts by age in days so every window below is a simple filter.
  const dated = input.recentWorkouts
    .map((w) => ({ w, day: workoutDay(w) }))
    .filter((x) => x.day)
    .map((x) => ({ ...x, age: diffDaysKey(today, x.day) }))
    .filter((x) => x.age >= 0);

  const last7 = dated.filter((x) => x.age <= 6);
  // The previous three weeks, used as the baseline for the volume trend.
  const prev21 = dated.filter((x) => x.age >= 7 && x.age <= 27);

  const sessionDays = new Set(last7.map((x) => x.day));
  const sessionsLast7 = sessionDays.size;

  const daysSinceLastSession = dated.length
    ? Math.min(...dated.map((x) => x.age))
    : null;

  const volumeLast7Kg = last7.reduce((a, x) => a + workoutVolumeKg(x.w), 0);
  const prevVolume = prev21.reduce((a, x) => a + workoutVolumeKg(x.w), 0);
  // Per-week average across the 3-week baseline.
  const volumePrevAvgKg = prev21.length > 0 ? prevVolume / 3 : null;
  const volumeChangePct =
    volumePrevAvgKg && volumePrevAvgKg > 0
      ? ((volumeLast7Kg - volumePrevAvgKg) / volumePrevAvgKg) * 100
      : null;

  // ---- 1. Consistency ----
  const consistency: ScoreComponent = {
    score: Math.round(30 * clamp(sessionsLast7 / target, 0, 1)),
    max: 30,
    available: true,
    detail: `${sessionsLast7} / ${target} sessions`,
  };

  // ---- 2. Progression ----
  // Rewards holding or growing volume. A deliberate deload will read as a dip;
  // that's why the raw change is surfaced alongside the score.
  let progression: ScoreComponent;
  if (volumeChangePct === null) {
    progression = {
      score: 0,
      max: 25,
      available: false,
      detail: "no prior weeks to compare",
    };
  } else {
    let pts: number;
    if (volumeChangePct >= 5) pts = 25;
    else if (volumeChangePct >= -5) pts = 20;
    else if (volumeChangePct >= -20) pts = 12;
    else pts = 5;
    progression = {
      score: pts,
      max: 25,
      available: true,
      detail: `${volumeChangePct >= 0 ? "+" : "−"}${Math.abs(Math.round(volumeChangePct))}% volume vs prior weeks`,
    };
  }

  // ---- 3. Balance ----
  const workedMuscles = new Set<string>();
  for (const { w } of last7) {
    for (const ex of w.exercises) {
      const hasWorkingSet = ex.sets.some((s) => s.type !== "warmup");
      if (!hasWorkingSet) continue;
      for (const g of inferMuscleGroups(ex.title)) {
        if (g !== "other") workedMuscles.add(g);
      }
    }
  }
  const neglectedRegions: string[] = [];
  let balancePts = 0;
  for (const [region, muscles] of Object.entries(REGIONS)) {
    if (muscles.some((m) => workedMuscles.has(m))) {
      balancePts += REGION_POINTS[region];
    } else {
      neglectedRegions.push(region);
    }
  }
  const balance: ScoreComponent = {
    score: balancePts,
    max: 25,
    // Nothing trained at all is a real signal (score 0), not a missing one —
    // but only once we know the user trains at all.
    available: dated.length > 0,
    detail: neglectedRegions.length
      ? `missing ${neglectedRegions.join(", ")}`
      : "all regions covered",
  };

  // ---- 4. Intensity ----
  // RPE 7–9 is the productive band: hard enough to drive adaptation, short of
  // living at failure. Many lifters never log RPE, so this drops out cleanly.
  const avgRpeLast7 = avgRpeAcrossWorkouts(last7.map((x) => x.w));
  let intensity: ScoreComponent;
  if (avgRpeLast7 === null) {
    intensity = {
      score: 0,
      max: 20,
      available: false,
      detail: "no RPE logged",
    };
  } else {
    let pts: number;
    if (avgRpeLast7 >= 7 && avgRpeLast7 <= 9) pts = 20;
    else if (avgRpeLast7 > 9 && avgRpeLast7 <= 9.5) pts = 14;
    else if (avgRpeLast7 >= 6 && avgRpeLast7 < 7) pts = 14;
    else if (avgRpeLast7 > 9.5) pts = 10;
    else pts = 8;
    intensity = {
      score: pts,
      max: 20,
      available: true,
      detail: `avg RPE ${avgRpeLast7}`,
    };
  }

  // ---- Normalise over the components we could actually measure ----
  const components = { consistency, progression, balance, intensity };
  const usable = Object.values(components).filter((c) => c.available);
  const earned = usable.reduce((a, c) => a + c.score, 0);
  const possible = usable.reduce((a, c) => a + c.max, 0);
  let score = possible > 0 ? Math.round((earned / possible) * 100) : 0;

  // Skipping an entire major region (push, pull or legs) for a full seven days
  // is a real gap, but as a share of one 25-point component it barely dented
  // the total — four hard sessions with no legs still scored "high". Cap the
  // score below the top band while that's true. Only applies once there's
  // enough training in the window to call it a choice rather than a slow week;
  // the window is a trailing 7 days, so it isn't an early-in-the-week artifact.
  const missedMajor = neglectedRegions.some((r) => r !== "core");
  if (missedMajor && sessionsLast7 >= 2) {
    score = Math.min(score, 79);
  }

  let band: WorkoutScoreResult["band"];
  if (score >= 85) band = "high";
  else if (score >= 70) band = "good";
  else if (score >= 50) band = "moderate";
  else band = "low";

  // ---- Per-muscle days-since-last ----
  const lastByMuscle: Record<string, number> = {};
  for (const { w, age } of dated) {
    const seen = new Set<string>();
    for (const ex of w.exercises) {
      for (const g of inferMuscleGroups(ex.title)) {
        if (g !== "other") seen.add(g);
      }
    }
    for (const g of seen) {
      if (lastByMuscle[g] === undefined || age < lastByMuscle[g]) {
        lastByMuscle[g] = age;
      }
    }
  }
  const byMuscle: MuscleStatus[] = MUSCLES.map((m) => {
    const d = lastByMuscle[m];
    if (d === undefined) return { muscle: m, daysSince: null, readiness: "ready" };
    let readiness: MuscleStatus["readiness"];
    if (d <= 0) readiness = "rest";
    else if (d === 1) readiness = "cautious";
    else readiness = "ready";
    return { muscle: m, daysSince: d, readiness };
  });

  // ---- Rationale: lead with the weakest actionable component ----
  const reasons: string[] = [];
  if (dated.length === 0) {
    reasons.push("no workouts synced yet");
  } else {
    if (sessionsLast7 === 0) {
      reasons.push(
        daysSinceLastSession === null
          ? "no sessions this week"
          : `${daysSinceLastSession} days since your last session`,
      );
    } else if (sessionsLast7 < target) {
      reasons.push(`${sessionsLast7} of ${target} sessions so far`);
    } else {
      reasons.push(`${sessionsLast7} sessions — target met`);
    }
    if (neglectedRegions.length && sessionsLast7 > 0) {
      reasons.push(`${neglectedRegions.join(" and ")} untrained this week`);
    }
    if (volumeChangePct !== null && volumeChangePct <= -20) {
      reasons.push(`volume down ${Math.abs(Math.round(volumeChangePct))}%`);
    } else if (volumeChangePct !== null && volumeChangePct >= 10) {
      reasons.push(`volume up ${Math.round(volumeChangePct)}%`);
    }
    if (avgRpeLast7 !== null && avgRpeLast7 > 9.5) {
      reasons.push(`sets averaging RPE ${avgRpeLast7} — very close to failure`);
    } else if (avgRpeLast7 !== null && avgRpeLast7 < 6) {
      reasons.push(`sets averaging RPE ${avgRpeLast7} — room to push harder`);
    }
  }

  return {
    score,
    band,
    components,
    sessionsLast7,
    weeklyTarget: target,
    volumeLast7Kg: Math.round(volumeLast7Kg),
    volumePrevAvgKg: volumePrevAvgKg === null ? null : Math.round(volumePrevAvgKg),
    volumeChangePct: volumeChangePct === null ? null : Math.round(volumeChangePct),
    avgRpeLast7,
    neglectedRegions,
    daysSinceLastSession,
    byMuscle,
    rationale: reasons.join("; "),
  };
}
