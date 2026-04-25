// Lightweight CSV parser + nutrition-log row normalization.
// Handles quoted fields, embedded commas, and "" escape for inner quotes.
// Works for the Hebrew nutrition log format we ship support for.

export type RawRow = {
  date: string;          // DD/MM/YYYY as-written
  calories: string;
  protein: string;
  carbs: string;
  fat: string;
  description: string;
};

export type NormalizedRow = {
  lineNumber: number;    // 1-based (excluding header)
  date: string;          // YYYY-MM-DD (normalized)
  description: string;
  calories: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  isSummary: boolean;    // e.g. "סה״כ יומי" row — aggregate, should NOT be imported
  missingFields: string[]; // e.g. ["carbs_g"]
};

/** Parse a CSV text blob into arrays of fields per row. RFC-4180-ish. */
export function parseCsv(text: string): string[][] {
  // Handle BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Last field
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully-empty trailing rows
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Convert DD/MM/YYYY → YYYY-MM-DD. Returns null on failure. */
export function normalizeDate(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function numOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * A row is treated as a summary/aggregate (not a real meal) when its
 * description matches the Hebrew "total" / "summary" markers used in the log.
 */
export function isSummaryDescription(desc: string): boolean {
  const t = (desc || "").trim();
  if (!t) return false;
  // Hebrew markers: סה"כ (total, with ״ or " between ה and כ), סיכום (summary)
  // We accept quoted-and-doubled (סה""כ) variants because CSV may keep one layer of quoting.
  // Match anywhere in the description so "סה"כ יומי סופי" etc. all hit.
  return /סה["״]{0,2}כ/.test(t) || /^סיכום/.test(t);
}

/** Normalize the spreadsheet into analyzable rows. Does NOT call AI yet. */
export function normalizeNutritionCsv(text: string): {
  rows: NormalizedRow[];
  errors: { line: number; message: string }[];
  summaryRows: NormalizedRow[];
} {
  const all = parseCsv(text);
  const errors: { line: number; message: string }[] = [];
  if (all.length === 0) return { rows: [], errors, summaryRows: [] };

  // Skip header if present
  const header = all[0];
  const headerLooksLikeHeader =
    header.length >= 6 &&
    !normalizeDate(header[0]) &&
    !numOrNull(header[1] || "");
  const dataRows = headerLooksLikeHeader ? all.slice(1) : all;

  const rows: NormalizedRow[] = [];
  const summaryRows: NormalizedRow[] = [];

  dataRows.forEach((r, idx) => {
    const lineNumber = idx + (headerLooksLikeHeader ? 2 : 1);
    if (r.length < 6) {
      errors.push({ line: lineNumber, message: "row has fewer than 6 columns" });
      return;
    }
    const [dateRaw, calRaw, pRaw, cRaw, fRaw, descRaw] = r;
    const date = normalizeDate(dateRaw);
    if (!date) {
      errors.push({ line: lineNumber, message: `unparseable date "${dateRaw}"` });
      return;
    }
    const calories = numOrNull(calRaw);
    const protein_g = numOrNull(pRaw);
    const carbs_g = numOrNull(cRaw);
    const fat_g = numOrNull(fRaw);
    const description = (descRaw || "").trim();

    const missingFields: string[] = [];
    if (calories === null) missingFields.push("calories");
    if (protein_g === null) missingFields.push("protein_g");
    if (fat_g === null) missingFields.push("fat_g");
    if (carbs_g === null) missingFields.push("carbs_g");

    const row: NormalizedRow = {
      lineNumber,
      date,
      description,
      calories,
      protein_g,
      fat_g,
      carbs_g,
      isSummary: isSummaryDescription(description),
      missingFields,
    };
    if (row.isSummary) summaryRows.push(row);
    else rows.push(row);
  });

  return { rows, errors, summaryRows };
}

/**
 * Fill carbs from kcal balance when all other macros are present.
 * Returns a new row with carbs_g set, and a flag noting the derivation.
 */
export function deriveCarbsFromKcal(row: NormalizedRow): {
  filled: NormalizedRow;
  derived: boolean;
} {
  if (
    row.carbs_g === null &&
    row.calories !== null &&
    row.protein_g !== null &&
    row.fat_g !== null
  ) {
    const carbs = Math.max(
      0,
      Math.round((row.calories - row.protein_g * 4 - row.fat_g * 9) / 4),
    );
    return {
      filled: {
        ...row,
        carbs_g: carbs,
        missingFields: row.missingFields.filter((x) => x !== "carbs_g"),
      },
      derived: true,
    };
  }
  return { filled: row, derived: false };
}
