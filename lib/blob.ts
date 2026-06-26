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
