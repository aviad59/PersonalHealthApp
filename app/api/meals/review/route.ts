// Coach macro review — sends today's meals (with photos) to Claude Opus,
// which checks logged macros against what it sees and returns per-meal
// corrections + an explanation.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getMealsByDateLite } from "@/lib/db";
import { anthropic, CLAUDE_OPUS_MODEL, extractJsonLoose, imageBlockFromDataUri } from "@/lib/anthropic";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// The reply carries one object per meal, so its length grows with the day's
// meal count. Reviewing every meal in a single call overflowed max_tokens on
// heavy days and truncated the JSON mid-array (parse error, whole check lost).
// Reviewing in bounded chunks keeps every reply comfortably short.
const MEALS_PER_CHUNK = 8;
const CHUNK_CONCURRENCY = 3;
const MAX_TOKENS_PER_CHUNK = 4000;

const MACRO_KEYS = ["calories", "protein_g", "fat_g", "carbs_g"] as const;

function isMacros(v: any): boolean {
  return !!v && MACRO_KEYS.every((k) => typeof v[k] === "number" && Number.isFinite(v[k]));
}

/**
 * A review is only usable if it carries a meal id and BOTH complete macro sets.
 * Salvaged (truncated) replies can end in a half-written entry — dropping those
 * keeps a partial object from rendering a broken card or being "accepted" into
 * the meal log with missing macros.
 */
function isCompleteReview(r: any): boolean {
  return !!r && typeof r.meal_id === "number" && isMacros(r.current) && isMacros(r.suggested);
}

const PostSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  question: z.string().max(500).optional(),
  meal_id: z.number().int().positive().optional(),
});

const REVIEW_SYSTEM = `You are a precise sports-nutrition expert reviewing a user's meal log.
For each meal you receive: description, logged macros, ingredient list (if available), and a photo (if one was taken).

Your task:
1. Estimate the true macros from the photo and/or description.
2. Compare to the logged values.
3. Suggest corrected macros where your estimate differs by more than ~10% on any macro.
4. Write a concise 1–2 sentence explanation of what you see and why you're suggesting a change (or confirming accuracy).

Rules:
- No photo: rely on description and ingredients only.
- Logged values look correct → set changed=false, suggested = current values exactly.
- Be specific: cite the food and portion ("the chicken breast looks ~180g not 120g").
- Explanation: max 40 words.
- Never suggest pork or shellfish. Never mix dairy and meat.
- Confidence: "high" if clear photo, "medium" if detailed description, "low" if vague.

Respond with ONLY a JSON object (no prose before/after):
{
  "reviews": [
    {
      "meal_id": <number>,
      "current": { "calories": <n>, "protein_g": <n>, "fat_g": <n>, "carbs_g": <n> },
      "suggested": { "calories": <n>, "protein_g": <n>, "fat_g": <n>, "carbs_g": <n> },
      "explanation": "<string>",
      "confidence": "low" | "medium" | "high",
      "changed": <boolean>
    }
  ],
  "summary": "<1-2 sentence overall assessment of the day's tracking accuracy>"
}`;

