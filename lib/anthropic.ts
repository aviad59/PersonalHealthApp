import Anthropic from "@anthropic-ai/sdk";

// "Heavy" model — used for the daily/weekly insight pass where we want
// stronger reasoning over a week of meals + workouts.
export const CLAUDE_MODEL = "claude-sonnet-4-20250514";

// "Best" model — used for the AI coach where response quality matters most.
export const CLAUDE_OPUS_MODEL = "claude-opus-4-8";

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

/** Pull a top-level JSON object out of Claude's text reply. */
export function extractJson<T = unknown>(text: string): T {
  // Try fenced block first
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  // Prefer object ({...}) since all meal/insight responses are objects.
  // Fall back to array ([...]) for the backfill endpoint.
  // Searching for { first avoids latching onto [...] brackets that appear
  // in the model's chain-of-thought reasoning (e.g. "[no reference objects]").
  const obj = candidate.match(/{[\s\S]*}/) ?? candidate.match(/\[[\s\S]*\]/);
  if (!obj) throw new Error("No JSON object found in model output");
  return JSON.parse(obj[0]) as T;
}
