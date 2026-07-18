import { NextRequest, NextResponse } from "next/server";
import {
  getMealDailyTotalsSince,
  getProfile,
  getGoalHistory,
  daysAgoStr,
  todayStr,
  type GoalSnapshot,
} from "@/lib/db";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Macros = { calories: number; protein_g: number; fat_g: number; carbs_g: number };

type DayBucket = Macros & {
  date: string;
  meals: number;
  trend: Macros;
  // The goal in effect on this specific day (may differ from the current
  // goal if targets were changed) — null when no goals are set at all.
  goal: Macros | null;
};

/** Resolve the goal in effect on `date`: the most recent snapshot with
 *  effective_date <= date, falling back to the current profile goals. */
function goalForDate(
  history: GoalSnapshot[],
  date: string,
  current: Macros | null,
): Macros | null {
  let chosen: GoalSnapshot | null = null;
  for (const g of history) {
    if (g.effective_date <= date) chosen = g;
    else break;
  }
  if (
    chosen &&
    chosen.goal_calories != null &&
    chosen.goal_protein_g != null &&
    chosen.goal_fat_g != null &&
    chosen.goal_carbs_g != null
  ) {
    return {
      calories: chosen.goal_calories,
      protein_g: chosen.goal_protein_g,
      fat_g: chosen.goal_fat_g,
      carbs_g: chosen.goal_carbs_g,
    };
  }
  return current;
}

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

  const userId = await getCurrentUserIdOrDefault();
  const [dailyTotals, profile, goalHistory] = await Promise.all([
    getMealDailyTotalsSince(userId, lookbackSince),
    getProfile(userId),
    getGoalHistory(userId),
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
      goal: null,
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

  // Attach the goal that was in effect on each day (falls back to the
  // current target when there's no dated history yet).
  for (const d of fullSeries) {
    d.goal = goalForDate(goalHistory, d.date, targets);
  }

  // Protein hit-rate judged against each day's OWN goal, so raising the
  // target today doesn't retroactively mark past hits as misses.
  let proteinHitRate: number | null = null;
  if (logged.length > 0) {
    const withGoal = logged.filter((d) => d.goal?.protein_g);
    if (withGoal.length > 0) {
      const hits = withGoal.filter((d) => d.protein_g >= d.goal!.protein_g * 0.9).length;
      proteinHitRate = Math.round((hits / withGoal.length) * 100);
    }
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
