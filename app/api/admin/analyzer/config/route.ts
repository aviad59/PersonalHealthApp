import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId, isCurrentUserAdmin } from "@/lib/user-server";
import {
  mealVisionPrompt,
  mealTextPrompt,
  mealPerceivePrompt,
  mealQuantifyPrompt,
} from "@/lib/prompts";
import {
  CLAUDE_MODEL,
  CLAUDE_OPUS_MODEL,
  CLAUDE_FAST_MODEL,
} from "@/lib/anthropic";
import { DEFAULT_ANALYZE_MODEL } from "@/lib/analyze";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Supplies the analyzer lab UI with the real default prompts (so the editable
 * textarea starts from exactly what production sends) and the model choices.
 */
export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId || !(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const lang = req.cookies.get("lang")?.value || "en";

  return NextResponse.json({
    defaultModel: DEFAULT_ANALYZE_MODEL,
    // What production actually runs, so the lab can state its baseline rather
    // than leaving it to be inferred from a "(default)" suffix.
    production: {
      model: DEFAULT_ANALYZE_MODEL,
      // /api/meals/analyze passes no pipeline, so it takes the single-call path.
      pipeline: "single" as const,
      // It also passes no system override, so both prompts are the defaults.
      customPrompts: false,
    },
    visionPrompt: mealVisionPrompt(lang),
    textPrompt: mealTextPrompt(lang),
    perceivePrompt: mealPerceivePrompt(lang),
    quantifyPrompt: mealQuantifyPrompt(lang),
    models: [
      // Labels describe the model, not its role — which model is "default"
      // changes, and the picker marks production separately.
      { id: CLAUDE_FAST_MODEL, label: "Haiku 4.5" },
      { id: CLAUDE_MODEL, label: "Sonnet 4.6" },
      { id: CLAUDE_OPUS_MODEL, label: "Opus 4.8" },
    ],
  });
}
