import { NextResponse } from "next/server";
import { refreshFrequentMeals } from "@/lib/db";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recompute and cache the "log again" list. The client fires this after a
 * meal save without waiting on it, so saving a meal stays a fast DB insert
 * and the recompute happens in the background.
 */
export async function POST() {
  const userId = getCurrentUserIdOrDefault();
  const meals = await refreshFrequentMeals(userId);
  return NextResponse.json({ ok: true, meals });
}
