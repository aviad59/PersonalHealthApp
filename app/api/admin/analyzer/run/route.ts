import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId, isCurrentUserAdmin } from "@/lib/user-server";
import { getAnalyzerFixturesForRun, type AnalyzerFixture } from "@/lib/db";
import { analyzeMeal, type AnalyzeImage } from "@/lib/analyze";
import {
  scoreMacros,
  aggregate,
  DEFAULT_WITHIN_PCT,
  type FixtureScore,
  type Macros,
} from "@/lib/analyzer-score";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Scoring a set of fixtures fans out several model calls; give it room.
export const maxDuration = 300;

// Cap concurrent model calls so a large fixture set doesn't trip rate limits.
const CONCURRENCY = 4;

async function guard(): Promise<boolean> {
  const userId = await getCurrentUserId();
  if (!userId) return false;
  return isCurrentUserAdmin();
}

/** Map a fixture + a model reply into a scored row. */
async function runFixture(
  fx: AnalyzerFixture,
  opts: {
    model?: string;
    systemVision?: string;
    systemText?: string;
    lang: string;
    withinPct: number;
  },
): Promise<FixtureScore> {
  const expected: Macros = {
    calories: fx.expected_calories,
    protein_g: fx.expected_protein_g,
    fat_g: fx.expected_fat_g,
    carbs_g: fx.expected_carbs_g,
  };

  try {
    const images: AnalyzeImage[] | undefined =
      fx.mode === "photo" && fx.photo_base64
        ? [
            {
              mediaType: (fx.photo_mime as AnalyzeImage["mediaType"]) || "image/jpeg",
              base64: fx.photo_base64,
            },
          ]
        : undefined;

    const result = await analyzeMeal({
      images,
      // In photo mode the fixture's text is context; in text mode it's the meal.
      hint: fx.mode === "photo" ? fx.input_text || "" : "",
      text: fx.mode === "text" ? fx.input_text || "" : "",
      lang: opts.lang,
      model: opts.model,
      // Each mode uses its own prompt override (or the built-in default when
      // the override is empty).
      system: fx.mode === "photo" ? opts.systemVision : opts.systemText,
    });

    if (result.parseError || !result.analysis?.total) {
      return {
        fixtureId: fx.id,
        label: fx.label,
        expected,
        predicted: null,
        macros: [],
        passed: false,
        error: result.parseError || "model reply had no totals",
        latencyMs: result.latencyMs,
        usage: result.usage,
      };
    }

    const t = result.analysis.total;
    const predicted: Macros = {
      calories: Number(t.calories) || 0,
      protein_g: Number(t.protein_g) || 0,
      fat_g: Number(t.fat_g) || 0,
      carbs_g: Number(t.carbs_g) || 0,
    };
    const macros = scoreMacros(predicted, expected, opts.withinPct);

    return {
      fixtureId: fx.id,
      label: fx.label,
      expected,
      predicted,
      macros,
      passed: macros.every((m) => m.within),
      confidence: result.analysis.confidence ?? null,
      latencyMs: result.latencyMs,
      usage: result.usage,
    };
  } catch (e: any) {
    return {
      fixtureId: fx.id,
      label: fx.label,
      expected,
      predicted: null,
      macros: [],
      passed: false,
      error: e?.message ?? "analyze failed",
    };
  }
}

/** Run tasks with a bounded concurrency, preserving input order. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

export async function POST(req: NextRequest) {
  if (!(await guard())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const model =
    typeof body?.model === "string" && body.model.trim()
      ? body.model.trim()
      : undefined;
  const systemVision =
    typeof body?.systemVision === "string" && body.systemVision.trim()
      ? body.systemVision
      : undefined;
  const systemText =
    typeof body?.systemText === "string" && body.systemText.trim()
      ? body.systemText
      : undefined;
  const fixtureIds: string[] | undefined = Array.isArray(body?.fixtureIds)
    ? body.fixtureIds.map(String)
    : undefined;
  const withinPct =
    Number.isFinite(body?.withinPct) && body.withinPct > 0
      ? Number(body.withinPct)
      : DEFAULT_WITHIN_PCT;
  const lang = req.cookies.get("lang")?.value || "en";

  const fixtures = await getAnalyzerFixturesForRun(fixtureIds);
  if (!fixtures.length) {
    return NextResponse.json({ error: "no fixtures to run" }, { status: 400 });
  }

  const scores = await mapPool(fixtures, CONCURRENCY, (fx) =>
    runFixture(fx, { model, systemVision, systemText, lang, withinPct }),
  );

  return NextResponse.json({
    scores,
    summary: aggregate(scores),
    ran: {
      model: model || "default",
      withinPct,
      count: fixtures.length,
      // Echo whether a custom prompt was used, but not its full text.
      customPrompt: !!(systemVision || systemText),
    },
  });
}
