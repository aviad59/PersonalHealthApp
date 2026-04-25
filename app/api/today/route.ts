import { NextResponse } from "next/server";
import {
  getProfile,
  getMealsByDate,
  getLatestInsight,
  todayStr,
} from "@/lib/db";
import { listWorkouts, workoutVolumeKg } from "@/lib/hevy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const profile = getProfile();
  const today = todayStr();
  const meals = getMealsByDate(today);

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

  let todaysWorkout: null | {
    id: string;
    title: string;
    volume_kg: number;
    start_time: string;
  } = null;

  if (process.env.HEVY_API_KEY) {
    try {
      const r = await listWorkouts({ page: 1, pageSize: 5 });
      const w = r.workouts.find((x) => x.start_time.slice(0, 10) === today);
      if (w) {
        todaysWorkout = {
          id: w.id,
          title: w.title,
          volume_kg: workoutVolumeKg(w),
          start_time: w.start_time,
        };
      }
    } catch {
      // swallow
    }
  }

  const latestInsight = getLatestInsight();

  return NextResponse.json({
    date: today,
    profile,
    totals,
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
