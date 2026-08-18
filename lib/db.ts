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
  -- NOTE: the (user_id, date) index is intentionally NOT here. SCHEMA is
  -- executed before COLUMN_ADDS, so on a long-running DB where the
  -- user_id column hasn't been added yet, creating that index here would
  -- fail with "no such column: user_id" and abort the whole init. The
  -- index is added in POST_COLUMN_INDEXES below, after the column add.

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
  // Optional icon id shown in lists for meals with no photo.
  { sql: "ALTER TABLE meals ADD COLUMN icon TEXT" },
  // The user's own free-text note/description/hint given at log time, kept
  // verbatim alongside the AI-generated `description` so the coach can read
  // what the user actually said about the meal.
  { sql: "ALTER TABLE meals ADD COLUMN user_note TEXT" },
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
  // Free-text "tell the coach about yourself" notes (allergies, kosher, etc.)
  { sql: "ALTER TABLE user_profile ADD COLUMN coach_notes TEXT" },
  // Per-user scoping for the Hevy workout cache. Existing rows default to
  // 'idan' since he was the only user with workouts pre-migration.
  { sql: "ALTER TABLE workouts_cache ADD COLUMN user_id TEXT NOT NULL DEFAULT 'idan'" },
  // Analyzer fixtures imported from a public dataset (Nutrition5k) reference
  // their image by URL instead of embedding base64 — the ground-truth set is
  // large and the bucket is public, so storing bytes per fixture would bloat
  // the DB for no benefit. Fetched server-side at run time.
  { sql: "ALTER TABLE analyzer_fixtures ADD COLUMN source_url TEXT" },
  { sql: "ALTER TABLE analyzer_fixtures ADD COLUMN source TEXT" },
  // Ground-truth total mass. Per the Nutrition5k paper portion estimation is
  // where nearly all nutrition error originates, so it is scored on its own.
  { sql: "ALTER TABLE analyzer_fixtures ADD COLUMN expected_mass_g REAL" },
  // Which half of the body training should be weighted toward, used by the
  // workout score's focus component.
  { sql: "ALTER TABLE user_profile ADD COLUMN training_focus TEXT NOT NULL DEFAULT 'upper'" },
];

