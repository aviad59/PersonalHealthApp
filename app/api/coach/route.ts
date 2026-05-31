// AI coach chat — free-form Q&A about training and nutrition, grounded in
// the user's actual data. GET returns the persisted thread; POST appends a
// user turn, calls Claude with full context, persists both turns, returns
// the assistant reply.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getProfile,
  getMealsByDate,
  getMealsSince,
  getWeightLogSince,
  getCachedWorkoutsSince,
  getCoachMessages,
  addCoachMessage,
  clearCoachMessages,
  todayStr,
  daysAgoStr,
  dateKey,
} from "@/lib/db";
import { anthropic, CLAUDE_OPUS_MODEL } from "@/lib/anthropic";
import { COACH_SYSTEM } from "@/lib/prompts";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";
import { getUserConfig, type UserId } from "@/lib/user";
import { HevyWorkout, workoutVolumeKg, hasHevyKey } from "@/lib/hevy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PostSchema = z.object({
  message: z.string().min(1).max(2000),
});

const HISTORY_LIMIT = 30;

function rowsToHevy(rows: { raw_json: string }[]): HevyWorkout[] {
  const out: HevyWorkout[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.raw_json) as HevyWorkout);
    } catch {}
  }
  return out;
}

/**
 * Build the per-request user-data snapshot the coach reasons over.
 * Kept compact — only fields the model will actually use to answer
 * day-to-day questions. Updated every turn so advice always reflects
 * the latest meal/weight/workout.
 */
