import { NextResponse } from "next/server";
import { listWorkouts, workoutDurationMin } from "@/lib/hevy";
import {
  CachedWorkout,
  upsertWorkouts,
  getCacheLastSyncedAt,
  getCachedWorkouts,
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const PAGE_SIZE = 50;

export async function POST() {
  if (!process.env.HEVY_API_KEY) {
    return NextResponse.json(
      { ok: false, error: "HEVY_API_KEY not set" },
      { status: 400 },
    );
  }
  try {
    const r = await listWorkouts({ page: 1, pageSize: PAGE_SIZE });
    const workouts = r.workouts ?? [];
    const rows: CachedWorkout[] = workouts.map((w) => ({
      id: w.id,
      date: (w.start_time || "").slice(0, 10),
      title: w.title ?? null,
      duration_sec: workoutDurationMin(w) * 60,
      raw_json: JSON.stringify(w),
      synced_at: "",
    }));
    upsertWorkouts(rows);
    return NextResponse.json({
      ok: true,
      pulled: rows.length,
      cachedTotal: getCachedWorkouts(9999).length,
      lastSyncedAt: getCacheLastSyncedAt(),
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "hevy_failed" },
      { status: 500 },
    );
  }
}
