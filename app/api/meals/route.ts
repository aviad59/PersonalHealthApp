import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { getDb, getMealsByDate, todayStr, getProfile } from "@/lib/db";
import { anthropic, CLAUDE_MODEL } from "@/lib/anthropic";
import { MEAL_TIP_SYSTEM } from "@/lib/prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SaveSchema = z.object({
  description: z.string().optional(),
  calories: z.number(),
  protein_g: z.number(),
  fat_g: z.number(),
  carbs_g: z.number(),
  items: z.array(z.any()).optional(),
  confidence: z.string().optional(),
  photo_base64: z.string().optional(),
  photo_ext: z.string().optional(),
  date: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const date = new URL(req.url).searchParams.get("date") ?? todayStr();
  const meals = await getMealsByDate(date);
  return NextResponse.json({ date, meals });
}

export async function POST(req: NextRequest) {
  const json = await req.json();
  const parsed = SaveSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const m = parsed.data;
  const date = m.date ?? todayStr();

  let photo_path: string | null = null;
  if (m.photo_base64) {
    try {
      const uploads = path.join(process.cwd(), "public", "uploads");
      if (!fs.existsSync(uploads)) fs.mkdirSync(uploads, { recursive: true });
      const ext = (m.photo_ext || "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "jpg";
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const full = path.join(uploads, name);
      fs.writeFileSync(full, Buffer.from(m.photo_base64, "base64"));
      photo_path = `/uploads/${name}`;
    } catch {
      photo_path = null;
    }
  }

  const db = await getDb();
  const ins = await db.execute({
    sql: `INSERT INTO meals (
        date, photo_path, description, calories, protein_g, fat_g, carbs_g, items_json, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      date,
      photo_path,
      m.description ?? null,
      m.calories,
      m.protein_g,
      m.fat_g,
      m.carbs_g,
      m.items ? JSON.stringify(m.items) : null,
      m.confidence ?? null,
    ],
  });
  const mealId = Number(ins.lastInsertRowid ?? 0);

  let tip: string | null = null;
  try {
    const profile = await getProfile();
    const todays = await getMealsByDate(date);
    if (profile) {
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
      const context = {
        targets: {
          calories: profile.goal_calories,
          protein_g: profile.goal_protein_g,
          fat_g: profile.goal_fat_g,
          carbs_g: profile.goal_carbs_g,
        },
        todaySoFar: totals,
        justLogged: {
          description: m.description,
          calories: m.calories,
          protein_g: m.protein_g,
          fat_g: m.fat_g,
          carbs_g: m.carbs_g,
        },
      };
      const r = await anthropic().messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 150,
        system: MEAL_TIP_SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(context) }],
      });
      tip = r.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join(" ")
        .trim();
      await db.execute({
        sql: `UPDATE meals SET ai_tip = ? WHERE id = ?`,
        args: [tip, mealId],
      });
    }
  } catch {
    // Tip generation is best-effort
  }

  return NextResponse.json({ ok: true, id: mealId, ai_tip: tip });
}
