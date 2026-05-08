import { NextRequest, NextResponse } from "next/server";
import { anthropic, CLAUDE_FAST_MODEL, extractJson } from "@/lib/anthropic";
import { mealVisionPrompt, mealTextPrompt } from "@/lib/prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type BaseMeal = {
  description?: string;
  calories?: number;
  protein_g?: number;
  fat_g?: number;
  carbs_g?: number;
};

export async function POST(req: NextRequest) {
  const lang = req.cookies.get("lang")?.value || "en";
  const form = await req.formData();
  const file = form.get("photo");
  const hint = (form.get("hint") as string | null)?.trim() || "";
  const text = (form.get("text") as string | null)?.trim() || "";
  const baseRaw = (form.get("base") as string | null)?.trim() || "";
  let base: BaseMeal | null = null;
  if (baseRaw) {
    try {
      base = JSON.parse(baseRaw);
    } catch {
      return NextResponse.json(
        { error: "base must be valid JSON" },
        { status: 400 },
      );
    }
  }

  const hasPhoto = file instanceof File;
  if (!hasPhoto && !text && !base) {
    return NextResponse.json(
      { error: "need one of: photo, text, base" },
      { status: 400 },
    );
  }

  try {
    // --- PHOTO MODE (with optional hint or text context) ---
    if (hasPhoto) {
      const buf = Buffer.from(await (file as File).arrayBuffer());
      const mediaType = ((file as File).type || "image/jpeg") as
        | "image/jpeg"
        | "image/png"
        | "image/gif"
        | "image/webp";
      const base64 = buf.toString("base64");

      const contextText = [hint, text].filter(Boolean).join(". ");
      const userText = contextText
        ? `User context: ${contextText}\n\nAnalyze this meal and return the JSON.`
        : "Analyze this meal and return the JSON.";

      // Haiku 4.5 + a tighter token budget. Meal analyses fit comfortably
      // in ~700 tokens; the previous 1800-token ceiling let the model
      // ramble and occasionally pushed the response past 8 s.
      const resp = await anthropic().messages.create({
        model: CLAUDE_FAST_MODEL,
        max_tokens: 800,
        system: mealVisionPrompt(lang),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: base64 },
              },
              { type: "text", text: userText },
            ],
          },
        ],
      });

      const body = resp.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      const parsed = extractJson<any>(body);
      return NextResponse.json({ analysis: parsed, mode: "photo" });
    }

    // --- TEXT / REPEAT-WITH-MODIFIER MODE ---
    let userMessage: string;
    if (base) {
      const macros = `calories ${base.calories ?? "?"} kcal, protein ${base.protein_g ?? "?"}g, fat ${base.fat_g ?? "?"}g, carbs ${base.carbs_g ?? "?"}g`;
      const modifier = text || "same portion";
      userMessage = `Previously logged meal: "${base.description ?? "(no description)"}" (${macros}).\nUser note for this new logging: "${modifier}".\nApply the modifier to the base meal and return the adjusted JSON.`;
    } else {
      userMessage = `Describe-only meal from user:\n"${text}"\n\nEstimate the macros and return the JSON.`;
    }

    const resp = await anthropic().messages.create({
      model: CLAUDE_FAST_MODEL,
      max_tokens: 800,
      system: mealTextPrompt(lang),
      messages: [{ role: "user", content: userMessage }],
    });
    const body = resp.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
    const parsed = extractJson<any>(body);
    return NextResponse.json({
      analysis: parsed,
      mode: base ? "repeat" : "text",
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "analyze_failed" },
      { status: 500 },
    );
  }
}
