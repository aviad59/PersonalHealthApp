"use client";

import { useEffect, useState } from "react";

function lsGet<T>(key: string): T | null {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : null; } catch { return null; }
}
function lsSet(key: string, val: unknown) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

type Workout = {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  volume_kg: number;
  avg_rpe: number | null;
  exercise_count: number;
  exercises: { title: string; sets: number; top_set: { weight_kg: number; reps: number; rpe: number | null } | null }[];
};

type Summary = {
  sessions: number;
  totalVolumeKg: number;
  totalMinutes: number;
  avgRpe: number | null;
  byMuscle: Record<string, { sets: number; volumeKg: number }>;
  sessionsByDate: { date: string; title: string; volumeKg: number }[];
};

type WorkoutsData = {
  haveKey: boolean;
  workouts: Workout[];
  summary: Summary | null;
  fromCache?: boolean;
  lastSyncedAt?: string | null;
  pulled?: number;
  error?: string;
};

const CACHE_KEY = "workouts-v1";

export default function WorkoutsPage() {
  const [data, setData] = useState<WorkoutsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);

  async function load(force = false) {
    const r = await fetch(`/api/workouts${force ? "?force=1" : ""}`, {
      cache: "no-store",
    });
    const j = await r.json();
    setData(j);
    setLoading(false);
    lsSet(CACHE_KEY, j);
  }

  async function hardRefresh() {
    setRefreshing(true);
    try {
      await fetch("/api/workouts/refresh", { method: "POST" });
      await load(false);
    } finally {
      setRefreshing(false);
    }
  }

  async function backfillHistory() {
    if (!confirm("Pull your full Hevy workout history into the cache? This can take a minute.")) return;
    setBackfilling(true);
    setBackfillMsg(null);
    try {
      const r = await fetch("/api/workouts/refresh?full=1", { method: "POST" });
      const j = await r.json();
      setBackfillMsg(j.ok ? `Cached ${j.cachedTotal} workouts total.` : j.error || "Backfill failed.");
      await load(false);
    } catch (e: any) {
      setBackfillMsg(e.message || "Backfill failed.");
    } finally {
      setBackfilling(false);
    }
  }

  useEffect(() => {
    // Show cached data immediately — no loading screen if we have something
    // — then refresh from the server (cheap DB cache or, if stale, Hevy) in
    // the background; `loading` stays true until that refresh lands so the
    // stale view pulses rather than flashing a blank loading screen.
    const cached = lsGet<WorkoutsData>(CACHE_KEY);
    if (cached) setData(cached);
    load();
  }, []);

  if (loading && !data) return <div className="p-6 text-white/60">Loading…</div>;
  if (!data) return <div className="p-6 text-white/60">No data</div>;

  if (!data.haveKey && !data.fromCache) {
    return (
      <div className="px-5 pt-6 space-y-3 md:max-w-3xl md:mx-auto">
        <h1 className="text-2xl font-bold">Workouts</h1>
        <div className="card p-5 text-sm text-white/70">
          Set <code className="text-accent-brand">HEVY_API_KEY</code> in your <code>.env.local</code> and restart to
          pull workouts from Hevy.
        </div>
      </div>
    );
  }

  return (
    <div
      className={`px-5 pt-6 pb-10 space-y-5 md:max-w-3xl md:mx-auto ${
        loading ? "animate-pulse [animation-duration:2.5s]" : ""
      }`}
    >
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Workouts</h1>
          <p className="text-[11px] text-white/40 mt-0.5">
            {data.fromCache ? "from cache" : "live from Hevy"}
            {data.lastSyncedAt
              ? ` · synced ${new Date(data.lastSyncedAt + "Z").toLocaleString()}`
              : ""}
            {typeof data.pulled === "number" && data.pulled > 0
              ? ` · pulled ${data.pulled}`
              : ""}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={hardRefresh}
            disabled={refreshing}
            className="text-xs text-accent-brand disabled:opacity-40"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button
            onClick={backfillHistory}
            disabled={backfilling}
            className="text-[11px] text-white/40 hover:text-white/70 transition-colors disabled:opacity-40"
          >
            {backfilling ? "Backfilling…" : "Backfill full history"}
          </button>
        </div>
      </div>

      {backfillMsg && (
        <div className="text-xs text-white/60">{backfillMsg}</div>
      )}

      {data.error && (
        <div className="card p-4 border-red-500/30 text-sm text-red-400">{data.error}</div>
      )}

      {data.summary && (
        <section className="card p-5 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">Last 7 days</h2>
          <div className={`grid gap-3 ${data.summary.avgRpe !== null ? "grid-cols-4" : "grid-cols-3"}`}>
            <Stat label="Sessions" value={data.summary.sessions.toString()} />
            <Stat label="Volume" value={`${Math.round(data.summary.totalVolumeKg).toLocaleString()} kg`} />
            <Stat label="Minutes" value={data.summary.totalMinutes.toString()} />
            {data.summary.avgRpe !== null && (
              <Stat label="Avg RPE" value={data.summary.avgRpe.toString()} />
            )}
          </div>
          {Object.keys(data.summary.byMuscle).length > 0 && (
            <div className="pt-2">
              <div className="text-xs text-white/50 mb-2">Sets by muscle group</div>
              <div className="space-y-1.5">
                {Object.entries(data.summary.byMuscle)
                  .sort(([, a], [, b]) => b.sets - a.sets)
                  .map(([m, d]) => (
                    <MuscleBar key={m} muscle={m} sets={d.sets} max={maxSets(data.summary!.byMuscle)} />
                  ))}
              </div>
            </div>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">Recent sessions</h2>
        {data.workouts.length === 0 && (
          <div className="card p-5 text-sm text-white/60">No workouts yet.</div>
        )}
        {data.workouts.map((w) => (
          <div key={w.id} className="card p-4">
            <div className="flex justify-between items-start">
              <div>
                <div className="font-semibold">{w.title}</div>
                <div className="text-xs text-white/50">
                  {new Date(w.start_time).toLocaleString()} · {w.exercise_count} exercises
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm text-accent-brand font-medium">
                  {Math.round(w.volume_kg).toLocaleString()} kg
                </div>
                {w.avg_rpe !== null && (
                  <div className="text-[11px] text-white/40">RPE {w.avg_rpe}</div>
                )}
              </div>
            </div>
            <ul className="mt-3 space-y-1 text-[13px] text-white/70">
              {w.exercises.slice(0, 6).map((ex, i) => (
                <li key={i} className="flex justify-between">
                  <span>{ex.title} <span className="text-white/40">×{ex.sets}</span></span>
                  {ex.top_set && (
                    <span className="text-white/60">
                      {ex.top_set.weight_kg ?? 0}kg × {ex.top_set.reps ?? 0}
                      {ex.top_set.rpe !== null ? ` @${ex.top_set.rpe}` : ""}
                    </span>
                  )}
                </li>
              ))}
              {w.exercises.length > 6 && (
                <li className="text-white/40 text-xs">+ {w.exercises.length - 6} more</li>
              )}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-bg-elev border border-border p-3 text-center">
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-white/50">{label}</div>
    </div>
  );
}

function MuscleBar({ muscle, sets, max }: { muscle: string; sets: number; max: number }) {
  const pct = max > 0 ? (sets / max) * 100 : 0;
  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="w-20 text-white/60 capitalize">{muscle}</div>
      <div className="flex-1 h-2 rounded-full bg-bg-elev overflow-hidden">
        <div className="h-full bg-accent-brand" style={{ width: `${pct}%` }} />
      </div>
      <div className="w-8 text-right text-white/80">{sets}</div>
    </div>
  );
}

function maxSets(m: Record<string, { sets: number; volumeKg: number }>) {
  let max = 0;
  for (const k of Object.keys(m)) max = Math.max(max, m[k].sets);
  return max;
}
