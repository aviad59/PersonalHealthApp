import { NextRequest, NextResponse } from "next/server";
import {
  listWorkouts,
  summarizeWeek,
  workoutVolumeKg,
  workoutDurationMin,
  HevyWorkout,
} from "@/lib/hevy";
import {
  CachedWorkout,
  getCachedWorkouts,
  getCacheLastSyncedAt,
  upsertWorkouts,
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Refresh from Hevy if cache is older than this. A force=1 query bypasses the TTL.
const STALE_AFTER_MS = 10 * 60 * 1000; // 10 minutes
// How many recent workouts to pull from Hevy on a refresh.
const REFRESH_PAGE_SIZE = 50;

function topSet(sets: any[]) {
  let best: any = null;
  for (const s of sets) {
    if (s.type === "warmup") continue;
    if (!best) best = s;
    else if ((s.weight_kg ?? 0) > (best.weight_kg ?? 0)) best = s;
  }
  return best ? { weight_kg: best.weight_kg, reps: best.reps } : null;
}

/** Fetch from Hevy and write into the local cache. Returns the workouts it pulled. */
async function refreshCache(): Promise<{
  pulled: number;
  workouts: HevyWorkout[];
  error?: string;
}> {
  try {
    const r = await listWorkouts({ page: 1, pageSize: REFRESH_PAGE_SIZE });
    const workouts = r.workouts ?? [];
    const rows: CachedWorkout[] = workouts.map((w) => ({
      id: w.id,
      date: (w.start_time || "").slice(0, 10),
      title: w.title ?? null,
      duration_sec: workoutDurationMin(w) * 60,
      raw_json: JSON.stringify(w),
      synced_at: "", // overwritten by SQL datetime('now')
    }));
    upsertWorkouts(rows);
    return { pulled: rows.length, workouts };
  } catch (e: any) {
    return { pulled: 0, workouts: [], error: e?.message ?? "hevy_fetch_failed" };
  }
}

function cacheRowsToHevy(rows: CachedWorkout[]): HevyWorkout[] {
  const out: HevyWorkout[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.raw_json) as HevyWorkout);
    } catch {
      // skip a corrupt row rather than blow up the page
    }
  }
  return out;
}

function buildResponse(workouts: HevyWorkout[]) {
  const weekStartMs = Date.now() - 7 * 24 * 3600 * 1000;
  const thisWeek = workouts.filter(
    (w) => Date.parse(w.start_time) >= weekStartMs,
  );
  const summary = summarizeWeek(thisWeek);
  return {
    workouts: workouts.map((w) => ({
      id: w.id,
      title: w.title,
      start_time: w.start_time,
      end_time: w.end_time,
      volume_kg: workoutVolumeKg(w),
      exercise_count: w.exercises.length,
      exercises: w.exercises.map((ex) => ({
        title: ex.title,
        sets: ex.sets.length,
        top_set: topSet(ex.sets),
      })),
    })),
    summary,
  };
}

export async function GET(req: NextRequest) {
  const haveKey = !!process.env.HEVY_API_KEY;
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const limit = Number(url.searchParams.get("limit") ?? "20");

  // Always try to serve from cache first.
  const cachedRows = getCachedWorkouts(Math.max(limit, REFRESH_PAGE_SIZE));
  const lastSynced = getCacheLastSyncedAt();
  const lastSyncedMs = lastSynced ? Date.parse(lastSynced + "Z") : 0;
  const stale =
    !lastSynced || Number.isNaN(lastSyncedMs) ||
    Date.now() - lastSyncedMs > STALE_AFTER_MS;

  if (!haveKey) {
    // No key but we may still have cached data from a previous session.
    if (cachedRows.length > 0) {
      const built = buildResponse(cacheRowsToHevy(cachedRows).slice(0, limit));
      return NextResponse.json({
        haveKey: false,
        fromCache: true,
        lastSyncedAt: lastSynced,
        ...built,
      });
    }
    return NextResponse.json({
      haveKey: false,
      fromCache: false,
      workouts: [],
      summary: null,
    });
  }

  // If we have any cache and aren't forced to refresh, serve immediately.
  if (cachedRows.length > 0 && !force && !stale) {
    const built = buildResponse(cacheRowsToHevy(cachedRows).slice(0, limit));
    return NextResponse.json({
      haveKey: true,
      fromCache: true,
      stale: false,
      lastSyncedAt: lastSynced,
      ...built,
    });
  }

  // Cache empty / stale / forced → refresh inline.
  const refresh = await refreshCache();
  // Re-read cache to include any rows we just inserted.
  const fresh = getCachedWorkouts(Math.max(limit, REFRESH_PAGE_SIZE));
  const useRows = fresh.length > 0 ? fresh : cachedRows;
  const built = buildResponse(cacheRowsToHevy(useRows).slice(0, limit));

  return NextResponse.json({
    haveKey: true,
    fromCache: refresh.error ? true : refresh.pulled === 0,
    stale: false,
    lastSyncedAt: getCacheLastSyncedAt(),
    pulled: refresh.pulled,
    error: refresh.error,
    ...built,
  });
}
