// Body-measurement log — circumferences (waist/neck/hips/chest/arm/thigh)
// tracked over time. GET lists all entries; POST upserts one day; DELETE
// removes a day.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getAllMeasurements,
  upsertMeasurement,
  deleteMeasurement,
  todayStr,
} from "@/lib/db";
import { getCurrentUserId } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cm = z.number().min(1).max(300).nullable().optional();
const PostSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  waist_cm: cm,
  neck_cm: cm,
  hips_cm: cm,
  chest_cm: cm,
  arm_cm: cm,
  thigh_cm: cm,
  note: z.string().max(300).nullable().optional(),
});

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const log = await getAllMeasurements(userId);
  return NextResponse.json({ log, today: todayStr() });
}

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const json = await req.json().catch(() => ({}));
  const parsed = PostSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 400 });
  }
  const { date, ...fields } = parsed.data;
  // Require at least one measurement so we don't store empty rows.
  const hasAny = (
    ["waist_cm", "neck_cm", "hips_cm", "chest_cm", "arm_cm", "thigh_cm"] as const
  ).some((k) => typeof fields[k] === "number");
  if (!hasAny) {
    return NextResponse.json({ error: "provide at least one measurement" }, { status: 400 });
  }
  await upsertMeasurement(userId, { date: date ?? todayStr(), ...fields });
  const log = await getAllMeasurements(userId);
  return NextResponse.json({ ok: true, log });
}

export async function DELETE(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const date = new URL(req.url).searchParams.get("date");
  if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });
  await deleteMeasurement(userId, date);
  return NextResponse.json({ ok: true });
}
