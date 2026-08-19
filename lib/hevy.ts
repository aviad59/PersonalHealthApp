// Direct Hevy public-API client.
// The hevy-mcp repo is cloned alongside the app for use with Claude Desktop;
// this module talks to api.hevyapp.com directly so we don't need to spawn an MCP subprocess.
//
// Hevy API docs: https://api.hevyapp.com/docs/
// Auth: `api-key: <HEVY_API_KEY>` header (requires Hevy PRO).

import { dateKey } from "@/lib/db";
import { getUserConfig } from "@/lib/user";

const BASE = "https://api.hevyapp.com/v1";

// Each workouts-enabled user needs their OWN key so we never pull another
// user's workouts. Two ways to supply it, checked in this order:
//
//   1. `hevyApiKey` on the user — the key itself, set from the admin panel.
//      Adding a user then needs no deploy.
//   2. `hevyKeyEnv` — the NAME of an environment variable holding the key,
//      defaulting to `HEVY_API_KEY_<ID>`. Keeps the key out of the database
//      for anyone who prefers that, and is how this worked originally.
async function hevyEnvVar(userId?: string): Promise<string> {
  if (!userId) return "HEVY_API_KEY";
  const cfg = await getUserConfig(userId);
  return cfg.hevyKeyEnv || `HEVY_API_KEY_${userId.toUpperCase()}`;
}

async function resolveHevyKey(
  userId?: string,
): Promise<{ key: string | null; envVar: string }> {
  const envVar = await hevyEnvVar(userId);
  if (userId) {
    const cfg = await getUserConfig(userId);
    const stored = cfg.hevyApiKey?.trim();
    if (stored) return { key: stored, envVar };
  }
  return { key: process.env[envVar] || null, envVar };
}

export async function hevyKey(userId?: string): Promise<string> {
  const { key, envVar } = await resolveHevyKey(userId);
  if (!key) throw new Error(hevyKeyMissingMessage(envVar));
  return key;
}

export async function hasHevyKey(userId?: string): Promise<boolean> {
  return !!(await resolveHevyKey(userId)).key;
}

/** Names the variable actually checked — the old message was a hardcoded
 *  "HEVY_API_KEY not set" that never said which one was missing. */
export function hevyKeyMissingMessage(envVar: string): string {
  return `No Hevy API key for this user. Paste the key into the admin panel, or set the ${envVar} environment variable.`;
}

/** The env var this user's key would come from, for diagnostics. */
export async function hevyKeyEnvVarName(userId?: string): Promise<string> {
  return hevyEnvVar(userId);
}

async function get<T>(path: string, userId?: string): Promise<T> {
  const apiKey = await hevyKey(userId);
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      "api-key": apiKey,
      "accept": "application/json",
    },
    // Next.js: don't cache — Hevy data is user-specific & lightweight.
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hevy API ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export type HevySet = {
  index: number;
  type: string; // "normal" | "warmup" | "failure" | ...
  weight_kg: number | null;
  reps: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  rpe?: number | null;
  custom_metric?: number | null;
};

export type HevyExercise = {
  index: number;
  title: string;
  notes?: string;
  exercise_template_id: string;
  superset_id?: number | null;
  sets: HevySet[];
};

export type HevyWorkout = {
  id: string;
  title: string;
  description?: string;
  start_time: string;
  end_time: string;
  updated_at?: string;
  created_at?: string;
  exercises: HevyExercise[];
};

export type WorkoutsResponse = {
  page: number;
  page_count: number;
  workouts: HevyWorkout[];
};

export async function listWorkouts(opts: { page?: number; pageSize?: number } = {}, userId?: string): Promise<WorkoutsResponse> {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 10;
  return get<WorkoutsResponse>(`/workouts?page=${page}&pageSize=${pageSize}`, userId);
}

export async function workoutCount(userId?: string): Promise<{ workout_count: number }> {
  return get<{ workout_count: number }>(`/workouts/count`, userId);
}

/**
 * Pull the most-recent workouts, robust to Hevy's page ordering.
 *
 * Hevy's `/v1/workouts` list does NOT document whether page 1 holds the newest
 * or the oldest workouts, so a fixed "pages 1..N" pull can silently miss a
 * just-finished workout when the newest entries live on the last page. That's
 * the classic "my latest workout won't sync even after a manual refresh" bug.
 *
 * To be safe regardless of order we fetch up to `maxPages` from BOTH ends of
 * the list (page 1.. and page_count..) and dedupe by id — whichever end holds
 * the newest workouts, they're captured. For a small history the two ranges
 * overlap and we simply fetch every page once.
 */
export async function pullRecentWorkouts(
  maxPages: number,
  userId?: string,
): Promise<HevyWorkout[]> {
  const pageSize = 10;
  const first = await listWorkouts({ page: 1, pageSize }, userId);
  const pageCount = Math.max(1, first.page_count ?? 1);

  const byId = new Map<string, HevyWorkout>();
  for (const w of first.workouts ?? []) byId.set(w.id, w);

  const pages = new Set<number>();
  // Newest end if the list is newest-first: pages 2..maxPages.
  for (let p = 2; p <= Math.min(maxPages, pageCount); p++) pages.add(p);
  // Newest end if the list is oldest-first: the last maxPages pages.
  for (let p = pageCount; p > Math.max(1, pageCount - maxPages); p--) pages.add(p);
  pages.delete(1); // already fetched

  for (const p of pages) {
    const r = await listWorkouts({ page: p, pageSize }, userId);
    for (const w of r.workouts ?? []) byId.set(w.id, w);
  }
  return [...byId.values()];
}

