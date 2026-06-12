import { NextResponse } from "next/server";
import { getFrequentMeals } from "@/lib/db";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Return the cached "log again" list — meals logged at least twice in the
 * last 60 days, with average macros and a count. The list is precomputed
 * and refreshed by POST /api/meals/frequent/refresh after a meal is saved,
 * so this is just a cache read.
 */
export async function GET() {
  const userId = getCurrentUserIdOrDefault();
  const meals = await getFrequentMeals(userId);
  return NextResponse.json({ meals });
}
