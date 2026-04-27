import { NextRequest, NextResponse } from "next/server";
import {
  getMealDailyTotalsSince,
  getProfile,
  daysAgoStr,
  todayStr,
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DayBucket = {
  date: string;
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  meals: number;
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const daysParam = parseInt(url.searchParams.get("days") || "14", 10);
  const days = Math.max(1, Math.min(60, Number.isFinite(daysParam) ? daysParam : 14));

  const since = daysAgoStr(days - 1);
  const today = todayStr();

  // Pre-aggregated per-day totals from SQL (1 row per logged day instead of
  // 1 row per meal). Empty days won't be in the result, so we still seed
  // every date in the window so the chart has a continuous x-axis.
  const [dailyTotals, profile] = await Promise.all([
    getMealDailyTotalsSince(since),
    getProfile(),
  ]);

  const byDate = new Map<string, DayBucket>();
  for (let i = 0; i < days; i++) {
    const d = daysAgoStr(days - 1 - i);
    byDate.set(d, {
      date: d,
      calories: 0,
      protein_g: 0,
      fat_g: 0,
      carbs_g: 0,
      meals: 0,
    });
  }

  for (const t of dailyTotals) {
    const bucket = byDate.get(t.date);
    if (!bucket) continue;
    bucket.calories = t.calories ?? 0;
    bucket.protein_g = t.protein_g ?? 0;
    bucket.fat_g = t.fat_g ?? 0;
    bucket.carbs_g = t.carbs_g ?? 0;
    bucket.meals = t.meals ?? 0;
  }

  const series = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));

  const logged = series.filter((d) => d.meals > 0);
  const sum = series.reduce(
    (acc, d) => {
      acc.calories += d.calories;
      acc.protein_g += d.protein_g;
      acc.fat_g += d.fat_g;
      acc.carbs_g += d.carbs_g;
      return acc;
    },
    { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
  );

  const div = Math.max(1, logged.length);
  const averages = {
    calories: Math.round(sum.calories / div),
    protein_g: Math.round(sum.protein_g / div),
    fat_g: Math.round(sum.fat_g / div),
    carbs_g: Math.round(sum.carbs_g / div),
  };

  const totals = {
    calories: Math.round(sum.calories),
    protein_g: Math.round(sum.protein_g),
    fat_g: Math.round(sum.fat_g),
    carbs_g: Math.round(sum.carbs_g),
  };

  let bestProtein: DayBucket | null = null;
  let highestCal: DayBucket | null = null;
  for (const d of logged) {
    if (!bestProtein || d.protein_g > bestProtein.protein_g) bestProtein = d;
    if (!highestCal || d.calories > highestCal.calories) highestCal = d;
  }

  const targets =
    profile &&
    profile.goal_calories != null &&
    profile.goal_protein_g != null &&
    profile.goal_fat_g != null &&
    profile.goal_carbs_g != null
      ? {
          calories: profile.goal_calories,
          protein_g: profile.goal_protein_g,
          fat_g: profile.goal_fat_g,
          carbs_g: profile.goal_carbs_g,
        }
      : null;

  let proteinHitRate: number | null = null;
  if (targets && logged.length > 0) {
    const threshold = targets.protein_g * 0.9;
    const hits = logged.filter((d) => d.protein_g >= threshold).length;
    proteinHitRate = Math.round((hits / logged.length) * 100);
  }

  return NextResponse.json({
    today,
    since,
    days,
    series,
    averages,
    totals,
    targets,
    daysLogged: logged.length,
    proteinHitRate,
    bestProtein,
    highestCal,
  });
}