// Indexes that reference columns added by COLUMN_ADDS — they MUST run after
// the ALTERs above, otherwise on a pre-migration DB they'd fail with
// "no such column" and abort init. Each is wrapped in IF NOT EXISTS so
// re-running is harmless.
const POST_COLUMN_INDEXES: { sql: string }[] = [
  { sql: "CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts_cache(user_id, date)" },
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
    coach_notes TEXT,
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

  -- Body circumference measurements logged over time (progress tracking).
  -- Every field except date is optional — the user logs whatever they
  -- measured that day. One row per user/date.
  CREATE TABLE IF NOT EXISTS user_measurements (
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    waist_cm REAL,
    neck_cm REAL,
    hips_cm REAL,
    chest_cm REAL,
    arm_cm REAL,
    thigh_cm REAL,
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

  -- Goal history: a snapshot of macro/calorie goals with the date they
  -- became effective. Lets past days be judged against the goal in effect
  -- then, instead of re-scoring history against a newly-raised target.
  CREATE TABLE IF NOT EXISTS user_goal_history (
    user_id TEXT NOT NULL,
    effective_date TEXT NOT NULL,
    goal_calories INTEGER,
    goal_protein_g INTEGER,
    goal_fat_g INTEGER,
    goal_carbs_g INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, effective_date)
  );

  -- Web Push subscriptions. One row per (user_id, browser endpoint) so a
  -- user can have multiple devices. Used by the daily-insight cron to
  -- notify everyone who opted in.
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    user_id TEXT NOT NULL,
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

  -- The user roster, source of truth for who may sign in and their per-user
  -- settings. Replaces the old hardcoded map in lib/user.ts so adding a user
  -- needs no code/env change. A new Google sign-in creates a 'pending' row;
  -- an admin approves (status='active') and configures it from the app.
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'active' | 'disabled'
    has_workouts INTEGER NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    training_notes TEXT,
    hevy_key_env TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

  -- Admin-only analyzer eval harness: labeled test meals with ground-truth
  -- macros, used to measure the meal analyzer's accuracy across prompt/model
  -- changes. Global (not per-user) — it's a developer/admin tool. Images are
  -- stored as base64 here (the set is small) to keep the harness self-contained.
  CREATE TABLE IF NOT EXISTS analyzer_fixtures (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    mode TEXT NOT NULL,                       -- 'photo' | 'text'
    photo_base64 TEXT,                        -- full compressed JPEG (photo mode)
    photo_thumb_base64 TEXT,                  -- small thumb for the fixture list
    photo_mime TEXT,                          -- e.g. 'image/jpeg'
    input_text TEXT,                          -- text-mode description or photo note
    expected_calories REAL NOT NULL,
    expected_protein_g REAL NOT NULL,
    expected_fat_g REAL NOT NULL,
    expected_carbs_g REAL NOT NULL,
    notes TEXT,
    created_by TEXT,
    source TEXT,                              -- e.g. 'nutrition5k' | null (manual)
    source_url TEXT,                          -- public image URL, fetched at run time
    expected_mass_g REAL,                     -- ground-truth total mass, scored separately
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Saved analyzer lab runs, so a report survives a reload and successive
  -- prompt/model changes can be compared over time rather than lost.
  CREATE TABLE IF NOT EXISTS analyzer_runs (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    note TEXT,
    config_json TEXT NOT NULL,                -- models/variants/pipelines, prompt-edited flags
    rows_json TEXT NOT NULL,                  -- the per-config scorecard rows
    cells_json TEXT NOT NULL,                 -- per-dish cells (no raw model text)
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

/**
 * Bootstrap the very first admin from the environment so a FRESH database has
 * someone who can sign in and approve everyone else — without any personal
 * email living in the repo. No-op if ADMIN_EMAIL is unset, or if the row
 * already exists (INSERT OR IGNORE), so it never overwrites live data or
 * later admin edits. On the existing production DB the admin row already
 * exists, so this changes nothing there.
 *
 * ADMIN_ID defaults to "idan" so it maps onto the existing owner's data;
 * everyone else is added from the in-app admin screen, not seeded here.
 */
async function seedBootstrapAdmin(c: Client): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim();
  if (!email) return;
  const id = (process.env.ADMIN_ID?.trim() || "idan").toLowerCase();
  const name = process.env.ADMIN_NAME?.trim() || "Admin";
  // Upsert: create the admin if missing, and if the row already exists force
  // it back to active+admin with this email. This makes ADMIN_EMAIL a reliable
  // "restore my access" lever even if the account was left pending/disabled.
  // display_name is only set on insert (COALESCE keeps any admin-chosen name).
  await c.execute({
    sql: `INSERT INTO users (id, email, display_name, status, has_workouts, is_admin)
          VALUES (?, ?, ?, 'active', 1, 1)
          ON CONFLICT(id) DO UPDATE SET
            email = excluded.email,
            status = 'active',
            is_admin = 1,
            updated_at = datetime('now')`,
    args: [id, email, name],
  });
  // If the admin got recorded as a separate pending row (keyed by their email)
  // during a lockout window, remove that stray so it doesn't shadow the real
  // admin id or clutter the roster. Only ever deletes a *pending* duplicate.
  await c.execute({
    sql: `DELETE FROM users WHERE email = ? AND id != ? AND status = 'pending'`,
    args: [email, id],
  });
}

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
      // Indexes that need columns added above to exist first.
      for (const idx of POST_COLUMN_INDEXES) {
        await c.execute(idx.sql);
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
      // Ensure a signable admin exists (from ADMIN_EMAIL) on fresh databases.
      await seedBootstrapAdmin(c);
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
  /** 'upper' | 'balanced' | 'lower' — weights the workout score's focus. */
  training_focus: string;
  language: string;
  // Free-text notes the user writes for the AI (allergies, dietary rules,
  // preferences, injuries…) so the coach/insights know context that isn't
  // captured by the structured fields.
  coach_notes: string | null;
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
// Goal history (versioned macro/calorie targets by effective date)
// ---------------------------------------------------------------

export type GoalSnapshot = {
  effective_date: string;
  goal_calories: number | null;
  goal_protein_g: number | null;
  goal_fat_g: number | null;
  goal_carbs_g: number | null;
};

/** Upsert a goal snapshot effective from a given date (one per user/date). */
export async function recordGoalSnapshot(
  userId: string,
  effectiveDate: string,
  goals: {
    goal_calories: number | null;
    goal_protein_g: number | null;
    goal_fat_g: number | null;
    goal_carbs_g: number | null;
  },
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO user_goal_history
            (user_id, effective_date, goal_calories, goal_protein_g, goal_fat_g, goal_carbs_g, created_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(user_id, effective_date) DO UPDATE SET
            goal_calories = excluded.goal_calories,
            goal_protein_g = excluded.goal_protein_g,
            goal_fat_g = excluded.goal_fat_g,
            goal_carbs_g = excluded.goal_carbs_g`,
    args: [
      userId,
      effectiveDate,
      goals.goal_calories,
      goals.goal_protein_g,
      goals.goal_fat_g,
      goals.goal_carbs_g,
    ],
  });
}

/** All goal snapshots for a user, oldest first. */
export async function getGoalHistory(userId: string): Promise<GoalSnapshot[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT effective_date, goal_calories, goal_protein_g, goal_fat_g, goal_carbs_g
            FROM user_goal_history WHERE user_id = ? ORDER BY effective_date ASC`,
    args: [userId],
  });
  return res.rows as unknown as GoalSnapshot[];
}

/** How many goal snapshots exist (used to decide whether to seed a baseline). */
export async function countGoalHistory(userId: string): Promise<number> {
  const db = await getDb();
  const res = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM user_goal_history WHERE user_id = ?",
    args: [userId],
  });
  return Number((res.rows[0] as any)?.n ?? 0);
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
  // Optional chosen icon id (see components/MealIcon) shown in lists when
  // the meal has no photo.
  icon: string | null;
  // The user's own note/description entered at log time (verbatim), separate
  // from the AI-generated `description`.
  user_note: string | null;
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
  "id, date, description, calories, protein_g, fat_g, carbs_g, items_json, ai_tip, confidence, icon, user_note, created_at, " +
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
// Body measurements (circumferences over time)
// ---------------------------------------------------------------

export type MeasurementEntry = {
  date: string;
  waist_cm: number | null;
  neck_cm: number | null;
  hips_cm: number | null;
  chest_cm: number | null;
  arm_cm: number | null;
  thigh_cm: number | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type MeasurementInput = {
  date: string;
  waist_cm?: number | null;
  neck_cm?: number | null;
  hips_cm?: number | null;
  chest_cm?: number | null;
  arm_cm?: number | null;
  thigh_cm?: number | null;
  note?: string | null;
};

/** Upsert one day's measurements. Only the provided fields are written;
 *  omitted fields on an existing row are left untouched (COALESCE keeps the
 *  prior value when the new one is null), so partial logging accumulates. */
export async function upsertMeasurement(userId: string, m: MeasurementInput): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO user_measurements
            (user_id, date, waist_cm, neck_cm, hips_cm, chest_cm, arm_cm, thigh_cm, note, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(user_id, date) DO UPDATE SET
            waist_cm = COALESCE(excluded.waist_cm, waist_cm),
            neck_cm  = COALESCE(excluded.neck_cm, neck_cm),
            hips_cm  = COALESCE(excluded.hips_cm, hips_cm),
            chest_cm = COALESCE(excluded.chest_cm, chest_cm),
            arm_cm   = COALESCE(excluded.arm_cm, arm_cm),
            thigh_cm = COALESCE(excluded.thigh_cm, thigh_cm),
            note     = COALESCE(excluded.note, note),
            updated_at = datetime('now')`,
    args: [
      userId,
      m.date,
      m.waist_cm ?? null,
      m.neck_cm ?? null,
      m.hips_cm ?? null,
      m.chest_cm ?? null,
      m.arm_cm ?? null,
      m.thigh_cm ?? null,
      m.note ?? null,
    ],
  });
}

export async function getMeasurementsSince(
  userId: string,
  sinceDate: string,
): Promise<MeasurementEntry[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT date, waist_cm, neck_cm, hips_cm, chest_cm, arm_cm, thigh_cm, note, created_at, updated_at
            FROM user_measurements
           WHERE user_id = ? AND date >= ?
           ORDER BY date ASC`,
    args: [userId, sinceDate],
  });
  return res.rows as unknown as MeasurementEntry[];
}

