// Turn a draft into a real meal. The client sends the totals the user
// settled on (after portions / manual edits); the photos already in Blob are
// handed over to the meal row as-is, so nothing is re-uploaded.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteMealDraft, getMealDraft, insertMeal } from "@/lib/db";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const ConfirmSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  description: z.string().optional(),
  calories: z.number(),
  protein_g: z.number(),
  fat_g: z.number(),
  carbs_g: z.number(),
  items: z.array(z.any()).optional(),
  confidence: z.string().optional(),
});

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const parsed = ConfirmSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 400 });
  }
  const userId = await getCurrentUserIdOrDefault();
  const draft = await getMealDraft(userId, id);
  if (!draft) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const m = parsed.data;
  const date = m.date ?? draft.date;
  const mealId = await insertMeal(userId, {
    date,
    description: m.description,
    calories: m.calories,
    protein_g: m.protein_g,
    fat_g: m.fat_g,
    carbs_g: m.carbs_g,
    items: m.items,
    confidence: m.confidence,
    note: draft.note,
    photo_path: draft.photo_path,
    photo_thumb: draft.photo_thumb,
    photo_path_2: draft.photo_path_2,
    photo_thumb_2: draft.photo_thumb_2,
  });
  // The photos now belong to the meal — drop only the draft row.
  await deleteMealDraft(userId, id);
  return NextResponse.json({ ok: true, id: mealId, date });
}
