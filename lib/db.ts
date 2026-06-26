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
    synced_at TEXT NOT NULL DEFAULT (datetime('now')),
    user_id TEXT NOT NULL DEFAULT 'idan'
  );

  CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts_cache(date);
  CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts_cache(user_id, date);

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

// Idempotent column adds for tables that already exist on long-running
// deployments. SQLite has no `ADD COLUMN IF NOT EXISTS`, so we attempt the
// add and swallow "duplicate column" errors.
const COLUMN_ADDS: { sql: string }[] = [
  // photo_thumb: tiny (~5–10 KB) JPEG data URI saved at upload time so the
  // home/meals-list views can inline it directly in HTML and skip both the
  // image optimizer and a serverless DB read per row.
  { sql: "ALTER TABLE meals ADD COLUMN photo_thumb TEXT" },
  // Optional second photo (e.g. the back of a packaged product, or a
  // second angle of a plate) for meals where one photo isn't enough
  // for an accurate read.
  { sql: "ALTER TABLE meals ADD COLUMN photo_path_2 TEXT" },
  { sql: "ALTER TABLE meals ADD COLUMN photo_thumb_2 TEXT" },
  // user_id: per-user data isolation. Existing rows default to 'idan' (the
  // legacy user) so all of his historical data continues to work unchanged.
  { sql: "ALTER TABLE meals    ADD COLUMN user_id TEXT NOT NULL DEFAULT 'idan'" },
  { sql: "ALTER TABLE insights ADD COLUMN user_id TEXT NOT NULL DEFAULT 'idan'" },
  { sql: "ALTER TABLE user_profile ADD COLUMN language TEXT NOT NULL DEFAULT 'en'" },
  // Per-user scoping for the Hevy workout cache. Existing rows default to
  // 'idan' since he was the only user with workouts pre-migration.
  { sql: "ALTER TABLE workouts_cache ADD COLUMN user_id TEXT NOT NULL DEFAULT 'idan'" },
];

