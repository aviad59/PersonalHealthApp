// Core meal analyzer — the single Claude call that turns a photo and/or a
// text description into structured macros. Extracted from the meal-analyze
// route so that BOTH the production endpoint (/api/meals/analyze) and the
// admin analyzer lab (/api/admin/analyzer/*) run the exact same code path.
// If the lab called a copy of this logic, its results wouldn't transfer to
// production — so everything funnels through analyzeMeal() here.

import { anthropic, CLAUDE_MODEL, extractJson } from "@/lib/anthropic";
import {
  mealVisionPrompt,
  mealTextPrompt,
  mealPerceivePrompt,
  mealQuantifyPrompt,
} from "@/lib/prompts";

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
  /**
   * "single" (default, production): one call that sees the food and costs it.
   * "two-stage": a perceive pass (identify items/portions) feeding a quantify
   * pass (turn that reading into macros). Photo mode only — a text-only meal
   * has nothing to perceive.
   */
  pipeline?: "single" | "two-stage";
  /** Stage-1 prompt override (two-stage only). */
  systemPerceive?: string;
  /** Stage-2 prompt override (two-stage only). */
  systemQuantify?: string;
};

/** What stage 1 saw, surfaced so the lab can show where an error came from. */
export type PerceptionResult = {
  raw: string;
  parsed: any;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
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
  pipeline: "single" | "two-stage";
  /** Stage-1 output, present only for two-stage runs. */
  perception?: PerceptionResult;
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

  // Two-stage only makes sense when there's an image to perceive.
  if (input.pipeline === "two-stage" && hasPhoto) {
    return analyzeTwoStage(input, lang, model);
  }
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

  return {
    analysis,
    raw,
    mode,
    model,
    system,
    usage,
    latencyMs,
    parseError,
    pipeline: "single",
  };
}

/**
 * Convert stage 2's per-100g densities + masses into the app's Analysis shape,
 * doing the arithmetic in code rather than in the model.
 *
 * This is the "portion independent prediction x mass" factorization from the
 * Nutrition5k paper. Two benefits over asking the model for totals directly:
 * the multiplication is exact, and the totals are guaranteed to equal the sum
 * of the items (models routinely emit totals that don't match their own rows).
 */
function densitiesToAnalysis(d: any): any {
  if (!d || !Array.isArray(d.items)) {
    throw new Error("quantify stage returned no items");
  }
  const num = (v: any) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  const items = d.items.map((it: any) => {
    const mass = num(it.mass_g);
    const per = (v: any) => (num(v) * mass) / 100;
    return {
      name: it.name ?? "item",
      portion: `${Math.round(mass)} g`,
      calories: Math.round(per(it.kcal_per_100g)),
      protein_g: Math.round(per(it.protein_per_100g) * 10) / 10,
      fat_g: Math.round(per(it.fat_per_100g) * 10) / 10,
      carbs_g: Math.round(per(it.carbs_per_100g) * 10) / 10,
    };
  });

  const total = items.reduce(
    (a: any, it: any) => ({
      calories: a.calories + it.calories,
      protein_g: a.protein_g + it.protein_g,
      fat_g: a.fat_g + it.fat_g,
      carbs_g: a.carbs_g + it.carbs_g,
    }),
    { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
  );

  return {
    description: d.description ?? "",
    items,
    total: {
      calories: Math.round(total.calories),
      protein_g: Math.round(total.protein_g),
      fat_g: Math.round(total.fat_g),
      carbs_g: Math.round(total.carbs_g),
    },
    confidence: d.confidence ?? "medium",
    notes: d.notes ?? "",
    clarifying_question: d.clarifying_question ?? "",
  };
}

/** Build the base64 image content blocks shared by both stages. */
function imageBlocks(images: AnalyzeImage[]) {
  return images.map((img) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: img.mediaType,
      data: img.base64,
    },
  }));
}

/**
 * Two-stage analysis: perceive → quantify.
 *
 * Stage 1 answers "what is on this plate and how much of it", with no
 * nutrition math. Stage 2 receives that structured reading (plus the photo, so
 * it can sanity-check portions) and produces the macros. Splitting the work
 * means a wrong answer is attributable: either the food was mis-identified or
 * it was mis-costed.
 */
async function analyzeTwoStage(
  input: AnalyzeInput,
  lang: string,
  model: string,
): Promise<AnalyzeResult> {
  const images = input.images!;
  const hint = (input.hint || "").trim();
  const text = (input.text || "").trim();
  const context = [hint, text].filter(Boolean).join(". ");

  const perceiveSystem = input.systemPerceive ?? mealPerceivePrompt(lang);
  const quantifySystem = input.systemQuantify ?? mealQuantifyPrompt(lang);

  // ---- Stage 1: perceive ----
  const t1 = Date.now();
  const perceiveResp = await anthropic().messages.create({
    model,
    max_tokens: 1000,
    system: perceiveSystem,
    messages: [
      {
        role: "user",
        content: [
          ...imageBlocks(images),
          {
            type: "text",
            text: context
              ? `User context: ${context}\n\nIdentify the food and portions. Return the JSON.`
              : "Identify the food and portions. Return the JSON.",
          },
        ],
      },
    ],
  });
  const perceiveLatency = Date.now() - t1;
  const perceiveRaw = perceiveResp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  let perceived: any = null;
  try {
    perceived = extractJson<any>(perceiveRaw);
  } catch {
    // Stage 2 can still work from the raw text, so don't abort here.
  }

  const perception: PerceptionResult = {
    raw: perceiveRaw,
    parsed: perceived,
    usage: {
      input_tokens: perceiveResp.usage?.input_tokens ?? 0,
      output_tokens: perceiveResp.usage?.output_tokens ?? 0,
    },
    latencyMs: perceiveLatency,
  };

  // ---- Stage 2: quantify ----
  const reading = perceived ? JSON.stringify(perceived, null, 2) : perceiveRaw;
  const t2 = Date.now();
  const quantifyResp = await anthropic().messages.create({
    model,
    max_tokens: 800,
    system: quantifySystem,
    messages: [
      {
        role: "user",
        content: [
          ...imageBlocks(images),
          {
            type: "text",
            text: `Food-identification specialist's reading of this plate:\n${reading}\n\n${
              context ? `User context: ${context}\n\n` : ""
            }Convert this into macros and return the JSON.`,
          },
        ],
      },
    ],
  });
  const quantifyLatency = Date.now() - t2;

  const raw = quantifyResp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  let analysis: any = null;
  let parseError: string | undefined;
  try {
    analysis = densitiesToAnalysis(extractJson<any>(raw));
  } catch (e: any) {
    parseError = e?.message ?? "Could not parse JSON from model output";
  }

  return {
    analysis,
    raw,
    mode: "photo",
    model,
    system: quantifySystem,
    // Cost and latency are the sum of both stages — that's what the pipeline
    // actually costs, and what the lab should compare against single-call.
    usage: {
      input_tokens:
        perception.usage.input_tokens + (quantifyResp.usage?.input_tokens ?? 0),
      output_tokens:
        perception.usage.output_tokens + (quantifyResp.usage?.output_tokens ?? 0),
    },
    latencyMs: perceiveLatency + quantifyLatency,
    parseError,
    pipeline: "two-stage",
    perception,
  };
}