export async function getAllMeasurements(userId: string): Promise<MeasurementEntry[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT date, waist_cm, neck_cm, hips_cm, chest_cm, arm_cm, thigh_cm, note, created_at, updated_at
            FROM user_measurements
           WHERE user_id = ?
           ORDER BY date ASC`,
    args: [userId],
  });
  return res.rows as unknown as MeasurementEntry[];
}

export async function deleteMeasurement(userId: string, date: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: "DELETE FROM user_measurements WHERE user_id = ? AND date = ?",
    args: [userId, date],
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

// ---------------------------------------------------------------
// Push subscriptions
// ---------------------------------------------------------------

export type PushSubscriptionRow = {
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
  last_used_at: string | null;
};

/** Idempotent insert — one row per (user_id, endpoint). */
export async function upsertPushSubscription(
  userId: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(endpoint) DO UPDATE SET
            user_id = excluded.user_id,
            p256dh = excluded.p256dh,
            auth = excluded.auth`,
    args: [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
  });
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: "DELETE FROM push_subscriptions WHERE endpoint = ?",
    args: [endpoint],
  });
}

export async function getPushSubscriptionsForUser(userId: string): Promise<PushSubscriptionRow[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: "SELECT user_id, endpoint, p256dh, auth, created_at, last_used_at FROM push_subscriptions WHERE user_id = ?",
    args: [userId],
  });
  return res.rows as unknown as PushSubscriptionRow[];
}

