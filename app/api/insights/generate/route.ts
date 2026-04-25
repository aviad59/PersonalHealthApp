import { NextRequest, NextResponse } from "next/server";
import {
  getDb,
  getProfile,
  getMealsByDate,
  getMealsSince,
  todayStr,
  daysAgoStr,
} from "@/lib/db";
import { anthropic, CLAUDE_MODEL, extractJson } from "@/lib/anthropic";
import {
  DAILY_INSIGHT_SYSTEM,
  WEEKLY_INSIGHT_SYSTEM,
} from "@/lib/prompts";
import { listWorkouts, summarizeWeek, workoutVolumeKg, HevyWorkout } from "@/lib/hevy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type InsightType = "daily" | "weekly";

function dayTotals(meals: ReturnType<typeof getMealsByDate>) {
  return meals.reduce(
    (acc, m) => {
      acc.calories += m.calories ?? 0;
      acc.protein_g += m.protein_g ?? 0;
      acc.fat_g += m.fat_g ?? 0;
      acc.carbs_g += m.carbs_g ?? 0;
      acc.meals += 1;
      return acc;
    },
    { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0, meals: 0 },
  );
}

async function safeLoadWorkouts(): Promise<HevyWorkout[]> {
  if (!process.env.HEVY_API_KEY) return [];
  try {
    const r = await listWorkouts({ page: 1, pageSize: 10 });
    return r.workouts || [];
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const type: InsightType = body?.type === "weekly" ? "weekly" : "daily";

  const profile = getProfile();
  if (!profile) {
    return NextResponse.json(
      { error: "Profile not set up. Run onboarding first." },
      { status: 400 },
    );
  }

  const today = todayStr();

  const todayMeals = getMealsByDate(today);
  const weekMeals = getMealsSince(daysAgoStr(6));
  const workouts = await safeLoadWorkouts();

  const todayWorkouts = workouts.filter((w) => w.start_time.slice(0, 10) === today);
  const weekStart = daysAgoStr(6);
  const weekWorkouts = workouts.filter((w) => w.start_time.slice(0, 10) >= weekStart);

  const context: any = {
    profile: {
      age: profile.age,
      sex: profile.sex,
      weight_kg: profile.weight_kg,
      height_cm: profile.height_cm,
      body_fat_pct: profile.body_fat_pct,
      lean_mass_kg: profile.lean_mass_kg,
      activity_level: profile.activity_level,
      goal_mode: profile.goal_mode,
    },
    targets: {
      calories: profile.goal_calories,
      protein_g: profile.goal_protein_g,
      fat_g: profile.goal_fat_g,
      carbs_g: profile.goal_carbs_g,
      weekly_workout_target: profile.weekly_workout_target,
    },
    today: {
      date: today,
      totals: dayTotals(todayMeals),
      meals: todayMeals.map((m) => ({
        description: m.description,
        calories: m.calories,
        protein_g: m.protein_g,
        fat_g: m.fat_g,
        carbs_g: m.carbs_g,
        time: m.created_at,
      })),
      workouts: todayWorkouts.map((w) => ({
        title: w.title,
        volume_kg: workoutVolumeKg(w),
        start_time: w.start_time,
      })),
    },
    zepp: null as null | any,
  };

  if (type === "weekly") {
    const dayByDay: any[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = daysAgoStr(i);
      const ms = weekMeals.filter((m) => m.date === d);
      const ws = weekWorkouts.filter((w) => w.start_time.slice(0, 10) === d);
      dayByDay.push({
        date: d,
        totals: dayTotals(ms),
        workouts: ws.map((w) => ({ title: w.title, volume_kg: workoutVolumeKg(w) })),
      });
    }
    const weekSummary = summarizeWeek(weekWorkouts);
    const daysWithFood = dayByDay.filter((d) => d.totals.meals > 0);
    const avgCalories =
      daysWithFood.length > 0
        ? Math.round(
            daysWithFood.reduce((a, d) => a + d.totals.calories, 0) /
              daysWithFood.length,
          )
        : 0;
    const avgProtein =
      daysWithFood.length > 0
        ? Math.round(
            daysWithFood.reduce((a, d) => a + d.totals.protein_g, 0) /
              daysWithFood.length,
          )
        : 0;
    context.week = {
      days_logged: daysWithFood.length,
      avg_calories: avgCalories,
      avg_protein_g: avgProtein,
      workout_sessions: weekSummary.sessions,
      total_volume_kg: weekSummary.totalVolumeKg,
      by_muscle: weekSummary.byMuscle,
      day_by_day: dayByDay,
    };
  } else {
    const recent: any[] = [];
    for (let i = 6; i >= 1; i--) {
      const d = daysAgoStr(i);
      const ms = weekMeals.filter((m) => m.date === d);
      const ws = weekWorkouts.filter((w) => w.start_time.slice(0, 10) === d);
      recent.push({
        date: d,
        calories: dayTotals(ms).calories,
        protein_g: dayTotals(ms).protein_g,
        workouts: ws.map((w) => w.title),
      });
    }
    context.last_7_days = recent;
  }

  const system = type === "weekly" ? WEEKLY_INSIGHT_SYSTEM : DAILY_INSIGHT_SYSTEM;

  let parsed: { headline: string; body: string; tags?: string[] };
  try {
    const resp = await anthropic().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 500,
      system,
      messages: [{ role: "user", content: JSON.stringify(context, null, 2) }],
    });
    const text = resp.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
    parsed = extractJson<any>(text);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "generation_failed" },
      { status: 500 },
    );
  }

  const db = getDb();
  const res = db
    .prepare(
      `INSERT INTO insights (type, for_date, headline, body, tags_json, sources_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      type,
      today,
      parsed.headline,
      parsed.body,
      JSON.stringify(parsed.tags || []),
      JSON.stringify({
        meals_today: todayMeals.length,
        workouts_today: todayWorkouts.length,
        zepp: false,
      }),
    );

  const row = db
    .prepare("SELECT * FROM insights WHERE id = ?")
    .get(Number(res.lastInsertRowid)) as any;

  return NextResponse.json({
    ok: true,
    insight: {
      ...row,
      tags: parsed.tags || [],
    },
  });
}
