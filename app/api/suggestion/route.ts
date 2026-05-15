// Persistent "what to eat next" suggestion for the home page.
//
// We cache one row per user per day in user_suggestions and only regenerate
// when the underlying meal totals have meaningfully changed (different meal
// count, or > 50 kcal / > 10 g protein change). This keeps the card stable
// across page refreshes but keeps it relevant as the day evolves.

import { NextResponse } from "next/server";
import {
  getProfile,
  getMealsByDateLite,
  getCachedWorkoutsSince,
  getSuggestion,
  getRecentSuggestions,
  upsertSuggestion,
  todayStr,
  daysAgoStr,
  dateKey,
} from "@/lib/db";
import { anthropic, CLAUDE_FAST_MODEL } from "@/lib/anthropic";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";
import { getUserConfig } from "@/lib/user";
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
  recentSuggestions: string[];
}): Promise<string> {
  const { profile, totals, todaysMealsBrief, todaysWorkout, recentSuggestions } = args;
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
    // Anti-repetition context — the model is instructed to NOT pick a meal
    // similar to anything in this list.
    recentSuggestions,
  };
  const r = await anthropic().messages.create({
    model: CLAUDE_FAST_MODEL,
    max_tokens: 200,
    // Push variety: max temperature + top_p so the model stops collapsing
    // onto its highest-prior answer ("grilled chicken + vegetables").
    temperature: 1,
    top_p: 0.95,
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
  const userId = getCurrentUserIdOrDefault();
  const cfg = getUserConfig(userId);
  const date = todayStr();

  const [profile, meals, cachedRecent] = await Promise.all([
    getProfile(userId),
    getMealsByDateLite(userId, date),
    cfg.hasWorkouts
      ? getCachedWorkoutsSince(daysAgoStr(2))
      : Promise.resolve([] as Awaited<ReturnType<typeof getCachedWorkoutsSince>>),
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

  const cached = await getSuggestion(userId, date);
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

  const todaysWorkout =
    rowsToHevy(cachedRecent).find((w) => {
      const t = Date.parse(w.start_time || "");
      return Number.isFinite(t) && dateKey(new Date(t)) === date;
    }) ?? null;

  // Pull the last 5 suggestion bodies so the model can avoid repeating
  // itself. Includes today's previous suggestion if one already exists.
  const recent = await getRecentSuggestions(userId, 5);
  const recentSuggestions = recent.map((s) => s.body);

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
      recentSuggestions,
    });
  } catch (e: any) {
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

  await upsertSuggestion(userId, {
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
