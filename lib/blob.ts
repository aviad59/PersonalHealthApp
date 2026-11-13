// Meal photos used to be stored as base64 data URIs directly in the meals
// table. That bloats every row (even queries that don't select the photo
// columns still pay for the page reads), so photos now live in Vercel Blob
// and the DB only stores a short pathname. Blobs are private — the app's
// own ownership-checked routes are the only thing that can read them back.

import { put, get, del } from "@vercel/blob";

export async function uploadMealPhoto(
  buffer: Buffer,
  contentType: string,
  pathPrefix: string,
): Promise<string> {
  const result = await put(`${pathPrefix}.jpg`, buffer, {
    access: "private",
    contentType,
    addRandomSuffix: true,
  });
  return result.pathname;
}

function mimeForExt(ext: string | undefined): string {
  const cleanExt = (ext || "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 5).toLowerCase() || "jpg";
  return cleanExt === "png" ? "image/png" :
    cleanExt === "webp" ? "image/webp" :
    cleanExt === "gif" ? "image/gif" :
    "image/jpeg";
}

// Full-size photos go to Blob storage (private) — only a short pathname is
// stored in the row, instead of a 150-350KB base64 blob that would
// otherwise bloat every page read of that row.
export async function uploadMealPhotoBase64(
  userId: string,
  base64: string | undefined,
  ext: string | undefined,
): Promise<string | null> {
  if (!base64) return null;
  const buffer = Buffer.from(base64, "base64");
  return uploadMealPhoto(buffer, mimeForExt(ext), `meals/${userId}/${Date.now()}`);
}

// Thumbnails are tiny (~5-10KB) and shown inline for every meal in a list,
// so they stay as base64 in the row — that's cheaper than N extra round
// trips to Blob just to render a day's worth of thumbnails.
export function thumbDataUri(base64: string | undefined): string | null {
  return base64 ? `data:image/jpeg;base64,${base64}` : null;
}

export async function fetchMealPhoto(
  pathname: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const result = await get(pathname, { access: "private" });
  if (!result || result.statusCode !== 200) return null;
  const buffer = Buffer.from(await new Response(result.stream).arrayBuffer());
  return { buffer, contentType: result.blob.contentType };
}

export async function deleteMealPhoto(pathname: string): Promise<void> {
  await del(pathname).catch(() => {});
}

/** True if a stored photo reference is a Blob pathname rather than a legacy base64 data URI. */
export function isBlobPathname(ref: string | null | undefined): boolean {
  return !!ref && !ref.startsWith("data:");
}