export async function getAllPushSubscriptions(): Promise<PushSubscriptionRow[]> {
  const db = await getDb();
  const res = await db.execute(
    "SELECT user_id, endpoint, p256dh, auth, created_at, last_used_at FROM push_subscriptions",
  );
  return res.rows as unknown as PushSubscriptionRow[];
}

export async function touchPushSubscription(endpoint: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: "UPDATE push_subscriptions SET last_used_at = datetime('now') WHERE endpoint = ?",
    args: [endpoint],
  });
}

// ---------------------------------------------------------------
// Users roster (see the `users` table in PER_USER_TABLES)
// ---------------------------------------------------------------

export type UserRow = {
  id: string;
  email: string | null;
  display_name: string;
  status: string; // 'pending' | 'active' | 'disabled'
  has_workouts: number;
  is_admin: number;
  training_notes: string | null;
  hevy_key_env: string | null;
  created_at: string;
  updated_at: string;
};

const USER_COLUMNS =
  "id, email, display_name, status, has_workouts, is_admin, training_notes, hevy_key_env, created_at, updated_at";

export async function getAllUserRows(): Promise<UserRow[]> {
  const db = await getDb();
  const res = await db.execute(
    `SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC`,
  );
  return res.rows as unknown as UserRow[];
}

export async function getUserRowById(id: string): Promise<UserRow | null> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT ${USER_COLUMNS} FROM users WHERE id = ? LIMIT 1`,
    args: [id],
  });
  return (res.rows[0] as unknown as UserRow) ?? null;
}

/** Create a new pending user. INSERT OR IGNORE so a repeat sign-in before
 *  approval doesn't error or reset an existing row. */
export async function insertPendingUser(
  id: string,
  email: string | null,
  displayName: string,
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `INSERT OR IGNORE INTO users (id, email, display_name, status, has_workouts, is_admin)
          VALUES (?, ?, ?, 'pending', 0, 0)`,
    args: [id, email, displayName],
  });
}

/** Patch a user row. Only the provided fields are written. */
export async function updateUserRow(
  id: string,
  patch: Partial<{
    display_name: string;
    email: string | null;
    status: string;
    has_workouts: boolean;
    is_admin: boolean;
    training_notes: string | null;
    hevy_key_env: string | null;
  }>,
): Promise<void> {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const push = (col: string, val: string | number | null) => {
    sets.push(`${col} = ?`);
    args.push(val);
  };
  if (patch.display_name !== undefined) push("display_name", patch.display_name);
  if (patch.email !== undefined) push("email", patch.email);
  if (patch.status !== undefined) push("status", patch.status);
  if (patch.has_workouts !== undefined) push("has_workouts", patch.has_workouts ? 1 : 0);
  if (patch.is_admin !== undefined) push("is_admin", patch.is_admin ? 1 : 0);
  if (patch.training_notes !== undefined) push("training_notes", patch.training_notes);
  if (patch.hevy_key_env !== undefined) push("hevy_key_env", patch.hevy_key_env);
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  const db = await getDb();
  await db.execute({
    sql: `UPDATE users SET ${sets.join(", ")} WHERE id = ?`,
    args: [...args, id],
  });
}

// ---------------------------------------------------------------
// Analyzer eval-harness fixtures (admin-only)
// ---------------------------------------------------------------

export type AnalyzerFixture = {
  id: string;
  label: string;
  mode: "photo" | "text";
  photo_base64: string | null;
  photo_thumb_base64: string | null;
  photo_mime: string | null;
  input_text: string | null;
  expected_calories: number;
  expected_protein_g: number;
  expected_fat_g: number;
  expected_carbs_g: number;
  /** Ground-truth total mass in grams, when the source provides it. */
  expected_mass_g: number | null;
  notes: string | null;
  /** Origin of the fixture, e.g. 'nutrition5k'. Null for manually added ones. */
  source: string | null;
  /** Public image URL used instead of embedded base64 (dataset imports). */
  source_url: string | null;
  /** True when this fixture carries real ground-truth macros to score against. */
  has_ground_truth: boolean;
  created_at: string;
};

/** Lightweight fixture row for list views — omits the full-size photo. */
export type AnalyzerFixtureListItem = Omit<AnalyzerFixture, "photo_base64">;

export type NewAnalyzerFixture = {
  label: string;
  mode: "photo" | "text";
  photo_base64?: string | null;
  photo_thumb_base64?: string | null;
  photo_mime?: string | null;
  input_text?: string | null;
  expected_calories: number;
  expected_protein_g: number;
  expected_fat_g: number;
  expected_carbs_g: number;
  expected_mass_g?: number | null;
  notes?: string | null;
  created_by?: string | null;
  source?: string | null;
  source_url?: string | null;
};

/** List all fixtures without the heavy full-size photo column. */
export async function listAnalyzerFixtures(): Promise<AnalyzerFixtureListItem[]> {
  const db = await getDb();
  const r = await db.execute(
    `SELECT id, label, mode, photo_thumb_base64, photo_mime, input_text,
            expected_calories, expected_protein_g, expected_fat_g, expected_carbs_g,
            expected_mass_g, notes, source, source_url, created_at
       FROM analyzer_fixtures
       ORDER BY created_at DESC`,
  );
  return r.rows.map((row: any) => rowToFixtureCommon(row));
}

/** Shared row → fixture mapping for the list/detail queries. */
function rowToFixtureCommon(row: any): AnalyzerFixtureListItem {
  const expected = {
    expected_calories: Number(row.expected_calories),
    expected_protein_g: Number(row.expected_protein_g),
    expected_fat_g: Number(row.expected_fat_g),
    expected_carbs_g: Number(row.expected_carbs_g),
  };
  return {
    id: row.id,
    label: row.label,
    mode: row.mode,
    photo_thumb_base64: row.photo_thumb_base64 ?? null,
    photo_mime: row.photo_mime ?? null,
    input_text: row.input_text ?? null,
    ...expected,
    expected_mass_g: row.expected_mass_g == null ? null : Number(row.expected_mass_g),
    notes: row.notes ?? null,
    source: row.source ?? null,
    source_url: row.source_url ?? null,
    // Manually added fixtures default every expected macro to 0 (the
    // consistency-only flow doesn't collect them) — treat an all-zero row as
    // "no ground truth" so accuracy scoring only runs where it's meaningful.
    has_ground_truth:
      expected.expected_calories > 0 ||
      expected.expected_protein_g > 0 ||
      expected.expected_fat_g > 0 ||
      expected.expected_carbs_g > 0,
    created_at: row.created_at,
  };
}

/** Fetch a single fixture including the full-size photo (for running/editing). */
export async function getAnalyzerFixture(
  id: string,
): Promise<AnalyzerFixture | null> {
  const db = await getDb();
  const r = await db.execute({
    sql: `SELECT * FROM analyzer_fixtures WHERE id = ?`,
    args: [id],
  });
  const row: any = r.rows[0];
  if (!row) return null;
  return {
    ...rowToFixtureCommon(row),
    photo_base64: row.photo_base64 ?? null,
  };
}

/** Fetch full fixtures for a run — all, or a specific subset by id. */
export async function getAnalyzerFixturesForRun(
  ids?: string[],
): Promise<AnalyzerFixture[]> {
  const all = await listAnalyzerFixtures();
  const wanted = ids && ids.length ? all.filter((f) => ids.includes(f.id)) : all;
  const full = await Promise.all(wanted.map((f) => getAnalyzerFixture(f.id)));
  return full.filter((f): f is AnalyzerFixture => !!f);
}

export async function createAnalyzerFixture(
  f: NewAnalyzerFixture,
): Promise<string> {
  const id = crypto.randomUUID();
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO analyzer_fixtures
            (id, label, mode, photo_base64, photo_thumb_base64, photo_mime,
             input_text, expected_calories, expected_protein_g, expected_fat_g,
             expected_carbs_g, expected_mass_g, notes, created_by, source, source_url, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [
      id,
      f.label,
      f.mode,
      f.photo_base64 ?? null,
      f.photo_thumb_base64 ?? null,
      f.photo_mime ?? null,
      f.input_text ?? null,
      f.expected_calories,
      f.expected_protein_g,
      f.expected_fat_g,
      f.expected_carbs_g,
      f.expected_mass_g ?? null,
      f.notes ?? null,
      f.created_by ?? null,
      f.source ?? null,
      f.source_url ?? null,
    ],
  });
  return id;
}

/** Insert many fixtures in one round trip (dataset imports). Returns the ids. */
export async function createAnalyzerFixtures(
  rows: NewAnalyzerFixture[],
): Promise<string[]> {
  if (rows.length === 0) return [];
  const db = await getDb();
  const ids = rows.map(() => crypto.randomUUID());
  // Chunked so importing the whole dataset split doesn't send one enormous
  // batch to Turso.
  const CHUNK = 100;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const slice = rows.slice(start, start + CHUNK);
    await db.batch(
      slice.map((f, j) => {
        const i = start + j;
        return {
      sql: `INSERT INTO analyzer_fixtures
              (id, label, mode, photo_base64, photo_thumb_base64, photo_mime,
               input_text, expected_calories, expected_protein_g, expected_fat_g,
               expected_carbs_g, expected_mass_g, notes, created_by, source, source_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      args: [
        ids[i],
        f.label,
        f.mode,
        f.photo_base64 ?? null,
        f.photo_thumb_base64 ?? null,
        f.photo_mime ?? null,
        f.input_text ?? null,
        f.expected_calories,
        f.expected_protein_g,
        f.expected_fat_g,
        f.expected_carbs_g,
        f.expected_mass_g ?? null,
        f.notes ?? null,
        f.created_by ?? null,
        f.source ?? null,
        f.source_url ?? null,
      ] as any[],
        };
      }),
      "write",
    );
  }
  return ids;
}

