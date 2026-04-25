import { NextResponse } from "next/server";
import { getDb, daysAgoStr } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = {
  description: string;
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  count: number;
  last_date: string;
};

/**
 * Return meals that have been logged at least twice in the last 60 days,
 * grouped by a normalized description, with average macros and a count.
 */
export async function GET() {
  const db = getDb();
  const since = daysAgoStr(60);

  // Group by lowercased / trimmed description so minor casing differences merge.
  // (Hebrew characters aren't affected by LOWER, but the trim still helps.)
  const rows = db
    .prepare(
      `SELECT
         TRIM(LOWER(description)) AS key,
         description AS description,
         ROUND(AVG(calories)) AS calories,
         ROUND(AVG(protein_g)) AS protein_g,
         ROUND(AVG(fat_g))     AS fat_g,
         ROUND(AVG(carbs_g))   AS carbs_g,
         COUNT(*) AS count,
         MAX(date) AS last_date
       FROM meals
       WHERE description IS NOT NULL
         AND TRIM(description) <> ''
         AND date >= ?
       GROUP BY key
       HAVING count >= 2
       ORDER BY count DESC, last_date DESC
       LIMIT 8`,
    )
    .all(since) as (Row & { key: string })[];

  // Drop the grouping key before sending to client.
  const cleaned: Row[] = rows.map((r) => ({
    description: r.description,
    calories: r.calories,
    protein_g: r.protein_g,
    fat_g: r.fat_g,
    carbs_g: r.carbs_g,
    count: r.count,
    last_date: r.last_date,
  }));

  return NextResponse.json({ meals: cleaned });
}
