import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  normalizeNutritionCsv,
  deriveCarbsFromKcal,
  NormalizedRow,
} from "@/lib/csv";
import { anthropic, CLAUDE_MODEL, extractJson } from "@/lib/anthropic";
import { BACKFILL_FILL_SYSTEM } from "@/lib/prompts";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Resolution = "keep" | "replace" | "merge";

type AiFill = {
  index: number;
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  confidence?: string;
  note?: string;
};

type ImportRow = NormalizedRow & {
  derivedCarbs: boolean;
  aiFilled: boolean;
  aiConfidence?: string;
  aiNote?: string;
};

async function askClaudeToFill(rows: NormalizedRow[]): Promise<AiFill[]> {
  if (rows.length === 0) return [];
  const input = rows.map((r) => {
    const known: Record<string, number> = {};
    if (r.calories !== null) known.calories = r.calories;
    if (r.protein_g !== null) known.protein_g = r.protein_g;
    if (r.fat_g !== null) known.fat_g = r.fat_g;
    if (r.carbs_g !== null) known.carbs_g = r.carbs_g;
    return {
      index: r.lineNumber,
      description: r.description || "(no description)",
      known,
    };
  });

  const cli = anthropic();
  const resp = await cli.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    system: BACKFILL_FILL_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Backfill the missing macros for these meal rows. Return JSON array only.\n\n${JSON.stringify(input, null, 2)}`,
      },
    ],
  });
  const textBlock = resp.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content");
  }
  return extractJson<AiFill[]>(textBlock.text);
}

function groupByDate(rows: ImportRow[]): Map<string, ImportRow[]> {
  const m = new Map<string, ImportRow[]>();
  for (const r of rows) {
    const arr = m.get(r.date) ?? [];
    arr.push(r);
    m.set(r.date, arr);
  }
  return m;
}

function parseResolutions(raw: string | null): Record<string, Resolution> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const out: Record<string, Resolution> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v === "keep" || v === "replace" || v === "merge")
          out[k] = v as Resolution;
      }
      return out;
    }
  } catch {
    // ignore — treat as no resolutions
  }
  return {};
}

export async function POST(req: NextRequest) {
  const userId = getCurrentUserIdOrDefault();
  const form = await req.formData();
  const file = form.get("file");
  const dryRun =
    form.get("dryRun") === "true" || form.get("dryRun") === "1";
  const useAi =
    form.get("useAi") === "true" || form.get("useAi") === "1";
  const resolutions = parseResolutions(
    form.get("resolutions") as string | null,
  );
  const defaultPolicyRaw = form.get("defaultPolicy") as string | null;
  const defaultPolicy: Resolution | null =
    defaultPolicyRaw === "keep" ||
    defaultPolicyRaw === "replace" ||
    defaultPolicyRaw === "merge"
      ? defaultPolicyRaw
      : null;

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "file is required (multipart field 'file')" },
      { status: 400 },
    );
  }
  const text = await file.text();
  const { rows, errors, summaryRows } = normalizeNutritionCsv(text);

  const derivedRows: ImportRow[] = rows.map((r) => {
    const { filled, derived } = deriveCarbsFromKcal(r);
    return { ...filled, derivedCarbs: derived, aiFilled: false };
  });

  let aiFillCount = 0;
  const needsAi = derivedRows.filter((r) => r.missingFields.length > 0);

  if (useAi && needsAi.length > 0) {
    try {
      const chunks: NormalizedRow[][] = [];
      for (let i = 0; i < needsAi.length; i += 40) {
        chunks.push(needsAi.slice(i, i + 40));
      }
      const fills: AiFill[] = [];
      for (const chunk of chunks) {
        const got = await askClaudeToFill(chunk);
        fills.push(...got);
      }
      const byIdx = new Map<number, AiFill>();
      for (const f of fills) byIdx.set(f.index, f);

      for (const r of derivedRows) {
        if (r.missingFields.length === 0) continue;
        const f = byIdx.get(r.lineNumber);
        if (!f) continue;
        if (r.calories === null && Number.isFinite(f.calories)) r.calories = f.calories;
        if (r.protein_g === null && Number.isFinite(f.protein_g)) r.protein_g = f.protein_g;
        if (r.fat_g === null && Number.isFinite(f.fat_g)) r.fat_g = f.fat_g;
        if (r.carbs_g === null && Number.isFinite(f.carbs_g)) r.carbs_g = f.carbs_g;
        r.missingFields = [];
        if (r.calories !== null && r.protein_g !== null && r.fat_g !== null && r.carbs_g !== null) {
          r.aiFilled = true;
          r.aiConfidence = f.confidence;
          r.aiNote = f.note;
          aiFillCount++;
        }
      }
    } catch (err) {
      errors.push({
        line: 0,
        message: `Claude backfill failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const importable = derivedRows.filter(
    (r) => r.calories !== null && r.protein_g !== null && r.fat_g !== null && r.carbs_g !== null,
  );
  const incomplete = derivedRows.filter(
    (r) => r.calories === null || r.protein_g === null || r.fat_g === null || r.carbs_g === null,
  );

  const db = await getDb();
  const byDate = groupByDate(importable);
  const dates = Array.from(byDate.keys()).sort();

  type ExistingRow = {
    cnt: number;
    total_cal: number;
    total_p: number;
    total_f: number;
    total_c: number;
  };

  async function existingFor(date: string): Promise<ExistingRow> {
    const r = await db.execute({
      sql: `SELECT COUNT(*) AS cnt,
                   COALESCE(SUM(calories), 0)  AS total_cal,
                   COALESCE(SUM(protein_g), 0) AS total_p,
                   COALESCE(SUM(fat_g), 0)     AS total_f,
                   COALESCE(SUM(carbs_g), 0)   AS total_c
              FROM meals WHERE user_id = ? AND date = ?`,
      args: [userId, date],
    });
    return r.rows[0] as unknown as ExistingRow;
  }

  type Conflict = {
    date: string;
    existingCount: number;
    existingTotal: { calories: number; protein_g: number; fat_g: number; carbs_g: number };
    incomingCount: number;
    incomingTotal: { calories: number; protein_g: number; fat_g: number; carbs_g: number };
  };
  const conflicts: Conflict[] = [];
  const byDateInfo: { date: string; count: number; hasConflict: boolean }[] = [];

  const existingByDate = new Map<string, ExistingRow>();

  for (const date of dates) {
    const incoming = byDate.get(date)!;
    const row = await existingFor(date);
    existingByDate.set(date, row);
    const hasConflict = row.cnt > 0;
    byDateInfo.push({ date, count: incoming.length, hasConflict });
    if (hasConflict) {
      const incomingTotal = incoming.reduce(
        (acc, r) => {
          acc.calories += r.calories ?? 0;
          acc.protein_g += r.protein_g ?? 0;
          acc.fat_g += r.fat_g ?? 0;
          acc.carbs_g += r.carbs_g ?? 0;
          return acc;
        },
        { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
      );
      conflicts.push({
        date,
        existingCount: row.cnt,
        existingTotal: {
          calories: Math.round(row.total_cal),
          protein_g: Math.round(row.total_p),
          fat_g: Math.round(row.total_f),
          carbs_g: Math.round(row.total_c),
        },
        incomingCount: incoming.length,
        incomingTotal: {
          calories: Math.round(incomingTotal.calories),
          protein_g: Math.round(incomingTotal.protein_g),
          fat_g: Math.round(incomingTotal.fat_g),
          carbs_g: Math.round(incomingTotal.carbs_g),
        },
      });
    }
  }

  const summary = {
    totalRows: rows.length + summaryRows.length,
    summaryRowsSkipped: summaryRows.length,
    importableRows: importable.length,
    incompleteRows: incomplete.length,
    derivedCarbsCount: derivedRows.filter((r) => r.derivedCarbs).length,
    aiFilledCount: aiFillCount,
    datesCount: dates.length,
    conflictsCount: conflicts.length,
    errors,
  };

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      summary,
      conflicts,
      byDate: byDateInfo,
      preview: {
        importable: importable.slice(0, 50),
        incomplete: incomplete.slice(0, 20),
        skippedSummary: summaryRows.slice(0, 10),
      },
    });
  }

  const resolveFor = (date: string): Resolution => {
    const r = resolutions[date];
    if (r) return r;
    if (defaultPolicy) return defaultPolicy;
    return "keep";
  };

  let insertedCount = 0;
  let replacedDates = 0;
  let keptDates = 0;
  let mergedDates = 0;
  let deletedRowsCount = 0;
  const perDateResult: { date: string; resolution: Resolution | "insert"; inserted: number; deleted: number }[] = [];

  type Stmt = { sql: string; args: any[] };
  const stmts: Stmt[] = [];
  const opMap: { date: string; kind: "delete" | "insert" }[] = [];

  for (const date of dates) {
    const incoming = byDate.get(date)!;
    const row = existingByDate.get(date)!;
    const hasConflict = row.cnt > 0;
    let resolution: Resolution | "insert" = "insert";
    if (hasConflict) resolution = resolveFor(date);

    if (resolution === "keep") {
      keptDates++;
      perDateResult.push({ date, resolution, inserted: 0, deleted: 0 });
      continue;
    }

    if (resolution === "replace") {
      stmts.push({
        sql: "DELETE FROM meals WHERE user_id = ? AND date = ?",
        args: [userId, date],
      });
      opMap.push({ date, kind: "delete" });
      replacedDates++;
    } else if (resolution === "merge") {
      mergedDates++;
    }

    let localInserted = 0;
    for (const r of incoming) {
      stmts.push({
        sql: `INSERT INTO meals (user_id, date, description, calories, protein_g, fat_g, carbs_g, items_json, ai_tip, confidence, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, datetime('now'))`,
        args: [
          userId,
          r.date,
          r.description || null,
          r.calories,
          r.protein_g,
          r.fat_g,
          r.carbs_g,
          r.aiFilled ? (r.aiConfidence ?? "medium") : null,
        ],
      });
      opMap.push({ date, kind: "insert" });
      localInserted++;
    }
    insertedCount += localInserted;
    perDateResult.push({ date, resolution, inserted: localInserted, deleted: 0 });
  }

  if (stmts.length > 0) {
    const results = await db.batch(stmts, "write");
    for (let i = 0; i < results.length; i++) {
      const op = opMap[i];
      const ra = Number(results[i].rowsAffected ?? 0);
      if (op.kind === "delete") {
        deletedRowsCount += ra;
        const entry = perDateResult.find((p) => p.date === op.date);
        if (entry) entry.deleted = ra;
      }
    }
  }

  return NextResponse.json({
    dryRun: false,
    summary: {
      ...summary,
      insertedCount,
      deletedRowsCount,
      replacedDates,
      keptDates,
      mergedDates,
    },
    perDate: perDateResult,
  });
}
