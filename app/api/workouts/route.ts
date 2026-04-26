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
  dateKey,
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const STALE_AFTER_MS = 10 * 60 * 1000; // 10 min
// Hevy API caps pageSize at 10. Pull this many pages on a refresh.
const HEVY_PAGE_SIZE = 10;
const REFRESH_PAGES = 5; // up to 50 most-recent workouts

function topSet(sets: any[]) {
  let best: any = null;
  for (const s of sets) {
    if (s.type === "warmup") continue;
    if (!best) best = s;
    else if ((s.weight_kg ?? 0) > (best.weight_kg ?? 0)) best = s;
  }
  return best ? { weight_kg: best.weight_kg, reps: best.reps } : null;
}

async function refreshCache(): Promise<{
  pulled: number;
  workouts: HevyWorkout[];
  error?: string;
}> {
  try {
    const collected: HevyWorkout[] = [];
    for (let page = 1; page <= REFRESH_PAGES; page++) {
      const r = await listWorkouts({ page, pageSize: HEVY_PAGE_SIZE });
      const ws = r.workouts ?? [];
      collected.push(...ws);
      // Stop early if we've reached the end of history
      if (ws.length < HEVY_PAGE_SIZE) break;
      if (r.page_count && page >= r.page_count) break;
    }
    const rows: CachedWorkout[] = collected.map((w) => {
      const t = Date.parse(w.start_time || "");
      return {
        id: w.id,
        date: Number.isFinite(t) ? dateKey(new Date(t)) : "",
        title: w.title ?? null,
        duration_sec: workoutDurationMin(w) * 60,
        raw_json: JSON.stringify(w),
        synced_at: "",
      };
    });
    await upsertWorkouts(rows);
    return { pulled: rows.length, workouts: collected };
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
      // skip
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

  const [cachedRows, lastSynced] = await Promise.all([
    getCachedWorkouts(50),
    getCacheLastSyncedAt(),
  ]);
  const lastSyncedMs = lastSynced ? Date.parse(lastSynced + "Z") : 0;
  const stale =
    !lastSynced ||
    Number.isNaN(lastSyncedMs) ||
    Date.now() - lastSyncedMs > STALE_AFTER_MS;

  if (!haveKey) {
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

  const refresh = await refreshCache();
  const fresh = await getCachedWorkouts(50);
  const useRows = fresh.length > 0 ? fresh : cachedRows;
  const built = buildResponse(cacheRowsToHevy(useRows).slice(0, limit));

  return NextResponse.json({
    haveKey: true,
    fromCache: refresh.error ? true : refresh.pulled === 0,
    stale: false,
    lastSyncedAt: await getCacheLastSyncedAt(),
    pulled: refresh.pulled,
    error: refresh.error,
    ...built,
  });
}
