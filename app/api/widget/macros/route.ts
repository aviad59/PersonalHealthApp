import { NextResponse } from "next/server";
import { getProfile, getMealsByDate, todayStr } from "@/lib/db";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const userId = getCurrentUserIdOrDefault();
  const today = todayStr();

  const [profile, meals] = await Promise.all([
    getProfile(userId),
    getMealsByDate(userId, today),
  ]);

  const totals = meals.reduce(
    (acc, m) => ({
      calories: acc.calories + (m.calories ?? 0),
      protein_g: acc.protein_g + (m.protein_g ?? 0),
      fat_g: acc.fat_g + (m.fat_g ?? 0),
      carbs_g: acc.carbs_g + (m.carbs_g ?? 0),
    }),
    { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
  );

  const data = {
    date: today,
    calories: Math.round(totals.calories),
    target_calories: profile?.goal_calories ?? 2000,
    protein_g: Math.round(totals.protein_g),
    target_protein_g: profile?.goal_protein_g ?? 150,
    fat_g: Math.round(totals.fat_g),
    target_fat_g: profile?.goal_fat_g ?? 65,
    carbs_g: Math.round(totals.carbs_g),
    target_carbs_g: profile?.goal_carbs_g ?? 200,
  };

  return NextResponse.json(data, {
    headers: {
      // Allow service worker to fetch this without CORS issues
      "Access-Control-Allow-Origin": "*",
    },
  });
}
