// Standalone workout-score endpoint. The home page reads the score from
// /api/today/training; this stays as a direct way to fetch it on its own.
import { NextResponse } from "next/server";
import { getProfile, getCachedWorkoutsSince, daysAgoStr } from "@/lib/db";
import { HevyWorkout } from "@/lib/hevy";
import { computeWorkoutScore } from "@/lib/workout-score";
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

export async function GET() {
  const userId = await getCurrentUserIdOrDefault();
  const cfg = await getUserConfig(userId);
  if (!cfg.hasWorkouts) {
    return NextResponse.json({ workoutScore: null });
  }
  const [profile, cachedRecent] = await Promise.all([
    getProfile(userId),
    // Four weeks, so the volume trend has three prior weeks to compare against.
    getCachedWorkoutsSince(userId, daysAgoStr(28)),
  ]);

  const workoutScore = computeWorkoutScore({
    recentWorkouts: rowsToHevy(cachedRecent),
    weeklyWorkoutTarget: profile?.weekly_workout_target,
  });

  return NextResponse.json({ workoutScore });
}
