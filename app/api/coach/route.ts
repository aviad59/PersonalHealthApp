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
  Meal,
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
const MAX_TOOL_ROUNDS = 4;

// ---------------------------------------------------------------------------
// Tool definitions — the coach can call these to fetch deeper history on demand
// ---------------------------------------------------------------------------
const NUTRITION_TOOL = {
  name: "get_meal_history",
  description:
    "Fetch daily nutrition summaries for a specific date range. Use when the user asks about eating patterns, calorie/protein trends, or any nutrition question covering a period beyond the last 7 days already in the snapshot.",
  input_schema: {
    type: "object" as const,
    properties: {
      start_date: { type: "string", description: "Start date YYYY-MM-DD (inclusive)" },
      end_date: { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
    },
    required: ["start_date", "end_date"],
  },
};

const WORKOUT_TOOL = {
  name: "get_workout_history",
  description:
    "Fetch workout sessions for a specific date range. Use when the user asks about training history, progress on an exercise, volume trends, or any fitness question covering a period beyond the last 14 days already in the snapshot.",
  input_schema: {
    type: "object" as const,
    properties: {
      start_date: { type: "string", description: "Start date YYYY-MM-DD (inclusive)" },
      end_date: { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
    },
    required: ["start_date", "end_date"],
  },
};

const WEIGHT_TOOL = {
  name: "get_weight_history",
  description:
    "Fetch body weight log entries for a specific date range. Use when the user asks about weight trends, progress over months, or any question requiring weight data older than 14 days.",
  input_schema: {
    type: "object" as const,
    properties: {
      start_date: { type: "string", description: "Start date YYYY-MM-DD (inclusive)" },
      end_date: { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
    },
    required: ["start_date", "end_date"],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rowsToHevy(rows: { raw_json: string }[]): HevyWorkout[] {
  const out: HevyWorkout[] = [];
  for (const r of rows) {
    try { out.push(JSON.parse(r.raw_json) as HevyWorkout); } catch {}
  }
  return out;
}

function aggregateMealsByDay(meals: Meal[]): Record<string, { calories: number; protein_g: number; fat_g: number; carbs_g: number; meals: number }> {
  const out: Record<string, { calories: number; protein_g: number; fat_g: number; carbs_g: number; meals: number }> = {};
  for (const m of meals) {
    if (!out[m.date]) out[m.date] = { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0, meals: 0 };
    out[m.date].calories += m.calories ?? 0;
    out[m.date].protein_g += m.protein_g ?? 0;
    out[m.date].fat_g += m.fat_g ?? 0;
    out[m.date].carbs_g += m.carbs_g ?? 0;
    out[m.date].meals += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------
async function executeTool(
  name: string,
  input: { start_date: string; end_date: string },
  userId: UserId,
  hasWorkouts: boolean,
): Promise<unknown> {
  const { start_date, end_date } = input;

  if (name === "get_meal_history") {
    const meals = await getMealsSince(userId, start_date);
    const filtered = meals.filter((m) => m.date <= end_date);
    const byDay = aggregateMealsByDay(filtered);
    return {
      date_range: { start_date, end_date },
      days: Object.entries(byDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, ...v })),
    };
  }

  if (name === "get_workout_history") {
    if (!hasWorkouts) return { note: "workout tracking not enabled" };
    const rows = await getCachedWorkoutsSince(start_date);
    const workouts = rowsToHevy(rows).filter(
      (w) => dateKey(new Date(w.start_time || Date.now())) <= end_date,
    );
    return {
      date_range: { start_date, end_date },
      workouts: workouts.map((w) => ({
        title: w.title,
        date: dateKey(new Date(w.start_time || Date.now())),
        duration_min: Math.round(
          (new Date(w.end_time).getTime() - new Date(w.start_time).getTime()) / 60000,
        ),
        volume_kg: Math.round(workoutVolumeKg(w)),
        exercises: w.exercises
          .map((ex) => ({
            name: ex.title,
            sets: ex.sets
              .filter((s) => s.type !== "warmup" && (s.reps ?? 0) > 0)
              .map((s) => ({ reps: s.reps, weight_kg: s.weight_kg })),
          }))
          .filter((ex) => ex.sets.length > 0),
      })),
    };
  }

  if (name === "get_weight_history") {
    const entries = await getWeightLogSince(userId, start_date);
    return {
      date_range: { start_date, end_date },
      entries: entries
        .filter((w) => w.date <= end_date)
        .map((w) => ({ date: w.date, weight_kg: w.weight_kg })),
    };
  }

  return { error: `unknown tool: ${name}` };
}

// ---------------------------------------------------------------------------
// Context snapshot (same as before — last 7d meals, 14d weight/workouts)
// ---------------------------------------------------------------------------
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
    duration_min: Math.round(
      (new Date(w.end_time).getTime() - new Date(w.start_time).getTime()) / 60000,
    ),
    volume_kg: Math.round(workoutVolumeKg(w)),
    exercises: w.exercises
      .map((ex) => ({
        name: ex.title,
        sets: ex.sets
          .filter((s) => s.type !== "warmup" && (s.reps ?? 0) > 0)
          .map((s) => ({
            reps: s.reps,
            weight_kg: s.weight_kg,
            type: s.type !== "normal" ? s.type : undefined,
          })),
      }))
      .filter((ex) => ex.sets.length > 0),
  }));

  return {
    now: { date: today, hour: new Date().getHours() },
    has_workouts: cfg.hasWorkouts,
    note: "Use the provided tools to fetch data beyond these windows when the user asks about older history.",
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
    ...(cfg.hasWorkouts && {
      training_notes:
        "Legs are intentionally undertrained (already strong/overdeveloped). Priority is chest and arm (biceps/triceps) development. Don't surface leg volume as an issue.",
    }),
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
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

    await addCoachMessage(userId, "user", userMessage);

    const [context, history] = await Promise.all([
      buildContext(userId),
      getCoachMessages(userId, HISTORY_LIMIT),
    ]);

    const cfg = getUserConfig(userId);
    const tools = cfg.hasWorkouts
      ? [NUTRITION_TOOL, WORKOUT_TOOL, WEIGHT_TOOL]
      : [NUTRITION_TOOL, WEIGHT_TOOL];

    // Seed messages: data snapshot + persisted thread
    type MsgBlock = { role: "user" | "assistant"; content: string | any[] };
    const messages: MsgBlock[] = [
      {
        role: "user",
        content:
          "[CURRENT DATA SNAPSHOT — refreshed each turn]\n\n" +
          JSON.stringify(context, null, 2),
      },
      {
        role: "assistant",
        content:
          "Got it — I have your latest profile, today's meals, weight log, and recent workouts. I can also fetch older history if you ask. What's on your mind?",
      },
      ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];

    // Agentic loop — the model may call tools to fetch deeper history
    let finalReply = "";
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const resp = await anthropic().messages.create({
        model: CLAUDE_OPUS_MODEL,
        max_tokens: 1200,
        system: COACH_SYSTEM,
        tools,
        messages,
      });

      const toolUseBlocks = resp.content.filter((b: any) => b.type === "tool_use");
      const textBlocks = resp.content.filter((b: any) => b.type === "text");

      if (resp.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
        finalReply = textBlocks.map((b: any) => b.text).join("\n").trim();
        break;
      }

      // Append the assistant turn with tool_use blocks
      messages.push({ role: "assistant", content: resp.content });

      // Execute all requested tools in parallel
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block: any) => {
          let result: unknown;
          try {
            result = await executeTool(
              block.name,
              block.input as { start_date: string; end_date: string },
              userId,
              cfg.hasWorkouts,
            );
          } catch (e: any) {
            result = { error: e.message ?? "tool_error" };
          }
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: JSON.stringify(result),
          };
        }),
      );

      messages.push({ role: "user", content: toolResults });

      // If this was the last round and the model still wants tools, extract
      // any partial text so we don't return empty.
      if (round === MAX_TOOL_ROUNDS - 1) {
        finalReply = textBlocks.map((b: any) => b.text).join("\n").trim() || "(no response)";
      }
    }

    if (!finalReply) finalReply = "(no response)";

    await addCoachMessage(userId, "assistant", finalReply);
    return NextResponse.json({ reply: finalReply });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "coach_failed" },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  const userId = getCurrentUserIdOrDefault();
  await clearCoachMessages(userId);
  return NextResponse.json({ ok: true });
}
