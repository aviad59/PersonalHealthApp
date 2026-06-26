// Serve a meal's photo on demand.
//
// Photos live in Vercel Blob (private) — the meals row only stores a short
// pathname. Older rows may still have the legacy base64 data URI stored
// directly; both are handled here. Either way, this route is the only thing
// that can read a photo back, since Blob access is private.

import { NextRequest, NextResponse } from "next/server";
import { getMealPhoto } from "@/lib/db";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";
import { fetchMealPhoto, isBlobPathname } from "@/lib/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }
  // ?n=2 selects the optional second photo (e.g. the back of a package).
  const which = req.nextUrl.searchParams.get("n") === "2" ? 2 : 1;
  // Photo bytes are scoped to the meal owner — even if someone guesses a
  // meal id, only the user it belongs to receives the photo.
  const userId = await getCurrentUserIdOrDefault();
  const ref = await getMealPhoto(userId, id, which);
  if (!ref) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let mime: string;
  let buf: Buffer;
  if (isBlobPathname(ref)) {
    const photo = await fetchMealPhoto(ref);
    if (!photo) return NextResponse.json({ error: "not_found" }, { status: 404 });
    mime = photo.contentType;
    buf = photo.buffer;
  } else {
    // Legacy row: data:<mime>;base64,<payload>
    const match = /^data:([^;]+);base64,(.+)$/i.exec(ref);
    if (!match) {
      return NextResponse.json({ error: "unsupported" }, { status: 404 });
    }
    mime = match[1];
    buf = Buffer.from(match[2], "base64");
  }

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(buf.length),
      // Photos are immutable per meal id, so let the browser cache hard.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
