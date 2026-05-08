import { NextResponse } from "next/server";
import { listWorkouts, workoutDurationMin, hasHevyKey, HevyWorkout } from "@/lib/hevy";
import {
  CachedWorkout,
  upsertWorkouts,
  getCacheLastSyncedAt,
  getCachedWorkouts,
  dateKey,
} from "@/lib/db";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const HEVY_PAGE_SIZE = 10;
const REFRESH_PAGES = 5;

export async function POST() {
  const userId = getCurrentUserIdOrDefault();
  if (!hasHevyKey(userId)) {
    return NextResponse.json(
      { ok: false, error: "HEVY_API_KEY not set" },
      { status: 400 },
    );
  }
  try {
    const collected: HevyWorkout[] = [];
    for (let page = 1; page <= REFRESH_PAGES; page++) {
      const r = await listWorkouts({ page, pageSize: HEVY_PAGE_SIZE }, userId);
      const ws = r.workouts ?? [];
      collected.push(...ws);
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
    const cachedTotal = (await getCachedWorkouts(9999)).length;
    const lastSyncedAt = await getCacheLastSyncedAt();
    return NextResponse.json({
      ok: true,
      pulled: rows.length,
      cachedTotal,
      lastSyncedAt,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "hevy_failed" },
      { status: 500 },
    );
  }
}