async function buildContext(userId: UserId): Promise<any> {
  const cfg = getUserConfig(userId);
  const today = todayStr();
  const [profile, todayMeals, weekMeals, weightLog, workoutRows] =
    await Promise.all([
      getProfile(userId),
      getMealsByDate(userId, today),
      getMealsSince(userId, daysAgoStr(6)),
      getWeightLogSince(userId, daysAgoStr(13)),
      cfg.hasWorkouts && hasHevyKey(userId)
        ? getCachedWorkoutsSince(daysAgoStr(13))
        : Promise.resolve([] as Awaited<ReturnType<typeof getCachedWorkoutsSince>>),
    ]);

  const totalsForMeals = (ms: typeof todayMeals) =>
    ms.reduce(
      (acc, m) => ({
        calories: acc.calories + (m.calories ?? 0),
        protein_g: acc.protein_g + (m.protein_g ?? 0),
        fat_g: acc.fat_g + (m.fat_g ?? 0),
        carbs_g: acc.carbs_g + (m.carbs_g ?? 0),
      }),
      { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
    );

  // Per-day rollup for the week so the coach can spot trends without
  // wading through every individual meal row.
  const byDate = new Map<string, ReturnType<typeof totalsForMeals> & { meals: number }>();
  for (let i = 6; i >= 0; i--) {
    const d = daysAgoStr(i);
    byDate.set(d, { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0, meals: 0 });
  }
  for (const m of weekMeals) {
    const b = byDate.get(m.date);
    if (!b) continue;
    b.calories += m.calories ?? 0;
    b.protein_g += m.protein_g ?? 0;
    b.fat_g += m.fat_g ?? 0;
    b.carbs_g += m.carbs_g ?? 0;
    b.meals += 1;
  }
  const week_by_day = Array.from(byDate.entries()).map(([date, v]) => ({ date, ...v }));

  const workouts = rowsToHevy(workoutRows);
  const recentWorkouts = workouts.slice(0, 8).map((w) => ({
    title: w.title,
    date: dateKey(new Date(w.start_time || Date.now())),
    duration_min: Math.round((new Date(w.end_time).getTime() - new Date(w.start_time).getTime()) / 60000),
    volume_kg: Math.round(workoutVolumeKg(w)),
    exercises: w.exercises.map((ex) => ({
      name: ex.title,
      sets: ex.sets
        .filter((s) => s.type !== "warmup" && (s.reps ?? 0) > 0)
        .map((s) => ({
          reps: s.reps,
          weight_kg: s.weight_kg,
          type: s.type !== "normal" ? s.type : undefined,
        })),
    })).filter((ex) => ex.sets.length > 0),
  }));

  return {
    now: { date: today, hour: new Date().getHours() },
    has_workouts: cfg.hasWorkouts,
    profile: profile && {
      age: profile.age,
      sex: profile.sex,
      height_cm: profile.height_cm,
      weight_kg: profile.weight_kg,
      body_fat_pct: profile.body_fat_pct,
      lean_mass_kg: profile.lean_mass_kg,
      activity_level: profile.activity_level,
      goal_mode: profile.goal_mode,
      language: profile.language,
    },
    targets: profile && {
      calories: profile.goal_calories,
      protein_g: profile.goal_protein_g,
      fat_g: profile.goal_fat_g,
      carbs_g: profile.goal_carbs_g,
      weekly_workout_target: profile.weekly_workout_target,
    },
    today: {
      totals: totalsForMeals(todayMeals),
      meals: todayMeals.map((m) => {
        let items: any[] | null = null;
        if (m.items_json) {
          try { items = JSON.parse(m.items_json); } catch {}
        }
        return {
          description: m.description,
          time: m.created_at,
          calories: m.calories,
          protein_g: m.protein_g,
          fat_g: m.fat_g,
          carbs_g: m.carbs_g,
          ...(items && items.length > 0 && {
            items: items.map((it: any) => ({
              name: it.name,
              portion: it.portion,
              calories: it.calories,
              protein_g: it.protein_g,
            })),
          }),
        };
      }),
    },
    week_by_day,
    weight_log_last_14d: weightLog.map((w) => ({ date: w.date, weight_kg: w.weight_kg })),
    ...(cfg.hasWorkouts && { recent_workouts: recentWorkouts }),
    // User-set training priorities mirror what the insight prompt sees.
    ...(cfg.hasWorkouts && {
      training_notes:
        "Legs are intentionally undertrained (already strong/overdeveloped). Priority is chest and arm (biceps/triceps) development. Don't surface leg volume as an issue.",
    }),
  };
}

export async function GET() {
  try {
    const userId = getCurrentUserIdOrDefault();
    const messages = await getCoachMessages(userId, HISTORY_LIMIT);
    return NextResponse.json({ messages });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "failed to load thread" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = getCurrentUserIdOrDefault();
    const body = await req.json().catch(() => ({}));
    const parsed = PostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "validation", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const userMessage = parsed.data.message.trim();

    // Append the user turn first so it shows up in history even if the model
    // call fails or times out. We'll add the assistant turn after it returns.
    await addCoachMessage(userId, "user", userMessage);

    // Fetch context AND the just-saved history in parallel.
    const [context, history] = await Promise.all([
      buildContext(userId),
      getCoachMessages(userId, HISTORY_LIMIT),
    ]);

    // We pass the data snapshot as a synthetic first user message so the
    // model sees it as fresh ground truth without us having to stuff a huge
    // blob into the system prompt every turn.
    const messages: { role: "user" | "assistant"; content: string }[] = [
      {
        role: "user",
        content:
          "[CURRENT DATA SNAPSHOT — refreshed each turn so use these numbers, not anything older]\n\n" +
          JSON.stringify(context, null, 2),
      },
      {
        role: "assistant",
        content: "Got it — I have your latest profile, today's meals, weight log, and (if enabled) recent workouts. Ask anything.",
      },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    const resp = await anthropic().messages.create({
      model: CLAUDE_OPUS_MODEL,
      max_tokens: 600,
      system: COACH_SYSTEM,
      messages,
    });
    let reply = resp.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    if (!reply) reply = "(no response)";

    await addCoachMessage(userId, "assistant", reply);
    return NextResponse.json({ reply });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "coach_failed" },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  // "Clear conversation" button on the client calls this.
  const userId = getCurrentUserIdOrDefault();
  await clearCoachMessages(userId);
  return NextResponse.json({ ok: true });
}
