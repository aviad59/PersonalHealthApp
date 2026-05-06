import { NextResponse } from "next/server";
import {
  getProfile,
  getMealsSince,
  getCachedWorkoutsSince,
  daysAgoStr,
} from "@/lib/db";
import { HevyWorkout } from "@/lib/hevy";
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
  meals: {
    date: string;
    calories: number | null;
    protein_g: number | null;
  }[],
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
  if (!cfg.hasWorkouts) {
    return NextResponse.json({ recovery: null });
  }
  const [profile, last3, cachedRecent] = await Promise.all([
    getProfile(userId),
    getMealsSince(userId, daysAgoStr(2)),
    getCachedWorkoutsSince(daysAgoStr(14)),
  ]);

  const dailies = dailyTotalsFromMeals(
    last3.map((m) => ({
      date: m.date,
      calories: m.calories,
      protein_g: m.protein_g,
    })),
  );
  const recentHevy = rowsToHevy(cachedRecent);

  const recovery = computeRecovery({
    goalCalories: profile?.goal_calories,
    goalProteinG: profile?.goal_protein_g,
    last3Days: dailies,
    recentWorkouts: recentHevy,
  });

  return NextResponse.json({ recovery });
}
