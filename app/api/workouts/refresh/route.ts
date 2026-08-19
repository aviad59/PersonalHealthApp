import { NextRequest, NextResponse } from "next/server";
import {
  listWorkouts,
  pullRecentWorkouts,
  workoutDurationMin,
  hasHevyKey,
  hevyKeyEnvVarName,
  hevyKeyMissingMessage,
  HevyWorkout,
} from "@/lib/hevy";
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
export const maxDuration = 60;

const HEVY_PAGE_SIZE = 10;
const REFRESH_PAGES = 5; // most-recent-only refresh (default)
const BACKFILL_PAGES = 200; // ?full=1 — pages through the user's entire history

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserIdOrDefault();
  if (!(await hasHevyKey(userId))) {
    return NextResponse.json(
      { ok: false, error: hevyKeyMissingMessage(await hevyKeyEnvVarName(userId)) },
      { status: 400 },
    );
  }
  const full = new URL(req.url).searchParams.get("full") === "1";
  try {
    let collected: HevyWorkout[];
    if (full) {
      // Backfill: page forward through the whole history until a partial page
      // (the end of the list) or the safety cap.
      collected = [];
      for (let page = 1; page <= BACKFILL_PAGES; page++) {
        const r = await listWorkouts({ page, pageSize: HEVY_PAGE_SIZE }, userId);
        const ws = r.workouts ?? [];
        collected.push(...ws);
        if (ws.length < HEVY_PAGE_SIZE) break;
        if (r.page_count && page >= r.page_count) break;
      }
    } else {
      // Incremental: order-independent pull so the newest workout is always
      // captured, whichever end of Hevy's list it sits on.
      collected = await pullRecentWorkouts(REFRESH_PAGES, userId);
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
    await upsertWorkouts(userId, rows);
    const cachedTotal = (await getCachedWorkouts(userId, 9999)).length;
    const lastSyncedAt = await getCacheLastSyncedAt(userId);
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
