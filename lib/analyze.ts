// Core meal analyzer — the single Claude call that turns a photo and/or a
// text description into structured macros. Extracted from the meal-analyze
// route so that BOTH the production endpoint (/api/meals/analyze) and the
// admin analyzer lab (/api/admin/analyzer/*) run the exact same code path.
// If the lab called a copy of this logic, its results wouldn't transfer to
// production — so everything funnels through analyzeMeal() here.

import { anthropic, CLAUDE_MODEL, extractJson } from "@/lib/anthropic";
import { mealVisionPrompt, mealTextPrompt } from "@/lib/prompts";

export type BaseMeal = {
  description?: string;
  calories?: number;
  protein_g?: number;
  fat_g?: number;
  carbs_g?: number;
};

/** A decoded image ready to hand to Claude as a base64 content block. */
export type AnalyzeImage = {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  base64: string;
};

export type AnalyzeInput = {
  images?: AnalyzeImage[];
  /** Free-text context accompanying a photo (the user's note/hint). */
  hint?: string;
  /** Text-only description when there is no photo. */
  text?: string;
  /** Repeat-with-modifier base meal, when re-logging a prior meal. */
  base?: BaseMeal | null;
  lang?: string;
  /** Override the model. Defaults to the production analyzer model. */
  model?: string;
  /** Override the system prompt. Defaults to the mode's production prompt. */
  system?: string;
};

export type AnalyzeResult = {
  analysis: any;
  /** The model's raw text reply, before JSON extraction. */
  raw: string;
  mode: "photo" | "text" | "repeat";
  model: string;
  /** The system prompt actually sent (default or override). */
  system: string;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  /** Set when the reply couldn't be parsed into JSON; analysis is null then. */
  parseError?: string;
};

/** The model production uses for meal analysis today. */
export const DEFAULT_ANALYZE_MODEL = CLAUDE_MODEL;

/**
 * Run one meal analysis. Pure orchestration around a single Claude call —
 * no request/DB/session concerns, so it can be driven from an API route, the
 * admin lab, or a batch eval runner. Callers decode any uploaded files into
 * `images` first.
 */
export async function analyzeMeal(input: AnalyzeInput): Promise<AnalyzeResult> {
  const lang = input.lang || "en";
  const model = input.model || DEFAULT_ANALYZE_MODEL;
  const hasPhoto = !!input.images && input.images.length > 0;
  const text = (input.text || "").trim();
  const hint = (input.hint || "").trim();
  const base = input.base ?? null;

  const mode: AnalyzeResult["mode"] = hasPhoto
    ? "photo"
    : base
      ? "repeat"
      : "text";
  const system =
    input.system ?? (hasPhoto ? mealVisionPrompt(lang) : mealTextPrompt(lang));

  // Build the user message identically to the original route so behavior is
  // byte-for-byte preserved for production callers.
  let content: any;
  if (hasPhoto) {
    const imageBlocks = input.images!.map((img) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: img.mediaType,
        data: img.base64,
      },
    }));
    const contextText = [hint, text].filter(Boolean).join(". ");
    const twoPhotoNote =
      input.images!.length > 1
        ? " (Two photos of the same meal are provided — e.g. both sides of a plate or package — use both to refine the estimate.)"
        : "";
    const userText = contextText
      ? `User context: ${contextText}\n\nAnalyze this meal and return the JSON.${twoPhotoNote}`
      : `Analyze this meal and return the JSON.${twoPhotoNote}`;
    content = [...imageBlocks, { type: "text", text: userText }];
  } else if (base) {
    const macros = `calories ${base.calories ?? "?"} kcal, protein ${base.protein_g ?? "?"}g, fat ${base.fat_g ?? "?"}g, carbs ${base.carbs_g ?? "?"}g`;
    const modifier = text || "same portion";
    content = `Previously logged meal: "${base.description ?? "(no description)"}" (${macros}).\nUser note for this new logging: "${modifier}".\nApply the modifier to the base meal and return the adjusted JSON.`;
  } else {
    content = `Describe-only meal from user:\n"${text}"\n\nEstimate the macros and return the JSON.`;
  }

  const startedAt = Date.now();
  const resp = await anthropic().messages.create({
    model,
    max_tokens: 800,
    system,
    messages: [{ role: "user", content }],
  });
  const latencyMs = Date.now() - startedAt;

  const raw = resp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  const usage = {
    input_tokens: resp.usage?.input_tokens ?? 0,
    output_tokens: resp.usage?.output_tokens ?? 0,
  };

  let analysis: any = null;
  let parseError: string | undefined;
  try {
    analysis = extractJson<any>(raw);
  } catch (e: any) {
    parseError = e?.message ?? "Could not parse JSON from model output";
  }

  return { analysis, raw, mode, model, system, usage, latencyMs, parseError };
}
