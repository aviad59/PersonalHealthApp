// Generate the "next meal" AI tip for a freshly-saved meal.
//
// This is split out from POST /api/meals so the save itself can return
// instantly (DB insert only). The client fires this endpoint after the
// save lands; the tip then trickles in. If the LLM call times out or
// errors, it fails quietly — the meal is already saved.

import { NextRequest, NextResponse } from "next/server";
import { getDb, getMealsByDate, getProfile, getRecentSuggestions } from "@/lib/db";
import { anthropic, CLAUDE_FAST_MODEL } from "@/lib/anthropic";
import { MEAL_TIP_SYSTEM, withLanguage } from "@/lib/prompts";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  const userId = await getCurrentUserIdOrDefault();
  const db = await getDb();

  const r = await db.execute({
    sql: `SELECT id, date, description, calories, protein_g, fat_g, carbs_g, ai_tip
          FROM meals WHERE id = ? AND user_id = ?`,
    args: [id, userId],
  });
  const row = r.rows[0] as any;
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (row.ai_tip) {
    return NextResponse.json({ ok: true, ai_tip: row.ai_tip, cached: true });
  }

  const profile = await getProfile(userId);
  if (!profile) {
    return NextResponse.json({ ok: true, ai_tip: null });
  }

  const todays = await getMealsByDate(userId, row.date);
  const totals = todays.reduce(
    (acc, x) => {
      acc.calories += x.calories ?? 0;
      acc.protein_g += x.protein_g ?? 0;
      acc.fat_g += x.fat_g ?? 0;
      acc.carbs_g += x.carbs_g ?? 0;
      return acc;
    },
    { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
  );

  // Anti-repetition context so the tip doesn't keep proposing the same
  // archetype every meal save.
  const recent = await getRecentSuggestions(userId, 5);

  const context = {
    targets: {
      calories: profile.goal_calories,
      protein_g: profile.goal_protein_g,
      fat_g: profile.goal_fat_g,
      carbs_g: profile.goal_carbs_g,
    },
    todaySoFar: totals,
    justLogged: {
      description: row.description,
      calories: row.calories,
      protein_g: row.protein_g,
      fat_g: row.fat_g,
      carbs_g: row.carbs_g,
    },
    recentSuggestions: recent.map((s) => s.body),
  };

  let tip: string | null = null;
  try {
    const resp = await anthropic().messages.create({
      model: CLAUDE_FAST_MODEL,
      max_tokens: 150,
      // Higher decoding spread for variety.
      temperature: 1,
      system: withLanguage(MEAL_TIP_SYSTEM, profile.language ?? "en"),
      messages: [{ role: "user", content: JSON.stringify(context) }],
    });
    tip = resp.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join(" ")
      .trim();
    if (tip) {
      await db.execute({
        sql: `UPDATE meals SET ai_tip = ? WHERE id = ? AND user_id = ?`,
        args: [tip, id, userId],
      });
    }
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "tip_failed" },
      { status: 200 }, // best-effort, don't break the client
    );
  }

  return NextResponse.json({ ok: true, ai_tip: tip });
}
