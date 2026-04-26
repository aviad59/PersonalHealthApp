import { createClient, Client } from "@libsql/client";

// ---------------------------------------------------------------
// Connection (Turso / libSQL)
// ---------------------------------------------------------------

let _client: Client | null = null;
let _initPromise: Promise<void> | null = null;

function buildClient(): Client {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) {
    throw new Error(
      "TURSO_DATABASE_URL is not set. Add it to .env.local (and Vercel project env vars).",
    );
  }
  return createClient({ url, authToken });
}

function client(): Client {
  if (!_client) _client = buildClient();
  return _client;
}

// One schema string; libSQL `executeMultiple` runs them all sequentially.
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

async function ensureInit(): Promise<void> {
  if (!_initPromise) {
    _initPromise = (async () => {
      const c = client();
      await c.executeMultiple(SCHEMA);
    })().catch((err) => {
      // allow retry on next call after a failure
      _initPromise = null;
      throw err;
    });
  }
  return _initPromise;
}

export async function getDb(): Promise<Client> {
  await ensureInit();
  return client();
}

// ---------------------------------------------------------------
// Date helpers (unchanged)
// ---------------------------------------------------------------

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

// ---------------------------------------------------------------
// Profile
// ---------------------------------------------------------------

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

export async function getProfile(): Promise<Profile | null> {
  const db = await getDb();
  const res = await db.execute("SELECT * FROM profile WHERE id = 1");
  const row = res.rows[0];
  return row ? (row as unknown as Profile) : null;
}

// ---------------------------------------------------------------
// Meals
// ---------------------------------------------------------------

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

export async function getMealsByDate(date: string): Promise<Meal[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: "SELECT * FROM meals WHERE date = ? ORDER BY created_at ASC",
    args: [date],
  });
  return res.rows as unknown as Meal[];
}

export async function getMealsSince(sinceDate: string): Promise<Meal[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: "SELECT * FROM meals WHERE date >= ? ORDER BY date ASC, created_at ASC",
    args: [sinceDate],
  });
  return res.rows as unknown as Meal[];
}

// ---------------------------------------------------------------
// Insights
// ---------------------------------------------------------------

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

export async function getInsights(limit = 50): Promise<Insight[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: "SELECT * FROM insights ORDER BY created_at DESC LIMIT ?",
    args: [limit],
  });
  return res.rows as unknown as Insight[];
}

export async function getLatestInsight(): Promise<Insight | null> {
  const db = await getDb();
  const res = await db.execute("SELECT * FROM insights ORDER BY created_at DESC LIMIT 1");
  const row = res.rows[0];
  return row ? (row as unknown as Insight) : null;
}

// ---------------------------------------------------------------
// Workout cache
// ---------------------------------------------------------------

export type CachedWorkout = {
  id: string;
  date: string;
  title: string | null;
  duration_sec: number | null;
  raw_json: string;
  synced_at: string;
};

export async function upsertWorkouts(rows: CachedWorkout[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  const stmts = rows.map((r) => ({
    sql: `INSERT INTO workouts_cache (id, date, title, duration_sec, raw_json, synced_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            date = excluded.date,
            title = excluded.title,
            duration_sec = excluded.duration_sec,
            raw_json = excluded.raw_json,
            synced_at = datetime('now')`,
    args: [r.id, r.date, r.title, r.duration_sec, r.raw_json] as any[],
  }));
  // batch runs the statements in a single transaction
  await db.batch(stmts, "write");
}

export async function getCachedWorkouts(limit = 50): Promise<CachedWorkout[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT id, date, title, duration_sec, raw_json, synced_at
            FROM workouts_cache
           ORDER BY date DESC, id DESC
           LIMIT ?`,
    args: [limit],
  });
  return res.rows as unknown as CachedWorkout[];
}

export async function getCachedWorkoutsSince(
  sinceDate: string,
): Promise<CachedWorkout[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT id, date, title, duration_sec, raw_json, synced_at
            FROM workouts_cache
           WHERE date >= ?
           ORDER BY date DESC, id DESC`,
    args: [sinceDate],
  });
  return res.rows as unknown as CachedWorkout[];
}

/** Returns the most-recent synced_at across all cached workouts, or null if cache is empty. */
export async function getCacheLastSyncedAt(): Promise<string | null> {
  const db = await getDb();
  const res = await db.execute("SELECT MAX(synced_at) AS s FROM workouts_cache");
  const row = res.rows[0] as unknown as { s: string | null } | undefined;
  return row?.s ?? null;
}
