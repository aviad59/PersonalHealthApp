import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb, getProfile } from "@/lib/db";
import { computeGoalsFromMetrics, ActivityLevel, GoalMode } from "@/lib/calc";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ProfileSchema = z.object({
  age: z.number().int().min(10).max(110),
  sex: z.enum(["male", "female"]),
  height_cm: z.number().min(100).max(250),
  weight_kg: z.number().min(30).max(300),
  neck_cm: z.number().min(20).max(60),
  waist_cm: z.number().min(40).max(200),
  hips_cm: z.number().min(40).max(200).nullable().optional(),
  activity_level: z.enum([
    "sedentary",
    "light",
    "moderate",
    "active",
    "very_active",
  ]),
  goal_mode: z.enum(["recomp", "cut", "bulk", "maintain"]).optional(),
  weekly_workout_target: z.number().int().min(1).max(7).nullable().optional(),
});

export async function GET() {
  const userId = await getCurrentUserIdOrDefault();
  const profile = await getProfile(userId);
  return NextResponse.json({ profile });
}

export async function POST(req: NextRequest) {
  const json = await req.json();
  const parsed = ProfileSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const p = parsed.data;

  if (p.sex === "female" && !p.hips_cm) {
    return NextResponse.json(
      { error: "hips_cm is required for female body-fat calc" },
      { status: 400 },
    );
  }

  const goals = computeGoalsFromMetrics({
    age: p.age,
    sex: p.sex,
    heightCm: p.height_cm,
    weightKg: p.weight_kg,
    neckCm: p.neck_cm,
    waistCm: p.waist_cm,
    hipsCm: p.hips_cm ?? null,
    activity: p.activity_level as ActivityLevel,
    goalMode: (p.goal_mode ?? "recomp") as GoalMode,
    weeklyWorkoutTarget: p.weekly_workout_target ?? null,
  });

  const userId = await getCurrentUserIdOrDefault();
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO user_profile (
      user_id, age, sex, height_cm, weight_kg, neck_cm, waist_cm, hips_cm, activity_level,
      body_fat_pct, lean_mass_kg, bmr, tdee,
      goal_calories, goal_protein_g, goal_fat_g, goal_carbs_g,
      weekly_workout_target, weekly_volume_note, goal_mode, updated_at
    ) VALUES (
      :user_id, :age, :sex, :height_cm, :weight_kg, :neck_cm, :waist_cm, :hips_cm, :activity_level,
      :body_fat_pct, :lean_mass_kg, :bmr, :tdee,
      :goal_calories, :goal_protein_g, :goal_fat_g, :goal_carbs_g,
      :weekly_workout_target, :weekly_volume_note, :goal_mode, datetime('now')
    )
    ON CONFLICT(user_id) DO UPDATE SET
      age=excluded.age, sex=excluded.sex, height_cm=excluded.height_cm, weight_kg=excluded.weight_kg,
      neck_cm=excluded.neck_cm, waist_cm=excluded.waist_cm, hips_cm=excluded.hips_cm,
      activity_level=excluded.activity_level,
      body_fat_pct=excluded.body_fat_pct, lean_mass_kg=excluded.lean_mass_kg,
      bmr=excluded.bmr, tdee=excluded.tdee,
      goal_calories=excluded.goal_calories, goal_protein_g=excluded.goal_protein_g,
      goal_fat_g=excluded.goal_fat_g, goal_carbs_g=excluded.goal_carbs_g,
      weekly_workout_target=excluded.weekly_workout_target,
      weekly_volume_note=excluded.weekly_volume_note,
      goal_mode=excluded.goal_mode, updated_at=datetime('now')`,
    args: {
      user_id: userId,
      age: p.age,
      sex: p.sex,
      height_cm: p.height_cm,
      weight_kg: p.weight_kg,
      neck_cm: p.neck_cm,
      waist_cm: p.waist_cm,
      hips_cm: p.hips_cm ?? null,
      activity_level: p.activity_level,
      body_fat_pct: goals.body_fat_pct,
      lean_mass_kg: goals.lean_mass_kg,
      bmr: goals.bmr,
      tdee: goals.tdee,
      goal_calories: goals.goal_calories,
      goal_protein_g: goals.goal_protein_g,
      goal_fat_g: goals.goal_fat_g,
      goal_carbs_g: goals.goal_carbs_g,
      weekly_workout_target: goals.weekly_workout_target,
      weekly_volume_note: goals.weekly_volume_note,
      goal_mode: goals.goal_mode,
    },
  });

  return NextResponse.json({ ok: true, profile: await getProfile(userId) });
}

export async function PATCH(req: NextRequest) {
  const json = await req.json().catch(() => ({}));
  const userId = await getCurrentUserIdOrDefault();
  const db = await getDb();

  const hasLanguage = "language" in json;
  const hasNotes = "coach_notes" in json;
  if (!hasLanguage && !hasNotes) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  // Coach notes — free text, capped so a runaway paste can't bloat the row
  // or the prompt.
  if (hasNotes) {
    const notes = typeof json.coach_notes === "string" ? json.coach_notes.slice(0, 1000) : null;
    await db.execute({
      sql: "UPDATE user_profile SET coach_notes = ? WHERE user_id = ?",
      args: [notes && notes.trim() ? notes.trim() : null, userId],
    });
  }

  if (hasLanguage) {
    const { language } = json;
    if (language !== "en" && language !== "he") {
      return NextResponse.json({ error: "language must be en or he" }, { status: 400 });
    }
    await db.execute({
      sql: "UPDATE user_profile SET language = ? WHERE user_id = ?",
      args: [language, userId],
    });
    const resp = NextResponse.json({ ok: true });
    resp.cookies.set("lang", language, { path: "/", maxAge: 31536000, sameSite: "lax" });
    return resp;
  }

  return NextResponse.json({ ok: true });
}
