// Slower follow-up to /api/today: workout cache + workout score.
// Split out so the home page can render macro rings & meals immediately
// (from /api/today) and stream the workout sections in after.

import { NextResponse } from "next/server";
import {
  getProfile,
  getCachedWorkoutsSince,
  todayStr,
  daysAgoStr,
  dateKey,
  startOfWeekStr,
  diffDaysKey,
} from "@/lib/db";
import { HevyWorkout, workoutVolumeKg, workoutDurationMin } from "@/lib/hevy";
import { estimateWorkoutBurn } from "@/lib/burn";
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

  // Users without a workouts setup (orly) have no Hevy data to score.
  if (!cfg.hasWorkouts) {
    return NextResponse.json({
      date: todayStr(),
      todaysWorkout: null,
      training_burn_kcal: 0,
      workoutScore: null,
      week: null,
    });
  }

  const [profile, cachedRecent] = await Promise.all([
    getProfile(userId),
    // 28 days: the workout score compares this week's volume against the
    // previous three, so it needs a four-week window.
    getCachedWorkoutsSince(userId, daysAgoStr(28)),
  ]);
  const today = todayStr();

  const recentHevy = rowsToHevy(cachedRecent);
  const todaysWorkoutHevy =
    recentHevy.find((w) => {
      const t = Date.parse(w.start_time || "");
      return Number.isFinite(t) && dateKey(new Date(t)) === today;
    }) ?? null;

  let todaysWorkout: null | {
    id: string;
    title: string;
    volume_kg: number;
    start_time: string;
    duration_min: number;
    burn_kcal: number;
    burn_reason: string;
  } = null;

  if (todaysWorkoutHevy) {
    const vol = workoutVolumeKg(todaysWorkoutHevy);
    const dur = workoutDurationMin(todaysWorkoutHevy);
    const burn = estimateWorkoutBurn({
      durationMin: dur,
      volumeKg: vol,
      bodyWeightKg: profile?.weight_kg,
    });
    todaysWorkout = {
      id: todaysWorkoutHevy.id,
      title: todaysWorkoutHevy.title,
      volume_kg: vol,
      start_time: todaysWorkoutHevy.start_time,
      duration_min: dur,
      burn_kcal: burn.kcal,
      burn_reason: burn.reason,
    };
  }

  const workoutScore = computeWorkoutScore({
    recentWorkouts: recentHevy,
    weeklyWorkoutTarget: profile?.weekly_workout_target,
    focus: (profile?.training_focus as any) ?? "upper",
  });

  // Weekly summary — count distinct workout dates Sunday→today, compare
  // against the user's weekly_workout_target. We compute pace so the UI
  // can flag "behind / on / ahead" without re-doing the math client-side.
  const weekStart = startOfWeekStr();
  const weekDates = new Set<string>();
  for (const w of recentHevy) {
    const t = Date.parse(w.start_time || "");
    if (!Number.isFinite(t)) continue;
    const key = dateKey(new Date(t));
    if (key >= weekStart && key <= today) weekDates.add(key);
  }
  const completed = weekDates.size;
  const target = profile?.weekly_workout_target ?? 0;
  const daysIntoWeek = diffDaysKey(today, weekStart) + 1; // 1 on Sun .. 7 on Sat
  // Linear pace: by day N of 7 you should have target * (N/7) done. We allow
  // a 1-workout grace before flagging "behind", since a missed Monday gym
  // is easy to catch up later in the week.
  let pace: "behind" | "on" | "ahead" = "on";
  if (target > 0) {
    const expected = (target * daysIntoWeek) / 7;
    if (completed + 1 < expected) pace = "behind";
    else if (completed >= target) pace = "ahead";
  }

  return NextResponse.json({
    date: today,
    todaysWorkout,
    training_burn_kcal: todaysWorkout?.burn_kcal ?? 0,
    workoutScore,
    week: {
      starts_on: weekStart,
      completed,
      target,
      pace,
    },
  });
}
