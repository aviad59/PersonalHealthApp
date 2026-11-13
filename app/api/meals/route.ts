import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getMealsByDateLite, insertMeal, todayStr } from "@/lib/db";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";
import { uploadMealPhotoBase64, thumbDataUri } from "@/lib/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// DB insert only — no LLM call. Stays well under the platform default
// timeout, so this endpoint always returns a real JSON response.
export const maxDuration = 15;

const SaveSchema = z.object({
  description: z.string().optional(),
  calories: z.number(),
  protein_g: z.number(),
  fat_g: z.number(),
  carbs_g: z.number(),
  items: z.array(z.any()).optional(),
  confidence: z.string().optional(),
  icon: z.string().optional(),
  // The user's own note/description/hint at log time, kept verbatim.
  note: z.string().optional(),
  photo_base64: z.string().optional(),
  // Tiny inlineable thumbnail (~5–10 KB JPEG) generated client-side.
  photo_thumb_base64: z.string().optional(),
  photo_ext: z.string().optional(),
  // Optional second photo (e.g. the back of a package, or a second angle).
  photo_base64_2: z.string().optional(),
  photo_thumb_base64_2: z.string().optional(),
  photo_ext_2: z.string().optional(),
  date: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserIdOrDefault();
  const date = new URL(req.url).searchParams.get("date") ?? todayStr();
  const rows = await getMealsByDateLite(userId, date);
  const meals = rows.map((m) => ({
    id: m.id,
    date: m.date,
    description: m.description,
    calories: m.calories,
    protein_g: m.protein_g,
    fat_g: m.fat_g,
    carbs_g: m.carbs_g,
    items_json: m.items_json,
    ai_tip: m.ai_tip,
    confidence: m.confidence,
    icon: m.icon,
    created_at: m.created_at,
    photo_thumb: m.photo_thumb,
    photo_path: m.has_photo ? `/api/meals/${m.id}/photo` : null,
    photo_thumb_2: m.photo_thumb_2,
    photo_path_2: m.has_photo_2 ? `/api/meals/${m.id}/photo?n=2` : null,
  }));
  return NextResponse.json({ date, meals });
}

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserIdOrDefault();
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

  const [photo_path, photo_path_2] = await Promise.all([
    uploadMealPhotoBase64(userId, m.photo_base64, m.photo_ext),
    uploadMealPhotoBase64(userId, m.photo_base64_2, m.photo_ext_2),
  ]);
  const photo_thumb = thumbDataUri(m.photo_thumb_base64);
  const photo_thumb_2 = thumbDataUri(m.photo_thumb_base64_2);

  const mealId = await insertMeal(userId, {
    date,
    description: m.description,
    calories: m.calories,
    protein_g: m.protein_g,
    fat_g: m.fat_g,
    carbs_g: m.carbs_g,
    items: m.items,
    confidence: m.confidence,
    icon: m.icon,
    note: m.note,
    photo_path,
    photo_thumb,
    photo_path_2,
    photo_thumb_2,
  });

  // Just a fast DB insert — the client renders its own deterministic
  // "day so far" summary after reloading the meal list.
  return NextResponse.json({ ok: true, id: mealId });
}
