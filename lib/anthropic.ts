import Anthropic from "@anthropic-ai/sdk";

// "Heavy" model — used for the daily/weekly insight pass where we want
// stronger reasoning over a week of meals + workouts.
export const CLAUDE_MODEL = "claude-sonnet-4-6";

// "Best" model — used for the AI coach where response quality matters most.
export const CLAUDE_OPUS_MODEL = "claude-opus-4-8";

// "Fast" model — for time-sensitive calls the user is sitting and waiting on:
// the next-meal tip and the home-page suggestion. Haiku 4.5 is dramatically
// faster (typical 1–3 s) while remaining capable of structured estimation and
// short context-aware suggestions.
//
// NOTE: meal photo/text analysis does NOT use this model. It runs on
// CLAUDE_MODEL (Sonnet) via DEFAULT_ANALYZE_MODEL in lib/analyze.ts — measured
// at ~9–10 s per meal, against ~3.3 s for Haiku. This comment used to claim
// analysis ran here, which was never true in code; switching it is a live
// accuracy-vs-latency decision, not an oversight to quietly fix.
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

/** Build a Claude image content block from a `data:<mime>;base64,<...>` URI, or null if malformed. */
export function imageBlockFromDataUri(dataUri: string | null | undefined) {
  if (!dataUri?.startsWith("data:")) return null;
  const commaIdx = dataUri.indexOf(",");
  const meta = dataUri.slice(0, commaIdx);
  const base64 = dataUri.slice(commaIdx + 1);
  const mediaType = (meta.match(/data:([^;]+)/) ?? [])[1] ?? "image/jpeg";
  return { type: "image" as const, source: { type: "base64" as const, media_type: mediaType as any, data: base64 } };
}

/**
 * Best-effort recovery of TRUNCATED JSON — the shape you get when a reply hits
 * max_tokens mid-array and the closing brackets never arrive.
 *
 * Scans once (string/escape aware) collecting positions where a value just
 * completed, then walks those candidate cut points backwards: trim there, drop
 * any dangling comma, close the still-open brackets, and try to parse. The
 * first prefix that parses wins, so we keep every complete element and discard
 * only the half-written tail. Returns null if nothing salvageable.
 */
function repairTruncatedJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[{[]/);
  if (start === -1) return null;
  const s = candidate.slice(start);

  const stack: string[] = [];
  const cuts: { index: number; stack: string[] }[] = [];
  let inStr = false;
  let esc = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') {
        inStr = false;
        cuts.push({ index: i + 1, stack: [...stack] });
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      cuts.push({ index: i + 1, stack: [...stack] });
    } else if (/[0-9a-zA-Z.+-]/.test(ch)) {
      // End of a scalar (number / true / false / null) when a delimiter follows.
      const next = s[i + 1];
      if (next === undefined || /[\s,\]}]/.test(next)) {
        cuts.push({ index: i + 1, stack: [...stack] });
      }
    }
  }

  // Newest cut points first; cap the attempts so a huge blob can't spin.
  const limit = Math.max(0, cuts.length - 500);
  for (let k = cuts.length - 1; k >= limit; k--) {
    const { index, stack: open } = cuts[k];
    if (open.length === 0) continue; // balanced already — extractJson would have won
    let out = s.slice(0, index).replace(/,\s*$/, "");
    for (let j = open.length - 1; j >= 0; j--) out += open[j] === "{" ? "}" : "]";
    try {
      return JSON.parse(out);
    } catch {
      // keep walking back
    }
  }
  return null;
}

/**
 * Like extractJson, but falls back to salvaging a truncated reply instead of
 * throwing. Use for calls whose output length scales with user data (e.g. one
 * array entry per meal), where a partial result beats a hard failure.
 */
export function extractJsonLoose<T = unknown>(text: string): { value: T; truncated: boolean } {
  try {
    return { value: extractJson<T>(text), truncated: false };
  } catch (err) {
    const repaired = repairTruncatedJson(text);
    if (repaired !== null) return { value: repaired as T, truncated: true };
    throw err;
  }
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
