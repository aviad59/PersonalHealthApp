// Coach macro review — sends today's meals (with photos) to Claude Opus,
// which checks logged macros against what it sees and returns per-meal
// corrections + an explanation.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getMealsByDateLite } from "@/lib/db";
import { anthropic, CLAUDE_OPUS_MODEL, extractJson, imageBlockFromDataUri } from "@/lib/anthropic";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

    // Build multimodal message: text description + photo thumbnails per meal
    const content: any[] = [];
    let intro = `Please review the following ${meals.length} meal${meals.length > 1 ? "s" : ""} logged on ${date}.`;
    if (question) intro += `\n\nUser question: ${question}`;
    content.push({ type: "text", text: intro });

    for (const meal of meals) {
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
      max_tokens: 2000,
      system: REVIEW_SYSTEM,
      messages: [{ role: "user", content }],
    });

    const text = resp.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    const result = extractJson<{ reviews: any[]; summary: string }>(text);

    // Enrich with description + photo_thumb from DB (AI only returns meal_id)
    const mealById = new Map(meals.map((m) => [m.id, m]));
    const reviews = result.reviews.map((r) => ({
      ...r,
      description: mealById.get(r.meal_id)?.description ?? "(unnamed)",
      photo_thumb: mealById.get(r.meal_id)?.photo_thumb ?? null,
      photo_thumb_2: mealById.get(r.meal_id)?.photo_thumb_2 ?? null,
    }));

    return NextResponse.json({ reviews, summary: result.summary });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "review_failed" }, { status: 500 });
  }
}
