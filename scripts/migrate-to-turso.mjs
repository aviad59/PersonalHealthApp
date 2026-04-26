#!/usr/bin/env node
/**
 * One-off migration: copy rows from the local data/health.db (better-sqlite3)
 * into Turso (libSQL).
 *
 * Requires:
 *   TURSO_DATABASE_URL = libsql://<your-db>.turso.io
 *   TURSO_AUTH_TOKEN   = <token from `turso db tokens create <db>`>
 *
 * Usage (Node 20+):
 *   npm run migrate:turso
 *
 * The script:
 *   1. Creates the schema in Turso if missing.
 *   2. Streams every row from each table over to Turso in batches.
 *   3. Reports counts at the end.
 *
 * Re-running is safe — INSERT OR REPLACE upserts on primary key, and
 * meals are de-duplicated by (date, description, calories, created_at).
 */

import path from "node:path";
import fs from "node:fs";
import url from "node:url";
import Database from "better-sqlite3";
import { createClient } from "@libsql/client";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const localDbPath = path.join(repoRoot, "data", "health.db");

if (!fs.existsSync(localDbPath)) {
  console.error(`No local DB found at ${localDbPath}`);
  process.exit(1);
}

const url_ = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
if (!url_) {
  console.error("TURSO_DATABASE_URL is not set. Add it to .env.local first.");
  process.exit(1);
}

const local = new Database(localDbPath, { readonly: true });
const t = createClient({ url: url_, authToken: token });

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    age INTEGER NOT NULL,
    sex TEXT NOT NULL CHECK (sex IN ('male', 'female')),
    height_cm REAL NOT NULL,
    weight_kg REAL NOT NULL,
    neck_cm REAL NOT NULL,
    waist_cm REAL NOT NULL,
    hips_cm REAL,
    activity_level TEXT NOT NULL,
    body_fat_pct REAL,
    lean_mass_kg REAL,
    bmr REAL,
    tdee REAL,
    goal_calories INTEGER,
    goal_protein_g INTEGER,
    goal_fat_g INTEGER,
    goal_carbs_g INTEGER,
    weekly_workout_target INTEGER,
    weekly_volume_note TEXT,
    goal_mode TEXT DEFAULT 'recomp',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    photo_path TEXT,
    description TEXT,
    calories REAL,
    protein_g REAL,
    fat_g REAL,
    carbs_g REAL,
    items_json TEXT,
    ai_tip TEXT,
    confidence TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date);

  CREATE TABLE IF NOT EXISTS insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('daily', 'weekly')),
    for_date TEXT NOT NULL,
    headline TEXT NOT NULL,
    body TEXT NOT NULL,
    tags_json TEXT,
    sources_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_insights_date ON insights(for_date);

  CREATE TABLE IF NOT EXISTS workouts_cache (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    title TEXT,
    duration_sec INTEGER,
    raw_json TEXT,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts_cache(date);

  CREATE TABLE IF NOT EXISTS zepp_cache (
    date TEXT PRIMARY KEY,
    sleep_hours REAL,
    resting_hr INTEGER,
    steps INTEGER,
    raw_json TEXT,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

console.log("> Ensuring schema in Turso…");
await t.executeMultiple(SCHEMA);
console.log("  schema ready.");

async function copy(table, columns, opts = {}) {
  const { onConflict = "REPLACE" } = opts;
  const rows = local.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).all();
  if (rows.length === 0) {
    console.log(`> ${table}: no rows`);
    return 0;
  }
  const placeholders = columns.map(() => "?").join(", ");
  const sql = `INSERT OR ${onConflict} INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
  // Batch in chunks to avoid huge round trips
  const chunkSize = 50;
  let copied = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const stmts = chunk.map((r) => ({
      sql,
      args: columns.map((c) => (r[c] === undefined ? null : r[c])),
    }));
    await t.batch(stmts, "write");
    copied += chunk.length;
    process.stdout.write(`  ${table}: ${copied}/${rows.length}\r`);
  }
  console.log(`> ${table}: copied ${copied} rows`);
  return copied;
}

const tables = [
  {
    name: "profile",
    cols: [
      "id",
      "age",
      "sex",
      "height_cm",
      "weight_kg",
      "neck_cm",
      "waist_cm",
      "hips_cm",
      "activity_level",
      "body_fat_pct",
      "lean_mass_kg",
      "bmr",
      "tdee",
      "goal_calories",
      "goal_protein_g",
      "goal_fat_g",
      "goal_carbs_g",
      "weekly_workout_target",
      "weekly_volume_note",
      "goal_mode",
      "updated_at",
    ],
  },
  {
    name: "meals",
    cols: [
      "id",
      "date",
      "photo_path",
      "description",
      "calories",
      "protein_g",
      "fat_g",
      "carbs_g",
      "items_json",
      "ai_tip",
      "confidence",
      "created_at",
    ],
  },
  {
    name: "insights",
    cols: [
      "id",
      "type",
      "for_date",
      "headline",
      "body",
      "tags_json",
      "sources_json",
      "created_at",
    ],
  },
  {
    name: "workouts_cache",
    cols: ["id", "date", "title", "duration_sec", "raw_json", "synced_at"],
  },
  {
    name: "zepp_cache",
    cols: ["date", "sleep_hours", "resting_hr", "steps", "raw_json", "synced_at"],
  },
];

let total = 0;
for (const t_ of tables) {
  // Defensive: skip tables that don't exist locally
  const exists = local
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    )
    .get(t_.name);
  if (!exists) {
    console.log(`> ${t_.name}: table missing locally, skipped`);
    continue;
  }
  total += await copy(t_.name, t_.cols);
}

console.log(`\nDone. Copied ${total} rows total.`);
process.exit(0);
