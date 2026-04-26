// Persistent "what to eat next" suggestion for the home page.
//
// We cache one row per day in the `suggestions` table and only regenerate
// when the underlying meal totals have meaningfully changed (different meal
// count, or > 50 kcal / > 10 g protein change). This keeps the card stable
// across page refreshes but keeps it relevant as the day evolves.

import { NextResponse } from "next/server";
import {
  getProfile,
  getMealsByDate,
  getCachedWorkoutsSince,
  getSuggestion,
  upsertSuggestion,
  todayStr,
  daysAgoStr,
  dateKey,
} from "@/lib/db";
import { anthropic, CLAUDE_MODEL } from "@/lib/anthropic";
import { MEAL_TIP_SYSTEM } from "@/lib/prompts";
import { HevyWorkout, workoutVolumeKg } from "@/lib/hevy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Totals = {
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
};

function sumTotals(meals: { calories: number | null; protein_g: number | null; fat_g: number | null; carbs_g: number | null }[]): Totals {
  return meals.reduce<Totals>(
    (acc, m) => {
      acc.calories += m.calories ?? 0;
      acc.protein_g += m.protein_g ?? 0;
      acc.fat_g += m.fat_g ?? 0;
      acc.carbs_g += m.carbs_g ?? 0;
      return acc;
    },
    { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
  );
}

function isStale(
  cached: { meals_count: number; totals_calories: number; totals_protein_g: number },
  current: { meals_count: number; totals_calories: number; totals_protein_g: number },
): boolean {
  if (cached.meals_count !== current.meals_count) return true;
  if (Math.abs(cached.totals_calories - current.totals_calories) > 50) return true;
  if (Math.abs(cached.totals_protein_g - current.totals_protein_g) > 10) return true;
  return false;
}

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

async function generate(args: {
  profile: NonNullable<Awaited<ReturnType<typeof getProfile>>>;
  totals: Totals;
  todaysMealsBrief: { description: string | null; calories: number | null; protein_g: number | null }[];
  todaysWorkout: HevyWorkout | null;
}): Promise<string> {
  const { profile, totals, todaysMealsBrief, todaysWorkout } = args;
  const context = {
    targets: {
      calories: profile.goal_calories,
      protein_g: profile.goal_protein_g,
      fat_g: profile.goal_fat_g,
      carbs_g: profile.goal_carbs_g,
    },
    todaySoFar: totals,
    mealsLogged: todaysMealsBrief,
    todaysWorkout: todaysWorkout
      ? {
          title: todaysWorkout.title,
          volume_kg: workoutVolumeKg(todaysWorkout),
        }
      : null,
  };
  const r = await anthropic().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 200,
    system: MEAL_TIP_SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(context) }],
  });
  return r.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join(" ")
    .trim();
}

export async function GET() {
  const date = todayStr();

  const [profile, meals, cachedRecent] = await Promise.all([
    getProfile(),
    getMealsByDate(date),
    getCachedWorkoutsSince(daysAgoStr(2)),
  ]);

  if (!profile) {
    return NextResponse.json({ suggestion: null, reason: "no_profile" });
  }

  const totals = sumTotals(meals);
  const current = {
    meals_count: meals.length,
    totals_calories: Math.round(totals.calories),
    totals_protein_g: Math.round(totals.protein_g),
  };

  const cached = await getSuggestion(date);
  if (cached && !isStale(cached, current)) {
    return NextResponse.json({
      suggestion: {
        body: cached.body,
        meals_count: cached.meals_count,
        totals_calories: cached.totals_calories,
        totals_protein_g: cached.totals_protein_g,
        updated_at: cached.updated_at,
        cached: true,
      },
    });
  }

  // Find today's workout (if any) so the tip can account for training.
  const todaysWorkout =
    rowsToHevy(cachedRecent).find((w) => {
      const t = Date.parse(w.start_time || "");
      return Number.isFinite(t) && dateKey(new Date(t)) === date;
    }) ?? null;

  let body: string;
  try {
    body = await generate({
      profile,
      totals,
      todaysMealsBrief: meals.map((m) => ({
        description: m.description,
        calories: m.calories,
        protein_g: m.protein_g,
      })),
      todaysWorkout,
    });
  } catch (e: any) {
    // If generation fails, fall back to the existing cached row if any.
    if (cached) {
      return NextResponse.json({
        suggestion: {
          body: cached.body,
          meals_count: cached.meals_count,
          totals_calories: cached.totals_calories,
          totals_protein_g: cached.totals_protein_g,
          updated_at: cached.updated_at,
          cached: true,
          stale: true,
          error: e?.message ?? "generation_failed",
        },
      });
    }
    return NextResponse.json(
      { suggestion: null, error: e?.message ?? "generation_failed" },
      { status: 500 },
    );
  }

  await upsertSuggestion({
    date,
    body,
    meals_count: current.meals_count,
    totals_calories: current.totals_calories,
    totals_protein_g: current.totals_protein_g,
  });

  return NextResponse.json({
    suggestion: {
      body,
      meals_count: current.meals_count,
      totals_calories: current.totals_calories,
      totals_protein_g: current.totals_protein_g,
      updated_at: new Date().toISOString(),
      cached: false,
    },
  });
}