export async function POST(req: NextRequest) {
  try {
    const userId = await getCurrentUserIdOrDefault();
    const body = await req.json().catch(() => ({}));
    const parsed = PostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "validation" }, { status: 400 });
    }
    const { date, question, meal_id } = parsed.data;

    const allMeals = await getMealsByDateLite(userId, date);
    const meals = meal_id !== undefined ? allMeals.filter((m) => m.id === meal_id) : allMeals;
    if (meals.length === 0) {
      return NextResponse.json({ error: "no meals found" }, { status: 404 });
    }

    // Split into bounded chunks so no single reply can overflow max_tokens.
    const chunks: (typeof meals)[] = [];
    for (let i = 0; i < meals.length; i += MEALS_PER_CHUNK) {
      chunks.push(meals.slice(i, i + MEALS_PER_CHUNK));
    }

    const reviewChunk = async (
      chunk: typeof meals,
    ): Promise<{ reviews: any[]; summary: string }> => {
      const content: any[] = [];
      let intro = `Please review the following ${chunk.length} meal${chunk.length > 1 ? "s" : ""} logged on ${date}.`;
      if (question) intro += `\n\nUser question: ${question}`;
      content.push({ type: "text", text: intro });

      for (const meal of chunk) {
        let items: any[] | null = null;
        if (meal.items_json) { try { items = JSON.parse(meal.items_json); } catch {} }

        const lines = [
          `--- Meal ID: ${meal.id} ---`,
          `Description: ${meal.description ?? "(no description)"}`,
          `Logged: ${meal.calories ?? 0} kcal | Protein ${meal.protein_g ?? 0}g | Fat ${meal.fat_g ?? 0}g | Carbs ${meal.carbs_g ?? 0}g`,
          items && items.length > 0
            ? `Ingredients: ${items.map((it: any) => `${it.name} (${it.portion})`).join(", ")}`
            : null,
          meal.has_photo ? "(photo follows)" : "(no photo)",
        ].filter(Boolean).join("\n");

        content.push({ type: "text", text: lines });

        const img1 = imageBlockFromDataUri(meal.photo_thumb);
        if (img1) content.push(img1);
        const img2 = imageBlockFromDataUri(meal.photo_thumb_2);
        if (img2) content.push(img2);
      }

      const resp = await anthropic().messages.create({
        model: CLAUDE_OPUS_MODEL,
        max_tokens: MAX_TOKENS_PER_CHUNK,
        system: REVIEW_SYSTEM,
        messages: [{ role: "user", content }],
      });

      const text = resp.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");

      // Salvage rather than throw if a reply still comes back clipped, so one
      // over-long chunk can't wipe out the whole review.
      const { value } = extractJsonLoose<{ reviews?: any[]; summary?: string }>(text);
      return {
        reviews: Array.isArray(value?.reviews) ? value.reviews : [],
        summary: typeof value?.summary === "string" ? value.summary : "",
      };
    };

    // Run chunks with bounded concurrency; a failed chunk drops its meals
    // instead of failing the entire check.
    const results: { reviews: any[]; summary: string }[] = new Array(chunks.length);
    let failures = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < chunks.length) {
        const i = cursor++;
        try {
          results[i] = await reviewChunk(chunks[i]);
        } catch {
          results[i] = { reviews: [], summary: "" };
          failures++;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, () => worker()),
    );

    if (failures === chunks.length) {
      return NextResponse.json({ error: "review_failed" }, { status: 500 });
    }

    // Enrich with description + photo_thumb from DB (AI only returns meal_id),
    // dropping anything that doesn't map to a real meal from this request.
    const mealById = new Map(meals.map((m) => [m.id, m]));
    const seen = new Set<number>();
    const reviews = results
      .flatMap((r) => r.reviews)
      .filter((r) => {
        if (!isCompleteReview(r)) return false;
        if (!mealById.has(r.meal_id) || seen.has(r.meal_id)) return false;
        seen.add(r.meal_id);
        return true;
      })
      .map((r) => ({
        ...r,
        // Derive/normalize the optional fields so a salvaged entry still
        // renders consistently.
        changed:
          typeof r.changed === "boolean"
            ? r.changed
            : MACRO_KEYS.some((k) => r.suggested[k] !== r.current[k]),
        explanation: typeof r.explanation === "string" ? r.explanation : "",
        confidence: typeof r.confidence === "string" ? r.confidence : "medium",
        description: mealById.get(r.meal_id)?.description ?? "(unnamed)",
        photo_thumb: mealById.get(r.meal_id)?.photo_thumb ?? null,
        photo_thumb_2: mealById.get(r.meal_id)?.photo_thumb_2 ?? null,
      }));

    // One chunk keeps the model's own prose. Across several chunks the
    // per-chunk summaries only describe their own slice, so state the day's
    // result directly from the merged reviews instead.
    let summary = results.find((r) => r.summary)?.summary ?? "";
    if (chunks.length > 1) {
      const changed = reviews.filter((r) => r.changed);
      const netKcal = Math.round(
        changed.reduce(
          (a, r) => a + ((r.suggested?.calories ?? 0) - (r.current?.calories ?? 0)),
          0,
        ),
      );
      summary =
        changed.length === 0
          ? `Reviewed ${reviews.length} meals — everything looks accurate.`
          : `Reviewed ${reviews.length} meals — ${changed.length} look off. Applying the suggestions changes the day by ${netKcal >= 0 ? "+" : ""}${netKcal} kcal.`;
      if (reviews.length < meals.length) {
        summary += ` (${meals.length - reviews.length} could not be reviewed.)`;
      }
    }

    return NextResponse.json({ reviews, summary });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "review_failed" }, { status: 500 });
  }
}
