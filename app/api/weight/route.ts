import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getProfile,
  getWeightLog,
  upsertWeight,
  deleteWeight,
  setProfileWeight,
  setProfileGoalCalories,
  todayStr,
} from "@/lib/db";
import { analyzeWeightTrend, GoalMode } from "@/lib/calc";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PostSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  weight_kg: z.number().positive().max(400),
  note: z.string().max(200).optional(),
  sync_profile: z.boolean().optional(),
});

const PatchSchema = z.object({
  apply_delta_kcal: z.number().int(),
});

const DeleteSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function GET() {
  const userId = getCurrentUserIdOrDefault();
  const [log, profile] = await Promise.all([
    getWeightLog(userId),
    getProfile(userId),
  ]);
  const goalMode = (profile?.goal_mode as GoalMode) || "recomp";
  const trend = analyzeWeightTrend(
    log.map((e) => ({ date: e.date, weight_kg: e.weight_kg })),
    goalMode,
  );
  return NextResponse.json({
    log,
    trend,
    goal_mode: goalMode,
    today: todayStr(),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const userId = getCurrentUserIdOrDefault();
  const { date, weight_kg, note } = parsed.data;
  const useDate = date ?? todayStr();
  const sync = parsed.data.sync_profile !== false; // default true
  await upsertWeight(userId, useDate, weight_kg, note ?? null);
  if (sync && useDate === todayStr()) {
    await setProfileWeight(userId, weight_kg);
  }
  return NextResponse.json({ ok: true, date: useDate });
}

/** Apply the suggested calorie shift to profile.goal_calories. */
export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const userId = getCurrentUserIdOrDefault();
  const profile = await getProfile(userId);
  if (!profile || profile.goal_calories == null) {
    return NextResponse.json(
      { error: "no_profile_goals" },
      { status: 400 },
    );
  }
  const delta = parsed.data.apply_delta_kcal;
  const newKcal = Math.max(1000, profile.goal_calories + delta);
  const proteinKcal = (profile.goal_protein_g ?? 0) * 4;
  const fatKcal = (profile.goal_fat_g ?? 0) * 9;
  const newCarbs = Math.max(0, Math.round((newKcal - proteinKcal - fatKcal) / 4));
  await setProfileGoalCalories(userId, newKcal, newCarbs);
  return NextResponse.json({
    ok: true,
    new_goal_calories: newKcal,
    new_goal_carbs_g: newCarbs,
    delta,
  });
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const userId = getCurrentUserIdOrDefault();
  await deleteWeight(userId, parsed.data.date);
  return NextResponse.json({ ok: true });
}
