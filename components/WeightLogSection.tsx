"use client";

import { useEffect, useState } from "react";

type Entry = {
  date: string;
  weight_kg: number;
  note: string | null;
  created_at: string;
  updated_at: string;
};

type Trend = {
  count: number;
  earliest: string | null;
  latest: string | null;
  ma7_kg: number | null;
  ma28_kg: number | null;
  slope_kg_per_week: number | null;
  expected_slope_kg_per_week: number;
  suggestion: { delta_kcal: number; reason: string } | null;
};

type Resp = {
  log: Entry[];
  trend: Trend;
  goal_mode: string;
  today: string;
};

export default function WeightLogSection({
  onProfileMaybeChanged,
}: {
  onProfileMaybeChanged?: () => void;
}) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [input, setInput] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<{ kcal: number; carbs: number } | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/weight", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "fetch failed");
      setData(j);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function logToday() {
    if (!input) return;
    const weight_kg = Number(input);
    if (!Number.isFinite(weight_kg) || weight_kg <= 0) {
      setErr("enter a valid weight");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/weight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weight_kg, sync_profile: true }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "save failed");
      setInput("");
      await load();
      onProfileMaybeChanged?.();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function applySuggestion() {
    if (!data?.trend.suggestion) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/weight", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apply_delta_kcal: data.trend.suggestion.delta_kcal,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "apply failed");
      setApplied({ kcal: j.new_goal_calories, carbs: j.new_goal_carbs_g });
      onProfileMaybeChanged?.();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <section className="card p-5">
        <div className="text-sm text-white/60">Loading weight log...</div>
      </section>
    );
  }

  const log = data?.log ?? [];
  const trend = data?.trend;

  return (
    <section className="card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
          Weight log
        </h2>
        {trend && trend.count > 0 && (
          <span className="text-[11px] text-white/40">
            {trend.count} entr{trend.count === 1 ? "y" : "ies"}
          </span>
        )}
      </div>

      {/* Quick log input */}
      <div className="flex gap-2">
        <input
          inputMode="decimal"
          value={input}
          onChange={(e) => setInput(e.target.value.replace(/[^\d.]/g, ""))}
          placeholder="Today's weight (kg)"
          className="flex-1 rounded-xl bg-bg-elev border border-border px-4 py-3 text-[15px] focus:outline-none focus:border-accent-brand"
        />
        <button
          onClick={logToday}
          disabled={busy || !input}
          className="rounded-xl bg-accent-brand px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
        >
          Log
        </button>
      </div>

      {err && <div className="text-sm text-red-400">{err}</div>}

      {/* Trend stats */}
      {trend && trend.count > 0 && (
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="7-day avg" value={trend.ma7_kg != null ? `${trend.ma7_kg} kg` : "—"} />
          <Stat label="28-day avg" value={trend.ma28_kg != null ? `${trend.ma28_kg} kg` : "—"} />
          <Stat
            label="Trend / wk"
            value={
              trend.slope_kg_per_week != null
                ? `${trend.slope_kg_per_week > 0 ? "+" : ""}${trend.slope_kg_per_week} kg`
                : "—"
            }
          />
        </div>
      )}

      {/* Sparkline */}
      {log.length >= 2 && <WeightSpark entries={log} />}

      {/* Trend suggestion */}
      {trend?.suggestion && !applied && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-amber-400">
            Calorie adjustment suggested
          </div>
          <div className="text-sm text-white/80">{trend.suggestion.reason}</div>
          <button
            onClick={applySuggestion}
            disabled={busy}
            className="w-full rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 py-2 text-xs font-semibold disabled:opacity-40"
          >
            {busy
              ? "Applying..."
              : `Apply ${trend.suggestion.delta_kcal > 0 ? "+" : ""}${trend.suggestion.delta_kcal} kcal/day`}
          </button>
        </div>
      )}

      {applied && (
        <div className="rounded-xl border border-green-500/40 bg-green-500/5 p-3 text-sm text-green-300">
          Updated to {applied.kcal} kcal/day, {applied.carbs} g carbs.
        </div>
      )}

      {trend && trend.count > 0 && trend.count < 7 && (
        <div className="text-[11px] text-white/40">
          Log a few more days for a smoothed average. Need ~3 weeks of data for a calorie-adjustment suggestion.
        </div>
      )}

      {log.length === 0 && (
        <div className="text-[11px] text-white/40">
          No entries yet. Log your weight here regularly — once you have ~3 weeks the app will tell you if calories need to be adjusted to match your goal.
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-bg-elev border border-border py-2">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="text-sm font-semibold mt-0.5">{value}</div>
    </div>
  );
}

function WeightSpark({ entries }: { entries: Entry[] }) {
  const W = 280;
  const H = 60;
  const padX = 4;
  const padY = 6;
  const ws = entries.map((e) => e.weight_kg);
  const min = Math.min(...ws);
  const max = Math.max(...ws);
  const span = max - min || 1;
  const xs =
    entries.length === 1
      ? [W / 2]
      : entries.map((_, i) =>
          padX + (i * (W - 2 * padX)) / (entries.length - 1),
        );
  const ys = ws.map((w) => H - padY - ((w - min) / span) * (H - 2 * padY));
  const d = xs.map((x, i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(" ");

  return (
    <div className="rounded-lg bg-bg-elev border border-border p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-14">
        <path
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="text-accent-brand"
        />
        {xs.map((x, i) => (
          <circle
            key={i}
            cx={x}
            cy={ys[i]}
            r={1.5}
            className="fill-accent-brand"
          />
        ))}
      </svg>
      <div className="flex justify-between text-[9px] text-white/40 mt-0.5 px-1">
        <span>{entries[0].date}</span>
        <span>
          {min.toFixed(1)} – {max.toFixed(1)} kg
        </span>
        <span>{entries[entries.length - 1].date}</span>
      </div>
    </div>
  );
}
