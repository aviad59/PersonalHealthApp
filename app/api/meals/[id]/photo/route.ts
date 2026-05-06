// Serve a meal's photo on demand.
//
// Photos are stored in the meals row as a base64 data URI (Vercel has no
// persistent filesystem, so we can't write to disk). This endpoint decodes
// the data URI back into bytes and serves them with proper Content-Type +
// long Cache-Control so the browser caches per-meal photos.

import { NextRequest, NextResponse } from "next/server";
import { getMealPhoto } from "@/lib/db";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }
  // Photo bytes are scoped to the meal owner — even if someone guesses a
  // meal id, only the user it belongs to receives the photo.
  const userId = getCurrentUserIdOrDefault();
  const dataUri = await getMealPhoto(userId, id);
  if (!dataUri) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Expect data:<mime>;base64,<payload>
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUri);
  if (!match) {
    // Legacy rows might still have a /uploads/... path. We can't serve those
    // (Vercel filesystem isn't persistent), so 404.
    return NextResponse.json({ error: "unsupported" }, { status: 404 });
  }

  const mime = match[1];
  const buf = Buffer.from(match[2], "base64");
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(buf.length),
      // Photos are immutable per meal id, so let the browser cache hard.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
