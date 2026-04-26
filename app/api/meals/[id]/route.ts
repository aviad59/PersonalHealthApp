import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  description: z.string().nullable().optional(),
  calories: z.number().nullable().optional(),
  protein_g: z.number().nullable().optional(),
  fat_g: z.number().nullable().optional(),
  carbs_g: z.number().nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function badId() {
  return NextResponse.json({ error: "invalid id" }, { status: 400 });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: { id: string } },
) {
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id) || id <= 0) return badId();

  const body = await req.json().catch(() => ({}));
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const p = parsed.data;

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (p.description !== undefined) {
    sets.push("description = ?");
    args.push(p.description);
  }
  if (p.calories !== undefined) {
    sets.push("calories = ?");
    args.push(p.calories);
  }
  if (p.protein_g !== undefined) {
    sets.push("protein_g = ?");
    args.push(p.protein_g);
  }
  if (p.fat_g !== undefined) {
    sets.push("fat_g = ?");
    args.push(p.fat_g);
  }
  if (p.carbs_g !== undefined) {
    sets.push("carbs_g = ?");
    args.push(p.carbs_g);
  }
  if (p.date !== undefined) {
    sets.push("date = ?");
    args.push(p.date);
  }
  if (sets.length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }

  const db = await getDb();
  args.push(id);
  const upd = await db.execute({
    sql: `UPDATE meals SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
  if (Number(upd.rowsAffected ?? 0) === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const r = await db.execute({
    sql: "SELECT * FROM meals WHERE id = ?",
    args: [id],
  });
  return NextResponse.json({ ok: true, meal: r.rows[0] });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: { id: string } },
) {
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id) || id <= 0) return badId();

  const db = await getDb();
  const res = await db.execute({
    sql: "DELETE FROM meals WHERE id = ?",
    args: [id],
  });
  if (Number(res.rowsAffected ?? 0) === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
