// Quick-snap inbox: list drafts, and capture a new one.
//
// Capture uploads the photo(s), inserts the draft, and then analyzes it in the
// same request with the note typed at capture. The client doesn't wait on
// this call — it fires it and goes back to the camera — so the analysis
// latency never blocks the user. If the request is cut short, the row is
// left 'pending'/'analyzing' and the inbox finishes the job later.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createMealDraft, listMealDrafts, getMealDraft, todayStr } from "@/lib/db";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";
import { uploadMealPhotoBase64, thumbDataUri } from "@/lib/blob";
import { analyzeDraft, draftDto } from "@/lib/meal-drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CreateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().max(2000).optional(),
  photo_base64: z.string(),
  photo_thumb_base64: z.string().optional(),
  photo_base64_2: z.string().optional(),
  photo_thumb_base64_2: z.string().optional(),
});

export async function GET() {
  const userId = await getCurrentUserIdOrDefault();
  const rows = await listMealDrafts(userId);
  return NextResponse.json({ drafts: rows.map(draftDto) });
}

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserIdOrDefault();
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const d = parsed.data;

  const [photo_path, photo_path_2] = await Promise.all([
    uploadMealPhotoBase64(userId, d.photo_base64, "jpg"),
    uploadMealPhotoBase64(userId, d.photo_base64_2, "jpg"),
  ]);
  const id = await createMealDraft(userId, {
    date: d.date ?? todayStr(),
    note: d.note?.trim() || null,
    photo_path,
    photo_thumb: thumbDataUri(d.photo_thumb_base64),
    photo_path_2,
    photo_thumb_2: thumbDataUri(d.photo_thumb_base64_2),
  });

  // The bytes are already in memory — analyze from them rather than reading
  // the photos straight back out of Blob.
  const images = [d.photo_base64, d.photo_base64_2]
    .filter((b): b is string => !!b)
    .map((base64) => ({ mediaType: "image/jpeg" as const, base64 }));
  const lang = req.cookies.get("lang")?.value || "en";
  const row = (await analyzeDraft(userId, id, { lang, images })) ?? (await getMealDraft(userId, id));
  return NextResponse.json({ draft: row ? draftDto(row) : null });
}
