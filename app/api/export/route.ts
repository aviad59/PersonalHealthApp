// Data export — CSV download of the signed-in user's meals or weight log.
// GET /api/export?type=meals   → all logged meals, oldest first
// GET /api/export?type=weight  → all weight entries, oldest first
//
// Plain GET so the Profile page can expose it as a simple download link
// (the session cookie rides along automatically).

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentUserId } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Quote when the value contains a delimiter, quote, or newline.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header: string[], rows: unknown[][]): string {
  // BOM so Excel opens Hebrew descriptions as UTF-8 instead of mojibake.
  return (
    "﻿" +
    [header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") +
    "\r\n"
  );
}

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const type = new URL(req.url).searchParams.get("type") || "meals";
  const db = await getDb();

  if (type === "weight") {
    const res = await db.execute({
      sql: `SELECT date, weight_kg, note, created_at
              FROM user_weight_log
             WHERE user_id = ?
             ORDER BY date ASC`,
      args: [userId],
    });
    const csv = toCsv(
      ["date", "weight_kg", "note", "created_at"],
      res.rows.map((r: any) => [r.date, r.weight_kg, r.note, r.created_at]),
    );
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="weight-${userId}.csv"`,
      },
    });
  }

  if (type === "meals") {
    const res = await db.execute({
      sql: `SELECT date, created_at, description, calories, protein_g, fat_g, carbs_g, confidence
              FROM meals
             WHERE user_id = ?
             ORDER BY date ASC, id ASC`,
      args: [userId],
    });
    const csv = toCsv(
      ["date", "logged_at", "description", "calories", "protein_g", "fat_g", "carbs_g", "confidence"],
      res.rows.map((r: any) => [
        r.date,
        r.created_at,
        r.description,
        r.calories,
        r.protein_g,
        r.fat_g,
        r.carbs_g,
        r.confidence,
      ]),
    );
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="meals-${userId}.csv"`,
      },
    });
  }

  return NextResponse.json({ error: "type must be meals or weight" }, { status: 400 });
}
