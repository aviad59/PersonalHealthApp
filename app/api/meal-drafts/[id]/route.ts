import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteMealDraft, getMealDraft, updateMealDraft } from "@/lib/db";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";
import { deleteMealPhoto } from "@/lib/blob";
import { draftDto } from "@/lib/meal-drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().max(2000).optional(),
});

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function PATCH(req: NextRequest, ctx: { params: { id: string } }) {
  const id = parseId(ctx.params.id);
  if (!id) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 400 });
  }
  const userId = await getCurrentUserIdOrDefault();
  if (!(await getMealDraft(userId, id))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await updateMealDraft(userId, id, parsed.data);
  const row = await getMealDraft(userId, id);
  return NextResponse.json({ draft: row ? draftDto(row) : null });
}

/** Discard a snap: the row and its photos. */
export async function DELETE(_req: NextRequest, ctx: { params: { id: string } }) {
  const id = parseId(ctx.params.id);
  if (!id) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  const userId = await getCurrentUserIdOrDefault();
  const draft = await getMealDraft(userId, id);
  if (!draft) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await deleteMealDraft(userId, id);
  await Promise.all(
    [draft.photo_path, draft.photo_path_2]
      .filter((p): p is string => !!p)
      .map((p) => deleteMealPhoto(p)),
  );
  return NextResponse.json({ ok: true });
}
