import { NextRequest, NextResponse } from "next/server";
import {
  getDb,
  getProfile,
  getMealsByDate,
  getMealsSince,
  todayStr,
  daysAgoStr,
  dateKey,
  Meal,
} from "@/lib/db";
import { anthropic, CLAUDE_MODEL, extractJson } from "@/lib/anthropic";
import {
  DAILY_INSIGHT_SYSTEM,
  WEEKLY_INSIGHT_SYSTEM,
  withLanguage,
} from "@/lib/prompts";
import { listWorkouts, summarizeWeek, workoutVolumeKg, hasHevyKey, HevyWorkout } from "@/lib/hevy";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";
import { getUserConfig } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type InsightType = "daily" | "weekly";

function dayTotals(meals: Meal[]) {
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

async function safeLoadWorkouts(userId: string): Promise<HevyWorkout[]> {
  if (!hasHevyKey(userId)) return [];
  try {
    const r = await listWorkouts({ page: 1, pageSize: 10 }, userId);
    return r.workouts || [];
  } catch {
    return [];
  }
}
