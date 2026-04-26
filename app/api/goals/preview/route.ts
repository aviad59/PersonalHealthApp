import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { computeGoalsFromMetrics, ActivityLevel, GoalMode } from "@/lib/calc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const S = z.object({
  age: z.number(),
  sex: z.enum(["male", "female"]),
  height_cm: z.number(),
  weight_kg: z.number(),
  neck_cm: z.number(),
  waist_cm: z.number(),
  hips_cm: z.number().nullable().optional(),
  activity_level: z.enum(["sedentary", "light", "moderate", "active", "very_active"]),
  goal_mode: z.enum(["recomp", "cut", "bulk", "maintain"]).optional(),
  weekly_workout_target: z.number().int().min(1).max(7).nullable().optional(),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = S.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 400 });
  }
  const p = parsed.data;
  try {
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
    return NextResponse.json(goals);
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "calc_failed" }, { status: 400 });
  }
}