/** Dataset dish ids already imported, so a re-import doesn't duplicate them. */
export async function existingAnalyzerSourceUrls(source: string): Promise<Set<string>> {
  const db = await getDb();
  const r = await db.execute({
    sql: `SELECT source_url FROM analyzer_fixtures WHERE source = ? AND source_url IS NOT NULL`,
    args: [source],
  });
  return new Set(r.rows.map((row: any) => String(row.source_url)));
}

export async function deleteAnalyzerFixture(id: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `DELETE FROM analyzer_fixtures WHERE id = ?`,
    args: [id],
  });
}

// ---------------------------------------------------------------
// Saved analyzer lab runs
// ---------------------------------------------------------------

export type AnalyzerRunSummary = {
  id: string;
  label: string;
  note: string | null;
  config: any;
  rows: any[];
  created_at: string;
};

export type AnalyzerRun = AnalyzerRunSummary & { cells: any[] };

/** Persist one lab run. `cells` excludes raw model text to keep rows small. */
export async function saveAnalyzerRun(r: {
  label: string;
  note?: string | null;
  config: any;
  rows: any[];
  cells: any[];
  created_by?: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO analyzer_runs
            (id, label, note, config_json, rows_json, cells_json, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [
      id,
      r.label,
      r.note ?? null,
      JSON.stringify(r.config ?? {}),
      JSON.stringify(r.rows ?? []),
      JSON.stringify(r.cells ?? []),
      r.created_by ?? null,
    ],
  });
  return id;
}

