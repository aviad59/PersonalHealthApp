// Workout score (0–100) + per-muscle status, computed entirely from Hevy data
// (plus the user's own weekly session target and training focus).
//
// It answers "am I training well right now?" across four things a lifter can
// actually act on:
//   1. Consistency  — are the sessions happening at the planned rate?
//   2. Progression  — are the lifts actually getting stronger?
//   3. Focus        — is the work going where the user wants it to go?
//   4. Intensity    — are sets taken close enough to failure to drive
//                     adaptation, without living at redline?
//
// Every component degrades gracefully: whatever can't be measured (no RPE
// logged, no history for a trend) is dropped and the score is normalised over
// the components that remain, so a missing signal never silently caps the
// score.

import { HevyWorkout, inferMuscleGroups, avgRpeAcrossWorkouts } from "@/lib/hevy";
import { dateKey, diffDaysKey, todayStr, startOfWeekStr } from "@/lib/db";

/** Which part of the body the user wants their training weighted toward. */
export type TrainingFocus = "upper" | "balanced" | "lower";

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
    focus: ScoreComponent;
    intensity: ScoreComponent;
  };
  focusTarget: TrainingFocus;
  /** Distinct training days in the last 7. */
  sessionsLast7: number;
  /** Distinct training days since the start of THIS calendar week. */
  sessionsThisWeek: number;
  /** Which day of the week it is, 1 on Sunday .. 7 on Saturday. */
  daysIntoWeek: number;
  /** Sessions you would be expected to have done by now, pro-rated. */
  expectedByNow: number;
  weeklyTarget: number;
  /** Hard (non-warmup) sets in the last 7 days — the standard load metric. */
  hardSetsLast7: number;
  setsByRegion: Record<string, number>;
  /** Share of hard sets going to the focused half, 0–100. */
  focusSharePct: number | null;
  /** Mean change in estimated 1RM across lifts trained in both windows. */
  strengthChangePct: number | null;
  /** How many lifts that trend is based on — low counts are weak evidence. */
  comparedExercises: number;
  avgRpeLast7: number | null;
  /** Regions the focus cares about that got no work. */
  neglectedRegions: string[];
  daysSinceLastSession: number | null;
  byMuscle: MuscleStatus[];
  rationale: string;
};

