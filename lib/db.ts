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

  CREATE TABLE IF NOT EXISTS suggestions (
    date TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    meals_count INTEGER NOT NULL,
    totals_calories INTEGER NOT NULL,
    totals_protein_g INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS zepp_cache (
    date TEXT PRIMARY KEY,
    sleep_hours REAL,
    resting_hr INTEGER,
    steps INTEGER,
    raw_json TEXT,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS weight_log (
    date TEXT PRIMARY KEY,
    weight_kg REAL NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
// Date helpers (timezone-aware)
//
// On Vercel the server runs in UTC, but our user lives in Jerusalem.
// "Today" needs to mean the user's local calendar day, not UTC's.
// All dates stored in the DB are YYYY-MM-DD strings keyed to APP_TIMEZONE.
// ---------------------------------------------------------------

export const APP_TZ = process.env.APP_TIMEZONE || "Asia/Jerusalem";

/** Format any Date as a YYYY-MM-DD string in APP_TZ. */
export function dateKey(d: Date): string {
  // en-CA gives us ISO-style YYYY-MM-DD parts.
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = f.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Today in APP_TZ as YYYY-MM-DD. */
export function todayStr(): string {
  return dateKey(new Date());
}

/** N calendar days before today (in APP_TZ) as YYYY-MM-DD. */
export function daysAgoStr(n: number): string {
  const today = todayStr();
  const [y, m, d] = today.split("-").map(Number);
  // Anchor at UTC midnight for the local-date components, then subtract n days.
  // This is safe because we only use it for date-string comparisons (no clocks).
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Difference in calendar days between two YYYY-MM-DD keys (a - b). */
export function diffDaysKey(aKey: string, bKey: string): number {
  const [ay, am, ad] = aKey.split("-").map(Number);
  const [by, bm, bd] = bKey.split("-").map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((a - b) / (24 * 3600 * 1000));
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

// ---------------------------------------------------------------
// Next-meal suggestion (one cached row per day)
// ---------------------------------------------------------------

export type DaySuggestion = {
  date: string;
  body: string;
  meals_count: number;
  totals_calories: number;
  totals_protein_g: number;
  created_at: string;
  updated_at: string;
};

export async function getSuggestion(
  date: string,
): Promise<DaySuggestion | null> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT date, body, meals_count, totals_calories, totals_protein_g, created_at, updated_at
            FROM suggestions WHERE date = ?`,
    args: [date],
  });
  const row = res.rows[0];
  return row ? (row as unknown as DaySuggestion) : null;
}

export async function upsertSuggestion(
  s: Omit<DaySuggestion, "created_at" | "updated_at">,
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO suggestions
            (date, body, meals_count, totals_calories, totals_protein_g, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(date) DO UPDATE SET
            body = excluded.body,
            meals_count = excluded.meals_count,
            totals_calories = excluded.totals_calories,
            totals_protein_g = excluded.totals_protein_g,
            updated_at = datetime('now')`,
    args: [
      s.date,
      s.body,
      s.meals_count,
      s.totals_calories,
      s.totals_protein_g,
    ],
  });
}

// ---------------------------------------------------------------
// Weight log
// ---------------------------------------------------------------

export type WeightLogEntry = {
  date: string;
  weight_kg: number;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export async function upsertWeight(
  date: string,
  weight_kg: number,
  note: string | null = null,
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO weight_log (date, weight_kg, note, created_at, updated_at)
          VALUES (?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(date) DO UPDATE SET
            weight_kg = excluded.weight_kg,
            note = excluded.note,
            updated_at = datetime('now')`,
    args: [date, weight_kg, note],
  });
}

export async function deleteWeight(date: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `DELETE FROM weight_log WHERE date = ?`,
    args: [date],
  });
}

export async function getWeightLog(): Promise<WeightLogEntry[]> {
  const db = await getDb();
  const res = await db.execute(
    `SELECT date, weight_kg, note, created_at, updated_at
       FROM weight_log
      ORDER BY date ASC`,
  );
  return res.rows as unknown as WeightLogEntry[];
}

export async function getWeightLogSince(sinceDate: string): Promise<WeightLogEntry[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT date, weight_kg, note, created_at, updated_at
            FROM weight_log
           WHERE date >= ?
           ORDER BY date ASC`,
    args: [sinceDate],
  });
  return res.rows as unknown as WeightLogEntry[];
}

export async function setProfileWeight(weightKg: number): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE profile SET weight_kg = ?, updated_at = datetime('now') WHERE id = 1`,
    args: [weightKg],
  });
}

export async function setProfileGoalCalories(
  goalCalories: number,
  goalCarbsG: number,
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE profile
             SET goal_calories = ?, goal_carbs_g = ?, updated_at = datetime('now')
           WHERE id = 1`,
    args: [goalCalories, goalCarbsG],
  });
}