// Per-user variants of the tables that previously had a `date` primary key
// (so different users couldn't have a row for the same day) or a forced
// single-row constraint (profile). We KEEP the original tables intact for
// safety, copy idan's data into the new tables once on init, and route all
// future reads/writes to the new tables.
const PER_USER_TABLES = `
  CREATE TABLE IF NOT EXISTS user_profile (
    user_id TEXT PRIMARY KEY,
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

  CREATE TABLE IF NOT EXISTS user_suggestions (
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    body TEXT NOT NULL,
    meals_count INTEGER NOT NULL,
    totals_calories INTEGER NOT NULL,
    totals_protein_g INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, date)
  );

  CREATE TABLE IF NOT EXISTS user_weight_log (
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    weight_kg REAL NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, date)
  );

  -- Persistent chat history for the AI coach. We keep the full thread per
  -- user so the conversation feels continuous across sessions, and so the
  -- model can reference earlier turns. Old turns can be trimmed later if
  -- the thread gets long enough to matter.
  CREATE TABLE IF NOT EXISTS user_coach_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_coach_user_date ON user_coach_messages(user_id, created_at);

  -- Precomputed "log again" list (frequently-logged meals). Recomputing this
  -- is a GROUP BY scan over ~60 days of meals, so we cache the result and
  -- refresh it asynchronously after a meal is saved instead of recomputing
  -- on every page load.
  CREATE TABLE IF NOT EXISTS user_frequent_meals_cache (
    user_id TEXT PRIMARY KEY,
    meals_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

// One-time copy of the legacy single-row / date-keyed tables into the new
// per-user variants. INSERT OR IGNORE means we never overwrite anything
// once data is in the new tables, and we never delete or modify the old
// tables — they remain as a safety net.
const ONE_TIME_USER_MIGRATIONS: { sql: string }[] = [
  {
    sql: `INSERT OR IGNORE INTO user_profile (
            user_id, age, sex, height_cm, weight_kg, neck_cm, waist_cm, hips_cm,
            activity_level, body_fat_pct, lean_mass_kg, bmr, tdee,
            goal_calories, goal_protein_g, goal_fat_g, goal_carbs_g,
            weekly_workout_target, weekly_volume_note, goal_mode, updated_at
          )
          SELECT 'idan', age, sex, height_cm, weight_kg, neck_cm, waist_cm, hips_cm,
                 activity_level, body_fat_pct, lean_mass_kg, bmr, tdee,
                 goal_calories, goal_protein_g, goal_fat_g, goal_carbs_g,
                 weekly_workout_target, weekly_volume_note, goal_mode, updated_at
            FROM profile WHERE id = 1`,
  },
  {
    sql: `INSERT OR IGNORE INTO user_suggestions (
            user_id, date, body, meals_count, totals_calories,
            totals_protein_g, created_at, updated_at
          )
          SELECT 'idan', date, body, meals_count, totals_calories,
                 totals_protein_g, created_at, updated_at
            FROM suggestions`,
  },
  {
    sql: `INSERT OR IGNORE INTO user_weight_log (
            user_id, date, weight_kg, note, created_at, updated_at
          )
          SELECT 'idan', date, weight_kg, note, created_at, updated_at
            FROM weight_log`,
  },
];

async function ensureInit(): Promise<void> {
  if (!_initPromise) {
    _initPromise = (async () => {
      const c = client();
      await c.executeMultiple(SCHEMA);
      // Per-user tables created BEFORE we copy data into them.
      await c.executeMultiple(PER_USER_TABLES);
      for (const m of COLUMN_ADDS) {
        try {
          await c.execute(m.sql);
        } catch (err: any) {
          // libSQL surfaces "duplicate column name" when the migration has
          // already been applied — that's the expected steady state.
          const msg = String(err?.message || err);
          if (!/duplicate column/i.test(msg)) throw err;
        }
      }
      // Backfill idan's data from legacy tables. Each statement is
      // INSERT OR IGNORE so it never overwrites or modifies existing rows.
      for (const m of ONE_TIME_USER_MIGRATIONS) {
        try {
          await c.execute(m.sql);
        } catch (err: any) {
          // Legacy tables might not exist on a fresh DB — that's fine.
          const msg = String(err?.message || err);
          if (!/no such table/i.test(msg)) throw err;
        }
      }
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

/** YYYY-MM-DD for the Sunday that starts the current calendar week (in APP_TZ). */
export function startOfWeekStr(): string {
  const today = todayStr();
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay()); // getUTCDay(): 0 = Sunday
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
  language: string;
  updated_at: string;
};

export async function getProfile(userId: string): Promise<Profile | null> {
  const db = await getDb();
  const res = await db.execute({
    sql: "SELECT * FROM user_profile WHERE user_id = ?",
    args: [userId],
  });
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
  photo_path_2: string | null;
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

export async function getMealsByDate(userId: string, date: string): Promise<Meal[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: "SELECT * FROM meals WHERE user_id = ? AND date = ? ORDER BY created_at ASC",
    args: [userId, date],
  });
  return res.rows as unknown as Meal[];
}

export async function getMealsSince(userId: string, sinceDate: string): Promise<Meal[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: "SELECT * FROM meals WHERE user_id = ? AND date >= ? ORDER BY date ASC, created_at ASC",
    args: [userId, sinceDate],
  });
  return res.rows as unknown as Meal[];
}

// ---------------------------------------------------------------
// Lite meal queries — exclude photo_path (a Blob pathname, or for legacy
// rows a base64 data URI that can be hundreds of KB). Use these whenever
// the photo isn't going to be displayed (recovery calc, suggestion totals, etc).
// ---------------------------------------------------------------

export type MealLite = Omit<Meal, "photo_path" | "photo_path_2"> & {
  has_photo: 0 | 1;
  has_photo_2: 0 | 1;
  // Inline thumbnail data URI (~5–10 KB) when present; null for meals
  // saved before the thumbnail column existed. Lists ship this in the
  // payload so the browser renders without any extra requests.
  photo_thumb: string | null;
  photo_thumb_2: string | null;
};

const MEAL_LITE_COLUMNS =
  "id, date, description, calories, protein_g, fat_g, carbs_g, items_json, ai_tip, confidence, created_at, " +
  "photo_thumb, photo_thumb_2, " +
  "(CASE WHEN photo_path IS NULL OR photo_path = '' THEN 0 ELSE 1 END) AS has_photo, " +
  "(CASE WHEN photo_path_2 IS NULL OR photo_path_2 = '' THEN 0 ELSE 1 END) AS has_photo_2";

export async function getMealsByDateLite(userId: string, date: string): Promise<MealLite[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT ${MEAL_LITE_COLUMNS} FROM meals WHERE user_id = ? AND date = ? ORDER BY created_at ASC`,
    args: [userId, date],
  });
  return res.rows as unknown as MealLite[];
}

export async function getMealsSinceLite(userId: string, sinceDate: string): Promise<MealLite[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT ${MEAL_LITE_COLUMNS} FROM meals WHERE user_id = ? AND date >= ? ORDER BY date ASC, created_at ASC`,
    args: [userId, sinceDate],
  });
  return res.rows as unknown as MealLite[];
}

export async function getMealPhoto(
  userId: string,
  id: number,
  which: 1 | 2 = 1,
): Promise<string | null> {
  // Photos are scoped to the meal owner — even if someone hits the URL with
  // another user's session, we won't leak the bytes.
  const column = which === 2 ? "photo_path_2" : "photo_path";
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT ${column} AS photo_path FROM meals WHERE id = ? AND user_id = ?`,
    args: [id, userId],
  });
  const row = res.rows[0] as unknown as { photo_path: string | null } | undefined;
  return row?.photo_path ?? null;
}

