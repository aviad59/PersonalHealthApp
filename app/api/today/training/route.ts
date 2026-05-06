// Slower follow-up to /api/today: workout cache + recovery score.
// Split out so the home page can render macro rings & meals immediately
// (from /api/today) and stream the workout/recovery sections in after.

import { NextResponse } from "next/server";
import {
  getProfile,
  getMealsSinceLite,
  getCachedWorkoutsSince,
  todayStr,
  daysAgoStr,
  dateKey,
} from "@/lib/db";
import { HevyWorkout, workoutVolumeKg, workoutDurationMin } from "@/lib/hevy";
import { estimateWorkoutBurn } from "@/lib/burn";
import { computeRecovery, DailyTotals } from "@/lib/recovery";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";
import { getUserConfig } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function rowsToHevy(rows: { raw_json: string }[]): HevyWorkout[] {
  const out: HevyWorkout[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.raw_json) as HevyWorkout);
    } catch {
      // skip
    }
  }
  return out;
}

function dailyTotalsFromMeals(
  meals: { date: string; calories: number | null; protein_g: number | null }[],
): DailyTotals[] {
  const m = new Map<string, DailyTotals>();
  for (const x of meals) {
    const d = x.date;
    const cur = m.get(d) ?? { date: d, calories: 0, protein_g: 0 };
    cur.calories += x.calories ?? 0;
    cur.protein_g += x.protein_g ?? 0;
    m.set(d, cur);
  }
  return Array.from(m.values());
}

export async function GET() {
  const userId = getCurrentUserIdOrDefault();
  const cfg = getUserConfig(userId);

  // Users without a workouts setup (orly) don't have Hevy/recovery data.
  if (!cfg.hasWorkouts) {
    return NextResponse.json({
      date: todayStr(),
      todaysWorkout: null,
      training_burn_kcal: 0,
      recovery: null,
    });
  }

  const [profile, cachedRecent, last3] = await Promise.all([
    getProfile(userId),
    getCachedWorkoutsSince(daysAgoStr(14)),
    getMealsSinceLite(userId, daysAgoStr(2)),
  ]);
  const today = todayStr();

  const recentHevy = rowsToHevy(cachedRecent);
  const todaysWorkoutHevy =
    recentHevy.find((w) => {
      const t = Date.parse(w.start_time || "");
      return Number.isFinite(t) && dateKey(new Date(t)) === today;
    }) ?? null;

  let todaysWorkout: null | {
    id: string;
    title: string;
    volume_kg: number;
    start_time: string;
    duration_min: number;
    burn_kcal: number;
    burn_reason: string;
  } = null;

  if (todaysWorkoutHevy) {
    const vol = workoutVolumeKg(todaysWorkoutHevy);
    const dur = workoutDurationMin(todaysWorkoutHevy);
    const burn = estimateWorkoutBurn({
      durationMin: dur,
      volumeKg: vol,
      bodyWeightKg: profile?.weight_kg,
    });
    todaysWorkout = {
      id: todaysWorkoutHevy.id,
      title: todaysWorkoutHevy.title,
      volume_kg: vol,
      start_time: todaysWorkoutHevy.start_time,
      duration_min: dur,
      burn_kcal: burn.kcal,
      burn_reason: burn.reason,
    };
  }

  const dailies = dailyTotalsFromMeals(
    last3.map((m) => ({
      date: m.date,
      calories: m.calories,
      protein_g: m.protein_g,
    })),
  );
  const recovery = computeRecovery({
    goalCalories: profile?.goal_calories,
    goalProteinG: profile?.goal_protein_g,
    last3Days: dailies,
    recentWorkouts: recentHevy,
  });

  return NextResponse.json({
    date: today,
    todaysWorkout,
    training_burn_kcal: todaysWorkout?.burn_kcal ?? 0,
    recovery,
  });
}