// --- Lightweight derivations ---

/** Total volume (weight * reps summed across all working sets) of a workout. */
export function workoutVolumeKg(w: HevyWorkout): number {
  let total = 0;
  for (const ex of w.exercises) {
    for (const s of ex.sets) {
      if (s.type === "warmup") continue;
      const weight = s.weight_kg ?? 0;
      const reps = s.reps ?? 0;
      total += weight * reps;
    }
  }
  return Math.round(total);
}

/** Average logged RPE across a workout's working sets, or null if none logged. */
export function workoutAvgRpe(w: HevyWorkout): number | null {
  const rpes: number[] = [];
  for (const ex of w.exercises) {
    for (const s of ex.sets) {
      if (s.type === "warmup") continue;
      if (typeof s.rpe === "number") rpes.push(s.rpe);
    }
  }
  if (rpes.length === 0) return null;
  return Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10;
}

/** Average logged RPE across all working sets of several workouts, or null if none logged. */
export function avgRpeAcrossWorkouts(workouts: HevyWorkout[]): number | null {
  const rpes: number[] = [];
  for (const w of workouts) {
    for (const ex of w.exercises) {
      for (const s of ex.sets) {
        if (s.type === "warmup") continue;
        if (typeof s.rpe === "number") rpes.push(s.rpe);
      }
    }
  }
  if (rpes.length === 0) return null;
  return Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10;
}

/** Returns duration in minutes for a workout, floored. */
export function workoutDurationMin(w: HevyWorkout): number {
  try {
    const a = Date.parse(w.start_time);
    const b = Date.parse(w.end_time);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    return Math.max(0, Math.round((b - a) / 60000));
  } catch {
    return 0;
  }
}

/** Infer primary muscle groups from exercise title (best-effort heuristic). */
export function inferMuscleGroups(exerciseTitle: string): string[] {
  const t = exerciseTitle.toLowerCase();
  const groups = new Set<string>();
  const add = (g: string) => groups.add(g);

  if (/bench|push[- ]?up|chest|fly|pec/.test(t)) add("chest");
  if (/squat|leg press|lunge|split squat|hack/.test(t)) add("quads");
  if (/deadlift|rdl|good ?morning|hip thrust|glute|kickback/.test(t)) add("glutes");
  if (/leg curl|hamstring|nordic/.test(t)) add("hamstrings");
  if (/calf|raise(?!.*leg press)/.test(t)) add("calves");
  if (/row|pull[- ]?up|pulldown|lat|chin[- ]?up/.test(t)) add("back");
  if (/shoulder|ohp|overhead press|lateral raise|rear delt|face pull/.test(t)) add("shoulders");
  if (/curl(?!.*leg)/.test(t)) add("biceps");
  if (/tricep|skull|pushdown|dip/.test(t)) add("triceps");
  if (/ab(s)?\b|crunch|plank|leg raise|hanging|cable crunch|core/.test(t)) add("core");

  if (groups.size === 0) add("other");
  return [...groups];
}

export type WeeklySummary = {
  sessions: number;
  totalVolumeKg: number;
  totalMinutes: number;
  avgRpe: number | null;
  byMuscle: Record<string, { sets: number; volumeKg: number }>;
  sessionsByDate: { date: string; title: string; volumeKg: number }[];
};

export function summarizeWeek(workouts: HevyWorkout[]): WeeklySummary {
  const byMuscle: WeeklySummary["byMuscle"] = {};
  let totalVolumeKg = 0;
  let totalMinutes = 0;
  const sessionsByDate: WeeklySummary["sessionsByDate"] = [];

  for (const w of workouts) {
    const vol = workoutVolumeKg(w);
    totalVolumeKg += vol;
    totalMinutes += workoutDurationMin(w);
    sessionsByDate.push({
      date: dateKey(new Date(w.start_time)),
      title: w.title,
      volumeKg: vol,
    });
    for (const ex of w.exercises) {
      const groups = inferMuscleGroups(ex.title);
      const workingSets = ex.sets.filter((s) => s.type !== "warmup");
      const exVol = workingSets.reduce(
        (acc, s) => acc + (s.weight_kg ?? 0) * (s.reps ?? 0),
        0,
      );
      for (const g of groups) {
        if (!byMuscle[g]) byMuscle[g] = { sets: 0, volumeKg: 0 };
        byMuscle[g].sets += workingSets.length;
        byMuscle[g].volumeKg += exVol;
      }
    }
  }

  // Round per-muscle volumes
  for (const g of Object.keys(byMuscle)) {
    byMuscle[g].volumeKg = Math.round(byMuscle[g].volumeKg);
  }

  return {
    sessions: workouts.length,
    totalVolumeKg: Math.round(totalVolumeKg),
    totalMinutes,
    avgRpe: avgRpeAcrossWorkouts(workouts),
    byMuscle,
    sessionsByDate,
  };
}
