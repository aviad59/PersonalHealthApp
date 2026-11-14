// Full-size photo of a draft, for tap-to-zoom in the inbox. Same ownership
// rule as meal photos: only the draft's owner gets the bytes.

import { NextRequest, NextResponse } from "next/server";
import { getMealDraft } from "@/lib/db";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";
import { fetchMealPhoto } from "@/lib/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "bad_id" }, { status: 400 });
  const userId = await getCurrentUserIdOrDefault();
  const draft = await getMealDraft(userId, id);
  const ref = req.nextUrl.searchParams.get("n") === "2" ? draft?.photo_path_2 : draft?.photo_path;
  if (!ref) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const photo = await fetchMealPhoto(ref);
  if (!photo) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return new NextResponse(new Uint8Array(photo.buffer), {
    status: 200,
    headers: {
      "Content-Type": photo.contentType,
      "Content-Length": String(photo.buffer.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
