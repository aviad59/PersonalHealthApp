import Anthropic from "@anthropic-ai/sdk";

// "Heavy" model — used for the daily/weekly insight pass where we want
// stronger reasoning over a week of meals + workouts.
export const CLAUDE_MODEL = "claude-sonnet-4-20250514";

// "Fast" model — used for time-sensitive calls the user is sitting and
// waiting on: meal photo/text analysis, the next-meal tip, and the
// home-page suggestion. Haiku 4.5 is dramatically faster (typical
// 1–3 s response) while remaining fully capable of structured macro
// estimation and short context-aware suggestions.
export const CLAUDE_FAST_MODEL = "claude-haiku-4-5-20251001";

let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local"
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

/** Pull a top-level JSON object out of Claude's text reply.
 *
 * The prompts ask the model to reason step-by-step in prose BEFORE the JSON,
 * and to put the JSON last. That reasoning frequently contains stray brackets
 * (e.g. "[no reference objects]" or "{calories: 165, protein: 31g}") which a
 * naive first-{-to-last-} regex would latch onto.
 *
 * Strategy: scan backward from the end for closing brackets, and for each
 * candidate end, walk forward looking for an opening bracket that yields a
 * valid JSON.parse. The first successful pair (i.e. the rightmost balanced
 * block) is the answer. Also tolerate trailing commas, which Haiku occasionally
 * emits.
 */
export function extractJson<T = unknown>(text: string): T {
  // Strip a fenced ```json ... ``` block if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();

  const tryParse = (s: string): T | undefined => {
    try { return JSON.parse(s) as T; } catch {}
    // Tolerate trailing commas: `[1,2,]` or `{"a":1,}`.
    try { return JSON.parse(s.replace(/,(\s*[}\]])/g, "$1")) as T; } catch {}
    return undefined;
  };

  // Walk from the end inward looking for closing brackets, then scan forward
  // for matching openers. Stops at the first parseable slice.
  for (let end = candidate.length - 1; end >= 0; end--) {
    const ec = candidate[end];
    if (ec !== "}" && ec !== "]") continue;
    const open = ec === "}" ? "{" : "[";
    for (let start = 0; start < end; start++) {
      if (candidate[start] !== open) continue;
      const parsed = tryParse(candidate.slice(start, end + 1));
      if (parsed !== undefined) return parsed;
    }
  }

  throw new Error("No JSON object found in model output");
}
