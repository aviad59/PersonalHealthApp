// Robust client-side JSON fetch helper.
//
// Why: When a Vercel serverless function times out, OOMs, or crashes,
// Vercel returns a plain HTML page beginning with "An error occurred with
// your deployment". Calling `await res.json()` on that throws the cryptic
// `Unexpected token 'A', "An error o"... is not valid JSON` error.
//
// This helper reads the response as text first and only then tries to
// JSON.parse it, so we can produce a useful error message with the actual
// status code and (truncated) body.

export type FetchJsonResult<T> = T;

export async function safeFetchJson<T = any>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (e: any) {
    throw new Error(`network: ${e?.message ?? "request failed"}`);
  }

  const text = await res.text();

  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body — most likely a Vercel/edge error page or HTML.
    const snippet = text.slice(0, 160).replace(/\s+/g, " ").trim();
    if (res.status === 504 || /timeout|timed out/i.test(snippet)) {
      throw new Error("Server timed out. Try again in a moment.");
    }
    if (!res.ok) {
      throw new Error(`Server error (${res.status}). ${snippet}`);
    }
    throw new Error(`Unexpected non-JSON response. ${snippet}`);
  }

  if (!res.ok) {
    const msg =
      (json && (json.error || json.message)) ||
      `Request failed (${res.status})`;
    throw new Error(String(msg));
  }
  return json as T;
}
