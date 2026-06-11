import { NextRequest, NextResponse } from "next/server";
import {
  getMealDailyTotalsSince,
  getProfile,
  daysAgoStr,
  todayStr,
} from "@/lib/db";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Macros = { calories: number; protein_g: number; fat_g: number; carbs_g: number };

type DayBucket = Macros & {
  date: string;
  meals: number;
  trend: Macros;
};

// Trailing window (in days, inclusive of the day itself) used for the
// rolling-average trend line shown alongside the bar chart.
const TREND_WINDOW = 7;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const daysParam = parseInt(url.searchParams.get("days") || "14", 10);
  const days = Math.max(1, Math.min(60, Number.isFinite(daysParam) ? daysParam : 14));

  // Fetch extra lookback days so the trend line has a full window for every
  // visible day, including the leftmost one.
  const lookbackDays = days + (TREND_WINDOW - 1);
  const since = daysAgoStr(days - 1);
  const lookbackSince = daysAgoStr(lookbackDays - 1);
  const today = todayStr();

  const userId = getCurrentUserIdOrDefault();
  const [dailyTotals, profile] = await Promise.all([
    getMealDailyTotalsSince(userId, lookbackSince),
    getProfile(userId),
  ]);

  const byDate = new Map<string, DayBucket>();
  for (let i = 0; i < lookbackDays; i++) {
    const d = daysAgoStr(lookbackDays - 1 - i);
    byDate.set(d, {
      date: d,
      calories: 0,
      protein_g: 0,
      fat_g: 0,
      carbs_g: 0,
      meals: 0,
      trend: { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
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

  const fullSeries = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Trailing rolling average for each day, over up to TREND_WINDOW days
  // (including days before `since`, used only for this calculation).
  for (let i = 0; i < fullSeries.length; i++) {
    const start = Math.max(0, i - (TREND_WINDOW - 1));
    const slice = fullSeries.slice(start, i + 1);
    const sum = slice.reduce(
      (acc, d) => {
        acc.calories += d.calories;
        acc.protein_g += d.protein_g;
        acc.fat_g += d.fat_g;
        acc.carbs_g += d.carbs_g;
        return acc;
      },
      { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
    );
    fullSeries[i].trend = {
      calories: Math.round(sum.calories / slice.length),
      protein_g: Math.round(sum.protein_g / slice.length),
      fat_g: Math.round(sum.fat_g / slice.length),
      carbs_g: Math.round(sum.carbs_g / slice.length),
    };
  }

  const series = fullSeries.slice(-days);

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