// Aggregated per-day totals for stats. Done in SQL so we transfer 1 row
// per logged day instead of 1 row per meal (which still ships items_json
// and other fields the stats page never reads).
export type MealDailyTotal = {
  date: string;
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  meals: number;
};

export async function getMealDailyTotalsSince(
  userId: string,
  sinceDate: string,
): Promise<MealDailyTotal[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT
            date,
            COALESCE(SUM(calories), 0)  AS calories,
            COALESCE(SUM(protein_g), 0) AS protein_g,
            COALESCE(SUM(fat_g), 0)     AS fat_g,
            COALESCE(SUM(carbs_g), 0)   AS carbs_g,
            COUNT(*)                    AS meals
          FROM meals
          WHERE user_id = ? AND date >= ?
          GROUP BY date
          ORDER BY date ASC`,
    args: [userId, sinceDate],
  });
  return res.rows as unknown as MealDailyTotal[];
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

export async function getInsights(userId: string, limit = 50): Promise<Insight[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: "SELECT * FROM insights WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    args: [userId, limit],
  });
  return res.rows as unknown as Insight[];
}

export async function getLatestInsight(userId: string): Promise<Insight | null> {
  const db = await getDb();
  const res = await db.execute({
    sql: "SELECT * FROM insights WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
    args: [userId],
  });
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

export async function upsertWorkouts(
  userId: string,
  rows: CachedWorkout[],
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  const stmts = rows.map((r) => ({
    sql: `INSERT INTO workouts_cache (id, date, title, duration_sec, raw_json, synced_at, user_id)
          VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
          ON CONFLICT(id) DO UPDATE SET
            date = excluded.date,
            title = excluded.title,
            duration_sec = excluded.duration_sec,
            raw_json = excluded.raw_json,
            synced_at = datetime('now'),
            user_id = excluded.user_id`,
    args: [r.id, r.date, r.title, r.duration_sec, r.raw_json, userId] as any[],
  }));
  await db.batch(stmts, "write");
}

export async function getCachedWorkouts(
  userId: string,
  limit = 50,
): Promise<CachedWorkout[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT id, date, title, duration_sec, raw_json, synced_at
            FROM workouts_cache
           WHERE user_id = ?
           ORDER BY date DESC, id DESC
           LIMIT ?`,
    args: [userId, limit],
  });
  return res.rows as unknown as CachedWorkout[];
}

export async function getCachedWorkoutsSince(
  userId: string,
  sinceDate: string,
): Promise<CachedWorkout[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT id, date, title, duration_sec, raw_json, synced_at
            FROM workouts_cache
           WHERE user_id = ? AND date >= ?
           ORDER BY date DESC, id DESC`,
    args: [userId, sinceDate],
  });
  return res.rows as unknown as CachedWorkout[];
}

/** Returns the most-recent synced_at across this user's cached workouts, or null if none. */
export async function getCacheLastSyncedAt(userId: string): Promise<string | null> {
  const db = await getDb();
  const res = await db.execute({
    sql: "SELECT MAX(synced_at) AS s FROM workouts_cache WHERE user_id = ?",
    args: [userId],
  });
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

/** Return the last `limit` suggestion bodies for this user, newest first.
 *  Used as anti-repetition context so the model doesn't keep suggesting
 *  the same grilled-chicken-and-veg every day. */
export async function getRecentSuggestions(
  userId: string,
  limit = 5,
): Promise<DaySuggestion[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT date, body, meals_count, totals_calories, totals_protein_g, created_at, updated_at
            FROM user_suggestions
           WHERE user_id = ?
           ORDER BY date DESC
           LIMIT ?`,
    args: [userId, limit],
  });
  return res.rows as unknown as DaySuggestion[];
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
  userId: string,
  date: string,
  weight_kg: number,
  note: string | null = null,
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO user_weight_log (user_id, date, weight_kg, note, created_at, updated_at)
          VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(user_id, date) DO UPDATE SET
            weight_kg = excluded.weight_kg,
            note = excluded.note,
            updated_at = datetime('now')`,
    args: [userId, date, weight_kg, note],
  });
}

export async function deleteWeight(userId: string, date: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `DELETE FROM user_weight_log WHERE user_id = ? AND date = ?`,
    args: [userId, date],
  });
}

export async function getWeightLog(userId: string): Promise<WeightLogEntry[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT date, weight_kg, note, created_at, updated_at
            FROM user_weight_log
           WHERE user_id = ?
           ORDER BY date ASC`,
    args: [userId],
  });
  return res.rows as unknown as WeightLogEntry[];
}

