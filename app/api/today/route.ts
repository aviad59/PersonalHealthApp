import { NextResponse } from "next/server";
import {
  getProfile,
  getMealsByDateLite,
  getLatestInsight,
  todayStr,
} from "@/lib/db";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CORE today endpoint — only the data the macro rings + meal list +
// latest-insight card need. Excludes workout/recovery so it returns fast.
// /api/today/training fills in those follow-up sections.
export async function GET() {
  const userId = await getCurrentUserIdOrDefault();
  const [profile, meals, latestInsight] = await Promise.all([
    getProfile(userId),
    getMealsByDateLite(userId, todayStr()),
    getLatestInsight(userId),
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

  const baseCalTarget = profile?.goal_calories ?? 0;

  return NextResponse.json({
    date: today,
    profile,
    totals,
    targets: {
      base_calories: baseCalTarget,
      training_burn_kcal: 0,
      effective_calories: baseCalTarget,
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
      photo_thumb: m.photo_thumb,
      photo_path: m.has_photo ? `/api/meals/${m.id}/photo` : null,
      ai_tip: m.ai_tip,
      created_at: m.created_at,
    })),
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
