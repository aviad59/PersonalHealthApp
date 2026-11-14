// Server-side helpers for the quick-snap inbox (meal_drafts).
//
// A draft is analyzed right when it's captured, with the note the user typed
// at that moment — that's what makes it accurate. If that request dies (app
// closed, network dropped), the row stays 'pending' / stuck 'analyzing' and
// the inbox re-runs it from the photos in Blob.

import { analyzeMeal, type AnalyzeImage } from "@/lib/analyze";
import { fetchMealPhoto } from "@/lib/blob";
import { getMealDraft, updateMealDraft, type MealDraftRow } from "@/lib/db";

// An 'analyzing' row older than this was abandoned mid-flight.
const STALE_ANALYZING_MS = 90_000;

export type DraftDto = {
  id: number;
  date: string;
  note: string | null;
  status: MealDraftRow["status"];
  analysis: any | null;
  error: string | null;
  photo_thumb: string | null;
  photo_thumb_2: string | null;
  photo_path: string | null;
  photo_path_2: string | null;
  /** True when the client should (re)start analysis on its own. */
  needs_analysis: boolean;
};

export function draftDto(r: MealDraftRow): DraftDto {
  // SQLite datetime('now') is UTC "YYYY-MM-DD HH:MM:SS".
  const updated = Date.parse(r.updated_at.replace(" ", "T") + "Z");
  const stale = r.status === "analyzing" && Date.now() - updated > STALE_ANALYZING_MS;
  let analysis: any = null;
  try {
    analysis = r.analysis_json ? JSON.parse(r.analysis_json) : null;
  } catch {
    // corrupt row — treat as not analyzed
  }
  return {
    id: r.id,
    date: r.date,
    note: r.note,
    status: r.status,
    analysis,
    error: r.error,
    photo_thumb: r.photo_thumb,
    photo_thumb_2: r.photo_thumb_2,
    photo_path: r.photo_path ? `/api/meal-drafts/${r.id}/photo` : null,
    photo_path_2: r.photo_path_2 ? `/api/meal-drafts/${r.id}/photo?n=2` : null,
    needs_analysis: r.status === "pending" || stale,
  };
}

/**
 * Run the analyzer for a draft and store the outcome on the row. `images`
 * may be passed when the caller still has the bytes in memory (capture);
 * otherwise they're read back from Blob. `extraHint` carries a clarifying
 * question's answer on a re-run.
 */
export async function analyzeDraft(
  userId: string,
  id: number,
  opts: { lang: string; images?: AnalyzeImage[]; extraHint?: string },
): Promise<MealDraftRow | null> {
  const draft = await getMealDraft(userId, id);
  if (!draft) return null;
  await updateMealDraft(userId, id, { status: "analyzing", error: null });
  try {
    const images = opts.images ?? (await loadDraftImages(draft));
    if (!images.length) throw new Error("photo_missing");
    const hint = [draft.note?.trim(), opts.extraHint?.trim()].filter(Boolean).join(". ");
    const result = await analyzeMeal({ images, hint, lang: opts.lang });
    if (result.parseError || !result.analysis) {
      throw new Error(result.parseError || "analyze_failed");
    }
    await updateMealDraft(userId, id, {
      status: "ready",
      analysis_json: JSON.stringify(result.analysis),
      error: null,
    });
  } catch (e: any) {
    await updateMealDraft(userId, id, {
      status: "error",
      error: String(e?.message || e).slice(0, 300),
    });
  }
  return getMealDraft(userId, id);
}

async function loadDraftImages(d: MealDraftRow): Promise<AnalyzeImage[]> {
  const paths = [d.photo_path, d.photo_path_2].filter((p): p is string => !!p);
  const photos = await Promise.all(paths.map((p) => fetchMealPhoto(p)));
  return photos
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => ({
      mediaType: (p.contentType || "image/jpeg") as AnalyzeImage["mediaType"],
      base64: p.buffer.toString("base64"),
    }));
}