export type WorkoutScoreInput = {
  /** At least 28 days of history, so the strength trend has a baseline. */
  recentWorkouts: HevyWorkout[];
  weeklyWorkoutTarget: number | null | undefined;
  focus?: TrainingFocus | null;
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

const REGIONS: Record<string, string[]> = {
  push: ["chest", "shoulders", "triceps"],
  pull: ["back", "biceps"],
  legs: ["quads", "hamstrings", "glutes", "calves"],
  core: ["core"],
};
// Used only for the "balanced" focus, where coverage is the goal.
const REGION_POINTS: Record<string, number> = { push: 7, pull: 7, legs: 7, core: 4 };

// Share of hard sets the focused half should get before the component maxes
// out. 70% leaves room for accessory work on the other half.
const FOCUS_TARGET_SHARE = 0.7;

const DEFAULT_WEEKLY_TARGET = 3;

// Weeks start on Sunday here, matching startOfWeekStr().
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function workoutDay(w: HevyWorkout): string {
  const t = Date.parse(w.start_time || "");
  return Number.isFinite(t) ? dateKey(new Date(t)) : "";
}

/**
 * Estimated one-rep max (Epley). Turns a set of any weight/rep combination
 * into a single comparable strength number, so 80kg x 8 and 90kg x 5 can be
 * ranked against each other.
 *
 * The formula degrades badly past ~15 reps, so high-rep sets are ignored
 * rather than trusted.
 */
function estimated1RM(weightKg: number, reps: number): number | null {
  if (!(weightKg > 0) || !(reps > 0) || reps > 15) return null;
  return weightKg * (1 + reps / 30);
}

/** Best e1RM per exercise across a set of workouts. */
function bestE1RMByExercise(workouts: HevyWorkout[]): Map<string, number> {
  const best = new Map<string, number>();
  for (const w of workouts) {
    for (const ex of w.exercises) {
      const key = ex.title.trim().toLowerCase();
      for (const s of ex.sets) {
        if (s.type === "warmup") continue;
        const e = estimated1RM(s.weight_kg ?? 0, s.reps ?? 0);
        if (e === null) continue;
        if (!best.has(key) || e > (best.get(key) as number)) best.set(key, e);
      }
    }
  }
  return best;
}

/** Hard (non-warmup) sets per region across a set of workouts. */
function hardSetsByRegion(workouts: HevyWorkout[]): {
  byRegion: Record<string, number>;
  total: number;
} {
  const byRegion: Record<string, number> = { push: 0, pull: 0, legs: 0, core: 0 };
  let total = 0;
  for (const w of workouts) {
    for (const ex of w.exercises) {
      const working = ex.sets.filter((s) => s.type !== "warmup").length;
      if (working === 0) continue;
      const groups = inferMuscleGroups(ex.title).filter((g) => g !== "other");
      if (groups.length === 0) continue;
      total += working;
      // An exercise mapping to several regions (e.g. a compound) credits each
      // once, not once per muscle, so region shares stay comparable.
      const regions = new Set<string>();
      for (const g of groups) {
        for (const [region, muscles] of Object.entries(REGIONS)) {
          if (muscles.includes(g)) regions.add(region);
        }
      }
      for (const r of regions) byRegion[r] += working;
    }
  }
  return { byRegion, total };
}

export function computeWorkoutScore(
  input: WorkoutScoreInput,
): WorkoutScoreResult {
  const today = todayStr();
  const target = Math.max(1, input.weeklyWorkoutTarget || DEFAULT_WEEKLY_TARGET);
  const focusTarget: TrainingFocus = input.focus ?? "upper";

  const dated = input.recentWorkouts
    .map((w) => ({ w, day: workoutDay(w) }))
    .filter((x) => x.day)
    .map((x) => ({ ...x, age: diffDaysKey(today, x.day) }))
    .filter((x) => x.age >= 0);

  const last7 = dated.filter((x) => x.age <= 6);
  const prev21 = dated.filter((x) => x.age >= 7 && x.age <= 27);

  const sessionsLast7 = new Set(last7.map((x) => x.day)).size;
  const daysSinceLastSession = dated.length
    ? Math.min(...dated.map((x) => x.age))
    : null;

  const { byRegion: setsByRegion, total: hardSetsLast7 } = hardSetsByRegion(
    last7.map((x) => x.w),
  );

  // ---- 1. Consistency ----
  // Judged against a PRO-RATED target, not the whole week's. Scoring the full
  // target from Sunday morning marks you down for workouts that aren't due
  // yet: by Tuesday of a 4-session week you owe roughly one, not four.
  //
  // The +1 on both sides is a one-session grace. Without it the first day or
  // two of the week divides a real zero by a small expectation and lands on
  // zero regardless, which is the same unfairness in a different place.
  const weekStart = startOfWeekStr();
  const sessionsThisWeek = new Set(
    dated.filter((x) => x.day >= weekStart && x.day <= today).map((x) => x.day),
  ).size;
  const daysIntoWeek = clamp(diffDaysKey(today, weekStart) + 1, 1, 7);
  const expectedByNow = (target * daysIntoWeek) / 7;
  const pace = (sessionsThisWeek + 1) / (expectedByNow + 1);

  const consistency: ScoreComponent = {
    score: Math.round(30 * clamp(pace, 0, 1)),
    max: 30,
    available: true,
    detail:
      sessionsThisWeek >= target
        ? `${sessionsThisWeek} / ${target} this week — target met`
        : `${sessionsThisWeek} / ${target} this week · ~${expectedByNow.toFixed(1)} due by now`,
  };

  // ---- 2. Progression: are the lifts getting stronger? ----
  // Tonnage (weight x reps summed) was the obvious metric and the wrong one:
  // it is dominated by exercise selection, so swapping in heavy leg work reads
  // as "progress" without a single lift improving. Comparing estimated 1RM
  // per exercise, across only the lifts trained in BOTH windows, measures
  // strength directly and is unaffected by what else was in the session.
  const recentBest = bestE1RMByExercise(last7.map((x) => x.w));
  const prevBest = bestE1RMByExercise(prev21.map((x) => x.w));
  const changes: number[] = [];
  for (const [exercise, recent] of recentBest) {
    const prev = prevBest.get(exercise);
    if (prev && prev > 0) changes.push(recent / prev - 1);
  }
  const comparedExercises = changes.length;
  const strengthChangePct =
    comparedExercises > 0
      ? (changes.reduce((a, b) => a + b, 0) / comparedExercises) * 100
      : null;

  let progression: ScoreComponent;
  // One matching lift is noise; require a couple before drawing a trend.
  if (strengthChangePct === null || comparedExercises < 2) {
    progression = {
      score: 0,
      max: 25,
      available: false,
      detail:
        comparedExercises === 0
          ? "no repeated lifts to compare yet"
          : "not enough repeated lifts yet",
    };
  } else {
    let pts: number;
    if (strengthChangePct >= 2) pts = 25;
    else if (strengthChangePct >= -1) pts = 20;
    else if (strengthChangePct >= -5) pts = 12;
    else pts = 5;
    progression = {
      score: pts,
      max: 25,
      available: true,
      detail: `${strengthChangePct >= 0 ? "+" : "−"}${Math.abs(strengthChangePct).toFixed(1)}% est. 1RM across ${comparedExercises} lifts`,
    };
  }

  // ---- 3. Focus: is the work going where the user wants it? ----
  const upperSets = setsByRegion.push + setsByRegion.pull;
  const lowerSets = setsByRegion.legs;
  const focusedSets = focusTarget === "lower" ? lowerSets : upperSets;
  const focusSharePct =
    hardSetsLast7 > 0 ? Math.round((focusedSets / hardSetsLast7) * 100) : null;

  const neglectedRegions: string[] = [];
  let focus: ScoreComponent;

  if (focusTarget === "balanced") {
    // Coverage of every region, the classic reading of "balanced".
    let pts = 0;
    for (const [region, points] of Object.entries(REGION_POINTS)) {
      if (setsByRegion[region] > 0) pts += points;
      else neglectedRegions.push(region);
    }
    focus = {
      score: pts,
      max: 25,
      available: dated.length > 0,
      detail: neglectedRegions.length
        ? `missing ${neglectedRegions.join(", ")}`
        : "all regions covered",
    };
  } else {
    // Weighted toward one half: reward the share of work going there, and
    // require both halves of that half to be trained so an "upper focus"
    // can't just be chest every session.
    const share = hardSetsLast7 > 0 ? focusedSets / hardSetsLast7 : 0;
    const shareScore = 15 * clamp(share / FOCUS_TARGET_SHARE, 0, 1);

    const subRegions =
      focusTarget === "upper"
        ? ([["push", setsByRegion.push], ["pull", setsByRegion.pull]] as const)
        : ([["legs", setsByRegion.legs]] as const);
    let coverage = 0;
    for (const [name, sets] of subRegions) {
      if (sets > 0) coverage += 10 / subRegions.length;
      else neglectedRegions.push(name);
    }

    focus = {
      score: Math.round(shareScore + coverage),
      max: 25,
      available: hardSetsLast7 > 0,
      detail:
        focusSharePct === null
          ? "no sets logged"
          : neglectedRegions.length
            ? `${focusSharePct}% ${focusTarget} · missing ${neglectedRegions.join(", ")}`
            : `${focusSharePct}% of sets ${focusTarget}`,
    };
  }

  // ---- 4. Intensity ----
  const avgRpeLast7 = avgRpeAcrossWorkouts(last7.map((x) => x.w));
  let intensity: ScoreComponent;
  if (avgRpeLast7 === null) {
    intensity = { score: 0, max: 20, available: false, detail: "no RPE logged" };
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
  const components = { consistency, progression, focus, intensity };
  const usable = Object.values(components).filter((c) => c.available);
  const earned = usable.reduce((a, c) => a + c.score, 0);
  const possible = usable.reduce((a, c) => a + c.max, 0);
  const score = possible > 0 ? Math.round((earned / possible) * 100) : 0;

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

  // ---- Rationale ----
  const reasons: string[] = [];
  if (dated.length === 0) {
    reasons.push("no workouts synced yet");
  } else {
    if (sessionsThisWeek >= target) {
      reasons.push(`${sessionsThisWeek} sessions — weekly target met`);
    } else if (sessionsThisWeek === 0 && daysSinceLastSession !== null) {
      reasons.push(`${daysSinceLastSession} days since your last session`);
    } else if (sessionsThisWeek + 0.5 < expectedByNow) {
      // Only call it "behind" against what is actually due by today.
      reasons.push(
        `${sessionsThisWeek} of ${target} this week — behind pace for ${DAY_NAMES[daysIntoWeek - 1]}`,
      );
    } else {
      reasons.push(`${sessionsThisWeek} of ${target} this week — on pace`);
    }
    if (neglectedRegions.length && sessionsLast7 > 0) {
      reasons.push(`no ${neglectedRegions.join(" or ")} work this week`);
    } else if (
      focusTarget !== "balanced" &&
      focusSharePct !== null &&
      focusSharePct < FOCUS_TARGET_SHARE * 100 &&
      sessionsLast7 > 0
    ) {
      reasons.push(`only ${focusSharePct}% of sets were ${focusTarget}-body`);
    }
    if (strengthChangePct !== null && comparedExercises >= 2) {
      if (strengthChangePct <= -5) {
        reasons.push(`lifts down ${Math.abs(strengthChangePct).toFixed(1)}%`);
      } else if (strengthChangePct >= 2) {
        reasons.push(`lifts up ${strengthChangePct.toFixed(1)}%`);
      }
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
    focusTarget,
    sessionsLast7,
    sessionsThisWeek,
    daysIntoWeek,
    expectedByNow: Math.round(expectedByNow * 10) / 10,
    weeklyTarget: target,
    hardSetsLast7,
    setsByRegion,
    focusSharePct,
    strengthChangePct:
      strengthChangePct === null ? null : Math.round(strengthChangePct * 10) / 10,
    comparedExercises,
    avgRpeLast7,
    neglectedRegions,
    daysSinceLastSession,
    byMuscle,
    rationale: reasons.join("; "),
  };
}
