// Daily-insight generation core, factored out so both the on-demand
// /api/insights/generate route and the morning /api/cron/daily-insight job
// can produce an insight for a given userId without each duplicating the
// context-building, LLM call, and DB write.

import {
  getDb,
  getProfile,
  getMealsByDate,
  getMealsSince,
  getInsights,
  todayStr,
  daysAgoStr,
  dateKey,
  Meal,
} from "@/lib/db";
import { anthropic, CLAUDE_MODEL, extractJson } from "@/lib/anthropic";
import { DAILY_INSIGHT_SYSTEM, MORNING_INSIGHT_ADDENDUM, withLanguage } from "@/lib/prompts";
import {
  listWorkouts,
  workoutVolumeKg,
  hasHevyKey,
  HevyWorkout,
} from "@/lib/hevy";
import { getUserConfig, type UserId } from "@/lib/user";

export type GeneratedInsight = {
  id: number;
  type: "daily";
  for_date: string;
  headline: string;
  body: string;
  tags: string[];
};

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

function safeParseTags(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function safeLoadWorkouts(userId: string): Promise<HevyWorkout[]> {
  if (!(await hasHevyKey(userId))) return [];
  try {
    const r = await listWorkouts({ page: 1, pageSize: 10 }, userId);
    return r.workouts || [];
  } catch {
    return [];
  }
}

/** Generate (and persist) today's daily insight for the given user.
 *  Throws if the profile isn't set up.
 *
 *  `morning: true` (the cron/push path) switches the prompt to a
 *  retrospective over recent days — at 8 AM "today" is always empty, and
 *  the user batch-uploads with up to a day of delay, so an empty
 *  yesterday usually means "not uploaded yet", not "didn't log". */
export async function generateDailyInsightForUser(
  userId: UserId,
  opts?: { morning?: boolean },
): Promise<GeneratedInsight> {
  const morning = opts?.morning ?? false;
  const cfg = await getUserConfig(userId);
  const profile = await getProfile(userId);
  if (!profile) {
    throw new Error("profile not set up");
  }

  const today = todayStr();
  const [todayMeals, weekMeals, workouts, recentInsights] = await Promise.all([
    getMealsByDate(userId, today),
    getMealsSince(userId, daysAgoStr(6)),
    cfg.hasWorkouts ? safeLoadWorkouts(userId) : Promise.resolve([] as HevyWorkout[]),
    getInsights(userId, 5),
  ]);

  const workoutKey = (w: HevyWorkout): string => {
    const t = Date.parse(w.start_time || "");
    return Number.isFinite(t) ? dateKey(new Date(t)) : "";
  };
  const todayWorkouts = workouts.filter((w) => workoutKey(w) === today);
  const sevenDaysAgo = daysAgoStr(6);
  const weekWorkouts = workouts.filter((w) => workoutKey(w) >= sevenDaysAgo);

  const nowHour = new Date().getHours();

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
    has_workouts: cfg.hasWorkouts,
    ...(profile.coach_notes ? { user_notes: profile.coach_notes } : {}),
    // Standing per-user training direction (from the user's config), if any.
    ...(cfg.trainingNotes ? { training_notes: cfg.trainingNotes } : {}),
    today: {
      date: today,
      current_hour: nowHour,
      day_complete: false,
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
    recentInsights: recentInsights.map((i) => ({
      headline: i.headline,
      tags: safeParseTags(i.tags_json),
      for_date: i.for_date,
    })),
  };

  const recent: any[] = [];
  for (let i = 6; i >= 1; i--) {
    const d = daysAgoStr(i);
    const ms = weekMeals.filter((m) => m.date === d);
    const ws = weekWorkouts.filter((w) => workoutKey(w) === d);
    const totals = dayTotals(ms);
    recent.push({
      date: d,
      calories: totals.calories,
      protein_g: totals.protein_g,
      fat_g: totals.fat_g,
      carbs_g: totals.carbs_g,
      meals_logged: totals.meals,
      workouts: ws.map((w) => w.title),
    });
  }
  context.last_7_days = recent;

  // Computed rollups so the model can spot the user's strongest area and the
  // single highest-leverage gap without re-deriving them from the daily array.
  // Averaged over LOGGED days only (empty days are usually "not uploaded yet").
  const loggedDays = recent.filter((r) => r.meals_logged > 0);
  const avgOf = (sel: (r: any) => number) =>
    loggedDays.length
      ? Math.round(loggedDays.reduce((a, r) => a + sel(r), 0) / loggedDays.length)
      : 0;
  const proteinTarget = profile.goal_protein_g ?? 0;
  context.week_summary = {
    days_logged: loggedDays.length,
    days_in_window: recent.length,
    avg_calories: avgOf((r) => r.calories),
    avg_protein_g: avgOf((r) => r.protein_g),
    avg_fat_g: avgOf((r) => r.fat_g),
    avg_carbs_g: avgOf((r) => r.carbs_g),
    // Share of logged days that hit ≥90% of the protein target.
    protein_hit_rate_pct:
      loggedDays.length && proteinTarget
        ? Math.round(
            (loggedDays.filter((r) => r.protein_g >= proteinTarget * 0.9).length /
              loggedDays.length) *
              100,
          )
        : null,
    workouts_this_week: cfg.hasWorkouts ? weekWorkouts.length : null,
    weekly_workout_target: profile.weekly_workout_target ?? null,
  };
  if (morning) {
    context.generated = "early-morning scheduled run, before the user has eaten or uploaded anything today";
  }

  const system = withLanguage(
    morning ? DAILY_INSIGHT_SYSTEM + MORNING_INSIGHT_ADDENDUM : DAILY_INSIGHT_SYSTEM,
    profile.language ?? "en",
  );
  const resp = await anthropic().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 500,
    temperature: 1,
    system,
    messages: [{ role: "user", content: JSON.stringify(context, null, 2) }],
  });
  const text = resp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
  const parsed = extractJson<{ headline: string; body: string; tags?: string[] }>(text);

  const db = await getDb();
  const ins = await db.execute({
    sql: `INSERT INTO insights (user_id, type, for_date, headline, body, tags_json, sources_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      userId,
      "daily",
      today,
      parsed.headline,
      parsed.body,
      JSON.stringify(parsed.tags || []),
      JSON.stringify({
        meals_today: todayMeals.length,
        workouts_today: todayWorkouts.length,
        zepp: false,
      }),
    ],
  });
  const id = Number(ins.lastInsertRowid ?? 0);
  return {
    id,
    type: "daily",
    for_date: today,
    headline: parsed.headline,
    body: parsed.body,
    tags: parsed.tags || [],
  };
}

/** Does the user already have a daily insight saved for today? */
export async function hasDailyInsightForToday(userId: string): Promise<boolean> {
  const db = await getDb();
  const today = todayStr();
  const res = await db.execute({
    sql: "SELECT 1 FROM insights WHERE user_id = ? AND type = 'daily' AND for_date = ? LIMIT 1",
    args: [userId, today],
  });
  return res.rows.length > 0;
}
