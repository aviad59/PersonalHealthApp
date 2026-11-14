// (Re)run the analysis for a draft — after an interrupted capture, a failed
// call, or with a clarifying question's answer folded in.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";
import { analyzeDraft, draftDto } from "@/lib/meal-drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const extraHint = typeof body?.hint === "string" ? body.hint.slice(0, 1000) : undefined;
  const userId = await getCurrentUserIdOrDefault();
  const lang = req.cookies.get("lang")?.value || "en";
  const row = await analyzeDraft(userId, id, { lang, extraHint });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ draft: draftDto(row) });
}
