import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId, isCurrentUserAdmin } from "@/lib/user-server";
import { getAnalyzerFixture } from "@/lib/db";
import { analyzeMeal, type AnalyzeImage } from "@/lib/analyze";
import {
  summarizeCell,
  scoreAgainstTruth,
  DEFAULT_WITHIN_PCT,
  type RunAttempt,
  type Macros,
} from "@/lib/analyzer-variance";
import { fetchDishImageBase64 } from "@/lib/nutrition5k";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One model call per (fixture, model, variant, pipeline) cell. Repeats were
// only useful when there was no ground truth and jitter was the sole signal;
// with real truth they multiply cost for little added information.
const RUNS_PER_CELL = 1;

/**
 * A realistic stand-in for a user's note. Dataset fixtures store the full
 * ingredient list (often 15+ entries down to salt and parsley); feeding that
 * verbatim invites the model to enumerate and cost every trace item, which is
 * nothing like what a user actually types. Keep the first few items.
 */
function shortDescription(text: string | null): string {
  if (!text) return "";
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.slice(0, 3).join(", ");
}

/** Total grams implied by an analysis, parsed from each item's portion. */
function massFromAnalysis(a: any): number {
  if (!a || !Array.isArray(a.items)) return 0;
  let total = 0;
  for (const it of a.items) {
    const m = String(it?.portion ?? "").match(/([\d.]+)\s*g/i);
    if (m) total += Number(m[1]) || 0;
  }
  return total;
}

async function guard(): Promise<boolean> {
  const userId = await getCurrentUserId();
  if (!userId) return false;
  return isCurrentUserAdmin();
}

/**
 * Analyze ONE fixture with ONE model, repeated `runs` times, and return the
 * per-run predictions plus variability stats. The client calls this once per
 * (fixture, model) cell and assembles the full grid.
 */
export async function POST(req: NextRequest) {
  if (!(await guard())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const fixtureId = String(body?.fixtureId || "");
  const model =
    typeof body?.model === "string" && body.model.trim()
      ? body.model.trim()
      : undefined;
  const runs = RUNS_PER_CELL;
  const systemVision =
    typeof body?.systemVision === "string" && body.systemVision.trim()
      ? body.systemVision
      : undefined;
  const systemText =
    typeof body?.systemText === "string" && body.systemText.trim()
      ? body.systemText
      : undefined;
  // Variant switch: run the photo with or without its accompanying
  // description, to measure how much the user's text note actually helps.
  // Text-mode fixtures always keep their text — it IS the input.
  const includeText = body?.includeText !== false;
  // Self-consistency: N parallel calls combined by median. 1 = off.
  const samples = Math.max(1, Math.min(7, Number(body?.samples) || 1));
  const pipeline: "single" | "two-stage" =
    body?.pipeline === "two-stage" ? "two-stage" : "single";
  const systemPerceive =
    typeof body?.systemPerceive === "string" && body.systemPerceive.trim()
      ? body.systemPerceive
      : undefined;
  const systemQuantify =
    typeof body?.systemQuantify === "string" && body.systemQuantify.trim()
      ? body.systemQuantify
      : undefined;
  const lang = req.cookies.get("lang")?.value || "en";

  if (!fixtureId) {
    return NextResponse.json({ error: "fixtureId is required" }, { status: 400 });
  }
  const fx = await getAnalyzerFixture(fixtureId);
  if (!fx) {
    return NextResponse.json({ error: "fixture not found" }, { status: 404 });
  }

  // Fixtures either embed their photo (manually added) or reference a public
  // dataset URL (imported). Resolve once here and reuse across every repeat.
  let images: AnalyzeImage[] | undefined;
  if (fx.mode === "photo") {
    if (fx.photo_base64) {
      images = [
        {
          mediaType: (fx.photo_mime as AnalyzeImage["mediaType"]) || "image/jpeg",
          base64: fx.photo_base64,
        },
      ];
    } else if (fx.source_url) {
      try {
        const img = await fetchDishImageBase64(fx.source_url);
        images = [{ mediaType: img.mediaType, base64: img.base64 }];
      } catch (e: any) {
        return NextResponse.json(
          { error: `could not load fixture image: ${e?.message ?? "fetch failed"}` },
          { status: 502 },
        );
      }
    }
  }

  const predictedMasses: number[] = [];
  let firstPerception:
    | { raw: string; parsed: any; latencyMs: number }
    | null = null;

  const doOne = async (): Promise<RunAttempt> => {
    try {
      const result = await analyzeMeal({
        images,
        hint:
          fx.mode === "photo" && includeText
            ? shortDescription(fx.input_text)
            : "",
        text: fx.mode === "text" ? fx.input_text || "" : "",
        lang,
        model,
        system: fx.mode === "photo" ? systemVision : systemText,
        pipeline,
        systemPerceive,
        systemQuantify,
        samples,
      });
      // Keep the first run's stage-1 reading so the lab can show what the
      // perceive pass actually saw.
      if (result.perception && !firstPerception) {
        firstPerception = {
          raw: result.perception.raw,
          parsed: result.perception.parsed,
          latencyMs: result.perception.latencyMs,
        };
      }
      if (result.parseError || !result.analysis?.total) {
        return {
          predicted: null,
          confidence: null,
          latencyMs: result.latencyMs,
          error: result.parseError || "no totals in reply",
        };
      }
      const t = result.analysis.total;
      const predicted: Macros = {
        calories: Number(t.calories) || 0,
        protein_g: Number(t.protein_g) || 0,
        fat_g: Number(t.fat_g) || 0,
        carbs_g: Number(t.carbs_g) || 0,
      };
      const massG = massFromAnalysis(result.analysis);
      if (massG > 0) predictedMasses.push(massG);
      return {
        predicted,
        confidence: result.analysis.confidence ?? null,
        latencyMs: result.latencyMs,
      };
    } catch (e: any) {
      return {
        predicted: null,
        confidence: null,
        latencyMs: 0,
        error: e?.message ?? "analyze failed",
      };
    }
  };

  // Repeats run concurrently — they're independent and we want the cell fast.
  const attempts = await Promise.all(Array.from({ length: runs }, () => doOne()));
  const summary = summarizeCell(attempts);

  // Score the mean prediction against known macros when the fixture carries
  // them (dataset imports). Manual fixtures have none — consistency only.
  const withinPct =
    Number.isFinite(body?.withinPct) && body.withinPct > 0
      ? Number(body.withinPct)
      : DEFAULT_WITHIN_PCT;
  const expected: Macros = {
    calories: fx.expected_calories,
    protein_g: fx.expected_protein_g,
    fat_g: fx.expected_fat_g,
    carbs_g: fx.expected_carbs_g,
  };
  const meanMass = predictedMasses.length
    ? predictedMasses.reduce((a, b) => a + b, 0) / predictedMasses.length
    : 0;
  const accuracy =
    fx.has_ground_truth && summary.okRuns > 0
      ? scoreAgainstTruth(summary, expected, withinPct, {
          predicted: meanMass,
          expected: fx.expected_mass_g ?? 0,
        })
      : null;

  return NextResponse.json({
    fixtureId,
    model: model || "default",
    includeText,
    samples,
    pipeline,
    perception: firstPerception,
    label: fx.label,
    attempts,
    summary,
    accuracy,
    expected: fx.has_ground_truth ? expected : null,
    expectedMass: fx.expected_mass_g ?? null,
  });
}
