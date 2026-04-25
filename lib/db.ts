import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

let _db: Database.Database | null = null;

function getDbPath() {
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "health.db");
}

export function getDb(): Database.Database {
  if (_db) return _db;
  const db = new Database(getDbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  init(db);
  _db = db;
  return db;
}

function init(db: Database.Database) {
  db.exec(`
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
  `);
}

export function todayStr(): string {
  // YYYY-MM-DD in local time
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type Profile = {
  id: number;
  age: number;
  sex: "male" | "female";
  height_cm: number;
  weight_kg: number;
  neck_cm: number;
  waist_cm: number;
  hips_cm: number | null;
  activity_level: string;
  body_fat_pct: number | null;
  lean_mass_kg: number | null;
  bmr: number | null;
  tdee: number | null;
  goal_calories: number | null;
  goal_protein_g: number | null;
  goal_fat_g: number | null;
  goal_carbs_g: number | null;
  weekly_workout_target: number | null;
  weekly_volume_note: string | null;
  goal_mode: string;
  updated_at: string;
};

export function getProfile(): Profile | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM profile WHERE id = 1").get() as
    | Profile
    | undefined;
  return row ?? null;
}

export type Meal = {
  id: number;
  date: string;
  photo_path: string | null;
  description: string | null;
  calories: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  items_json: string | null;
  ai_tip: string | null;
  confidence: string | null;
  created_at: string;
};

export function getMealsByDate(date: string): Meal[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM meals WHERE date = ? ORDER BY created_at ASC")
    .all(date) as Meal[];
}

export function getMealsSince(sinceDate: string): Meal[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM meals WHERE date >= ? ORDER BY date ASC, created_at ASC")
    .all(sinceDate) as Meal[];
}

export type Insight = {
  id: number;
  type: "daily" | "weekly";
  for_date: string;
  headline: string;
  body: string;
  tags_json: string | null;
  sources_json: string | null;
  created_at: string;
};

export function getInsights(limit = 50): Insight[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM insights ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Insight[];
}

export function getLatestInsight(): Insight | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM insights ORDER BY created_at DESC LIMIT 1")
    .get() as Insight | undefined;
  return row ?? null;
}

// --- Workout cache ---

export type CachedWorkout = {
  id: string;
  date: string;
  title: string | null;
  duration_sec: number | null;
  raw_json: string;
  synced_at: string;
};

export function upsertWorkouts(rows: CachedWorkout[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO workouts_cache (id, date, title, duration_sec, raw_json, synced_at)
     VALUES (@id, @date, @title, @duration_sec, @raw_json, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       date = excluded.date,
       title = excluded.title,
       duration_sec = excluded.duration_sec,
       raw_json = excluded.raw_json,
       synced_at = datetime('now')`,
  );
  const tx = db.transaction((batch: CachedWorkout[]) => {
    for (const r of batch) stmt.run(r);
  });
  tx(rows);
}

export function getCachedWorkouts(limit = 50): CachedWorkout[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, date, title, duration_sec, raw_json, synced_at
         FROM workouts_cache
        ORDER BY date DESC, id DESC
        LIMIT ?`,
    )
    .all(limit) as CachedWorkout[];
}

export function getCachedWorkoutsSince(sinceDate: string): CachedWorkout[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, date, title, duration_sec, raw_json, synced_at
         FROM workouts_cache
        WHERE date >= ?
        ORDER BY date DESC, id DESC`,
    )
    .all(sinceDate) as CachedWorkout[];
}

/** Returns the most-recent synced_at across all cached workouts, or null if cache is empty. */
export function getCacheLastSyncedAt(): string | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT MAX(synced_at) AS s FROM workouts_cache`)
    .get() as { s: string | null } | undefined;
  return row?.s ?? null;
}