export async function getWeightLogSince(
  userId: string,
  sinceDate: string,
): Promise<WeightLogEntry[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT date, weight_kg, note, created_at, updated_at
            FROM user_weight_log
           WHERE user_id = ? AND date >= ?
           ORDER BY date ASC`,
    args: [userId, sinceDate],
  });
  return res.rows as unknown as WeightLogEntry[];
}

export async function setProfileWeight(userId: string, weightKg: number): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE user_profile SET weight_kg = ?, updated_at = datetime('now') WHERE user_id = ?`,
    args: [weightKg, userId],
  });
}

export async function setProfileGoalCalories(
  userId: string,
  goalCalories: number,
  goalCarbsG: number,
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE user_profile
             SET goal_calories = ?, goal_carbs_g = ?, updated_at = datetime('now')
           WHERE user_id = ?`,
    args: [goalCalories, goalCarbsG, userId],
  });
}

// ---------------------------------------------------------------
// Coach chat history (one row per turn, per user)
// ---------------------------------------------------------------

export type CoachMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

/** Fetch the user's coach thread, oldest-first, up to `limit` most recent turns. */
export async function getCoachMessages(
  userId: string,
  limit = 40,
): Promise<CoachMessage[]> {
  const db = await getDb();
  // Grab the latest N then reverse so the model sees them in chronological order.
  const res = await db.execute({
    sql: `SELECT id, role, content, created_at
            FROM user_coach_messages
           WHERE user_id = ?
           ORDER BY id DESC
           LIMIT ?`,
    args: [userId, limit],
  });
  const rows = res.rows as unknown as CoachMessage[];
  return rows.reverse();
}

export async function addCoachMessage(
  userId: string,
  role: "user" | "assistant",
  content: string,
): Promise<number> {
  const db = await getDb();
  const r = await db.execute({
    sql: `INSERT INTO user_coach_messages (user_id, role, content)
          VALUES (?, ?, ?)`,
    args: [userId, role, content],
  });
  return Number(r.lastInsertRowid ?? 0);
}

export async function clearCoachMessages(userId: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `DELETE FROM user_coach_messages WHERE user_id = ?`,
    args: [userId],
  });
}

// ---------------------------------------------------------------
// Frequent meals ("log again") cache
// ---------------------------------------------------------------

export type FrequentMeal = {
  description: string;
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  count: number;
  last_date: string;
};

/**
 * Recompute the "log again" list (meals logged at least twice in the last
 * 60 days, grouped by a normalized description) and persist it so future
 * reads are a single-row lookup instead of a GROUP BY scan.
 */
export async function refreshFrequentMeals(userId: string): Promise<FrequentMeal[]> {
  const db = await getDb();
  const since = daysAgoStr(60);
  const res = await db.execute({
    sql: `SELECT
            description AS description,
            ROUND(AVG(calories)) AS calories,
            ROUND(AVG(protein_g)) AS protein_g,
            ROUND(AVG(fat_g))     AS fat_g,
            ROUND(AVG(carbs_g))   AS carbs_g,
            COUNT(*) AS count,
            MAX(date) AS last_date
          FROM meals
          WHERE user_id = ?
            AND description IS NOT NULL
            AND TRIM(description) <> ''
            AND date >= ?
          GROUP BY TRIM(LOWER(description))
          HAVING count >= 2
          ORDER BY count DESC, last_date DESC
          LIMIT 8`,
    args: [userId, since],
  });

  const meals = res.rows as unknown as FrequentMeal[];
  await db.execute({
    sql: `INSERT INTO user_frequent_meals_cache (user_id, meals_json, updated_at)
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(user_id) DO UPDATE SET
            meals_json = excluded.meals_json,
            updated_at = datetime('now')`,
    args: [userId, JSON.stringify(meals)],
  });
  return meals;
}

/**
 * Return the cached "log again" list, computing and caching it on first
 * access if no cache row exists yet.
 */
export async function getFrequentMeals(userId: string): Promise<FrequentMeal[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT meals_json FROM user_frequent_meals_cache WHERE user_id = ?`,
    args: [userId],
  });
  const row = res.rows[0] as any;
  if (row) {
    try {
      return JSON.parse(row.meals_json as string) as FrequentMeal[];
    } catch {
      // fall through and recompute if the cached JSON is somehow malformed
    }
  }
  return refreshFrequentMeals(userId);
}
