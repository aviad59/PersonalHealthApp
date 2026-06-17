// Direct Hevy public-API client.
// The hevy-mcp repo is cloned alongside the app for use with Claude Desktop;
// this module talks to api.hevyapp.com directly so we don't need to spawn an MCP subprocess.
//
// Hevy API docs: https://api.hevyapp.com/docs/
// Auth: `api-key: <HEVY_API_KEY>` header (requires Hevy PRO).

import { dateKey } from "@/lib/db";

const BASE = "https://api.hevyapp.com/v1";

export function hevyKey(userId?: string): string {
  if (userId === "eran") {
    const k = process.env.HEVY_API_KEY_ERAN;
    if (!k) throw new Error("HEVY_API_KEY_ERAN is not set. Add it to .env.local");
    return k;
  }
  const k = process.env.HEVY_API_KEY;
  if (!k) throw new Error("HEVY_API_KEY is not set. Add it to .env.local");
  return k;
}

export function hasHevyKey(userId?: string): boolean {
  if (userId === "eran") return !!process.env.HEVY_API_KEY_ERAN;
  return !!process.env.HEVY_API_KEY;
}

async function get<T>(path: string, userId?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      "api-key": hevyKey(userId),
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
