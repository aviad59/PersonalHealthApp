import { NextResponse } from "next/server";
import {
  getProfile,
  getMealsByDate,
  getMealsSince,
  getLatestInsight,
  getCachedWorkoutsSince,
  todayStr,
  daysAgoStr,
  dateKey,
} from "@/lib/db";
import { HevyWorkout, workoutVolumeKg, workoutDurationMin } from "@/lib/hevy";
import { estimateWorkoutBurn } from "@/lib/burn";
import { computeRecovery, DailyTotals } from "@/lib/recovery";

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
  const [profile, meals, cachedRecent, last3, latestInsight] =
    await Promise.all([
      getProfile(),
      getMealsByDate(todayStr()),
      getCachedWorkoutsSince(daysAgoStr(14)),
      getMealsSince(daysAgoStr(2)),
      getLatestInsight(),
    ]);
  const today = todayStr();

  const totals = meals.reduce(
    (acc, m) => {
      acc.calories += m.calories ?? 0;
      acc.protein_g += m.protein_g ?? 0;
      acc.fat_g += m.fat_g ?? 0;
      acc.carbs_g += m.carbs_g ?? 0;
      return acc;
    },
    { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
  );

  // ---- Today's workout (from cache; falls back gracefully) ----
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

  // ---- Effective calorie target = base goal + today's training burn ----
  const baseCalTarget = profile?.goal_calories ?? 0;
  const effective_calories_target = baseCalTarget + (todaysWorkout?.burn_kcal ?? 0);

  // ---- Recovery score ----
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
    profile,
    totals,
    targets: {
      base_calories: baseCalTarget,
      training_burn_kcal: todaysWorkout?.burn_kcal ?? 0,
      effective_calories: effective_calories_target,
      protein_g: profile?.goal_protein_g ?? 0,
      fat_g: profile?.goal_fat_g ?? 0,
      carbs_g: profile?.goal_carbs_g ?? 0,
    },
    meals: meals.map((m) => ({
      id: m.id,
      description: m.description,
      calories: m.calories,
      protein_g: m.protein_g,
      fat_g: m.fat_g,
      carbs_g: m.carbs_g,
      photo_path: m.photo_path,
      ai_tip: m.ai_tip,
      created_at: m.created_at,
    })),
    todaysWorkout,
    recovery,
    latestInsight: latestInsight
      ? {
          ...latestInsight,
          tags: latestInsight.tags_json ? safeParse(latestInsight.tags_json) : [],
        }
      : null,
  });
}

function safeParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}