/** Past runs, newest first — without the heavy per-dish cells. */
export async function listAnalyzerRuns(limit = 30): Promise<AnalyzerRunSummary[]> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT id, label, note, config_json, rows_json, created_at
            FROM analyzer_runs ORDER BY created_at DESC LIMIT ?`,
    args: [limit],
  });
  return res.rows.map((row: any) => ({
    id: row.id,
    label: row.label,
    note: row.note ?? null,
    config: safeJson(row.config_json, {}),
    rows: safeJson(row.rows_json, []),
    created_at: row.created_at,
  }));
}

export async function getAnalyzerRun(id: string): Promise<AnalyzerRun | null> {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT * FROM analyzer_runs WHERE id = ?`,
    args: [id],
  });
  const row: any = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    note: row.note ?? null,
    config: safeJson(row.config_json, {}),
    rows: safeJson(row.rows_json, []),
    cells: safeJson(row.cells_json, []),
    created_at: row.created_at,
  };
}

export async function deleteAnalyzerRun(id: string): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: `DELETE FROM analyzer_runs WHERE id = ?`, args: [id] });
}

function safeJson<T>(s: any, fallback: T): T {
  try {
    return JSON.parse(String(s)) as T;
  } catch {
    return fallback;
  }
}

/** Fill in ground-truth mass for dataset fixtures imported before the column
 *  existed. Keyed by source_url so it is safe to re-run. */
export async function backfillAnalyzerMass(
  massByUrl: Map<string, number>,
): Promise<number> {
  if (massByUrl.size === 0) return 0;
  const db = await getDb();
  const res = await db.execute(
    `SELECT id, source_url FROM analyzer_fixtures
      WHERE source_url IS NOT NULL AND expected_mass_g IS NULL`,
  );
  const stmts = res.rows
    .map((row: any) => ({ id: row.id, mass: massByUrl.get(String(row.source_url)) }))
    .filter((r) => typeof r.mass === "number")
    .map((r) => ({
      sql: `UPDATE analyzer_fixtures SET expected_mass_g = ? WHERE id = ?`,
      args: [r.mass as number, r.id] as any[],
    }));
  if (stmts.length === 0) return 0;
  await db.batch(stmts, "write");
  return stmts.length;
}
