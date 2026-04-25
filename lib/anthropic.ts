import Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_MODEL = "claude-sonnet-4-20250514";

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
  // Find first { ... } or [ ... ]
  const obj = candidate.match(/[\[{][\s\S]*[\]}]/);
  if (!obj) throw new Error("No JSON object found in model output");
  return JSON.parse(obj[0]) as T;
}
