"use client";

import { useEffect, useMemo, useState } from "react";

type DayBucket = {
  date: string;
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  meals: number;
};

type Stats = {
  today: string;
  since: string;
  days: number;
  series: DayBucket[];
  averages: { calories: number; protein_g: number; fat_g: number; carbs_g: number };
  totals: { calories: number; protein_g: number; fat_g: number; carbs_g: number };
  targets: { calories: number; protein_g: number; fat_g: number; carbs_g: number } | null;
  daysLogged: number;
  proteinHitRate: number | null;
  bestProtein: DayBucket | null;
  highestCal: DayBucket | null;
};

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" },
] as const;

export default function StatsPage() {
  const [days, setDays] = useState<number>(14);
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [metric, setMetric] = useState<"calories" | "protein_g" | "fat_g" | "carbs_g">("calories");

  useEffect(() => {
    let dead = false;
    setLoading(true);
    setErr(null);
    // Note: we intentionally keep the previous `data` so switching range
    // doesn't blank the page. The new payload replaces it once it arrives.
    (async () => {
      try {
        const r = await fetch(`/api/stats?days=${days}`, { cache: "no-store" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "stats failed");
        if (!dead) setData(j);
      } catch (e: any) {
        if (!dead) setErr(e.message);
      } finally {
        if (!dead) setLoading(false);
      }
    })();
    return () => {
      dead = true;
    };
  }, [days]);

  const target = data?.targets ? data.targets[metric] : null;
  const max = useMemo(() => {
    if (!data) return 0;
    let m = 0;
    for (const d of data.series) m = Math.max(m, d[metric]);
    if (target) m = Math.max(m, target);
    return m || 1;
  }, [data, metric, target]);

  const metricLabel: Record<typeof metric, string> = {
    calories: "Calories",
    protein_g: "Protein",
    fat_g: "Fat",
    carbs_g: "Carbs",
  } as any;
  const metricUnit: Record<typeof metric, string> = {
    calories: "kcal",
    protein_g: "g",
    fat_g: "g",
    carbs_g: "g",
  } as any;

  return (
    <div className="px-5 pt-6 pb-32 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Stats</h1>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={`text-[11px] rounded-full px-3 py-1.5 border transition-colors ${
                days === r.days
                  ? "bg-accent-brand text-white border-accent-brand"
                  : "bg-bg-elev text-white/70 border-border"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="card p-4 text-sm text-red-400">{err}</div>
      )}

      {loading && !data && <StatsSkeleton />}

      {data && (
        <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
          {/* Averages summary */}
          <section className="card p-4">
            <div className="text-[10px] uppercase tracking-wider text-white/50 mb-3">
              Daily averages — last {data.days} days · logged {data.daysLogged}/{data.days}
            </div>
            <div className="grid grid-cols-4 gap-3">
              <Stat
                label="kcal"
                value={data.averages.calories}
                target={data.targets?.calories}
              />
              <Stat
                label="Protein"
                value={data.averages.protein_g}
                unit="g"
                target={data.targets?.protein_g}
              />
              <Stat
                label="Fat"
                value={data.averages.fat_g}
                unit="g"
                target={data.targets?.fat_g}
              />
              <Stat
                label="Carbs"
                value={data.averages.carbs_g}
                unit="g"
                target={data.targets?.carbs_g}
              />
            </div>
          </section>

          {/* Metric switcher + bar chart */}
          <section className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] uppercase tracking-wider text-white/50">
                {metricLabel[metric]} per day
              </div>
              <div className="flex gap-1">
                {(["calories", "protein_g", "fat_g", "carbs_g"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setMetric(k)}
                    className={`text-[10px] rounded-full px-2.5 py-1 border ${
                      metric === k
                        ? "bg-accent-brand/20 text-accent-brand border-accent-brand/40"
                        : "bg-bg-elev text-white/60 border-border"
                    }`}
                  >
                    {k === "calories" ? "kcal" : k === "protein_g" ? "P" : k === "fat_g" ? "F" : "C"}
                  </button>
                ))}
              </div>
            </div>

            <BarChart
              series={data.series}
              metric={metric}
              max={max}
              target={target ?? null}
              unit={metricUnit[metric]}
            />
          </section>

          {/* Highlights */}
          <section className="card p-4 space-y-3">
            <div className="text-[10px] uppercase tracking-wider text-white/50">Highlights</div>
            {data.proteinHitRate !== null && (
              <Row
                k="Days hit protein (≥90% of target)"
                v={`${data.proteinHitRate}%`}
              />
            )}
            {data.bestProtein && (
              <Row
                k="Top protein day"
                v={`${formatDay(data.bestProtein.date)} · ${data.bestProtein.protein_g}g`}
              />
            )}
            {data.highestCal && (
              <Row
                k="Highest calorie day"
                v={`${formatDay(data.highestCal.date)} · ${data.highestCal.calories} kcal`}
              />
            )}
            <Row k="Total kcal in window" v={`${data.totals.calories.toLocaleString()}`} />
            <Row k="Total protein in window" v={`${data.totals.protein_g} g`} />
          </section>

          {/* Daily breakdown */}
          <section className="card p-4">
            <div className="text-[10px] uppercase tracking-wider text-white/50 mb-3">
              Daily breakdown
            </div>
            <div className="divide-y divide-border">
              {[...data.series].reverse().map((d) => (
                <DayRow key={d.date} day={d} targets={data.targets} />
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="space-y-5 animate-pulse">
      <section className="card p-4">
        <div className="h-3 w-40 rounded bg-white/10 mb-4" />
        <div className="grid grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="text-center space-y-1.5">
              <div className="h-2 w-10 mx-auto rounded bg-white/10" />
              <div className="h-5 w-12 mx-auto rounded bg-white/15" />
              <div className="h-2 w-14 mx-auto rounded bg-white/10" />
            </div>
          ))}
        </div>
      </section>
      <section className="card p-4">
        <div className="h-3 w-32 rounded bg-white/10 mb-4" />
        <div className="flex items-end gap-[2px] h-[120px]">
          {Array.from({ length: 14 }).map((_, i) => (
            <div
              key={i}
              className="flex-1 rounded-t-sm bg-white/10"
              style={{ height: `${30 + ((i * 7) % 70)}%` }}
            />
          ))}
        </div>
      </section>
      <section className="card p-4 space-y-3">
        <div className="h-3 w-24 rounded bg-white/10" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center justify-between">
            <div className="h-3 w-2/5 rounded bg-white/10" />
            <div className="h-3 w-16 rounded bg-white/10" />
          </div>
        ))}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  target,
}: {
  label: string;
  value: number;
  unit?: string;
  target?: number;
}) {
  const pct = target ? Math.min(150, Math.round((value / target) * 100)) : null;
  return (
    <div className="text-center">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="text-lg font-bold mt-0.5">
        {value}
        {unit ? <span className="text-xs text-white/50 ml-0.5">{unit}</span> : null}
      </div>
      {pct !== null && (
        <div
          className={`text-[10px] mt-0.5 ${
            pct >= 95 && pct <= 110 ? "text-green-400" : pct < 90 ? "text-amber-400" : "text-white/50"
          }`}
        >
          {pct}% of target
        </div>
      )}
    </div>
  );
}

function BarChart({
  series,
  metric,
  max,
  target,
  unit,
}: {
  series: DayBucket[];
  metric: "calories" | "protein_g" | "fat_g" | "carbs_g";
  max: number;
  target: number | null;
  unit: string;
}) {
  // Render up to ~30 bars. Container height ~120px.
  const HEIGHT = 120;
  return (
    <div>
      <div className="relative" style={{ height: HEIGHT + 16 }}>
        {target ? (
          <div
            className="absolute left-0 right-0 border-t border-dashed border-accent-brand/50"
            style={{ top: HEIGHT - (target / max) * HEIGHT }}
          >
            <span className="absolute -top-3.5 right-0 text-[9px] text-accent-brand/80">
              target {target}
            </span>
          </div>
        ) : null}
        <div className="absolute inset-x-0 bottom-4 flex items-end gap-[2px] h-[120px]">
          {series.map((d) => {
            const v = d[metric];
            const h = Math.max(2, (v / max) * HEIGHT);
            const isToday = d.date === series[series.length - 1].date;
            const empty = d.meals === 0;
            return (
              <div
                key={d.date}
                className="flex-1 relative group"
                title={`${d.date}: ${v} ${unit}${empty ? " (no meals)" : ""}`}
              >
                <div
                  className={`w-full rounded-t-sm transition-colors ${
                    empty
                      ? "bg-white/10"
                      : isToday
                      ? "bg-accent-brand"
                      : "bg-accent-brand/60"
                  }`}
                  style={{ height: h }}
                />
              </div>
            );
          })}
        </div>
        <div className="absolute inset-x-0 bottom-0 flex justify-between text-[9px] text-white/40">
          <span>{formatDay(series[0]?.date)}</span>
          <span>{formatDay(series[series.length - 1]?.date)}</span>
        </div>
      </div>
    </div>
  );
}

function DayRow({
  day,
  targets,
}: {
  day: DayBucket;
  targets: Stats["targets"];
}) {
  const pct = targets ? Math.round((day.calories / targets.calories) * 100) : null;
  const empty = day.meals === 0;
  return (
    <div className="flex items-center justify-between py-2.5 text-sm">
      <div>
        <div className="font-medium">{formatDay(day.date)}</div>
        <div className="text-[11px] text-white/50">
          {empty
            ? "No meals logged"
            : `${day.meals} meal${day.meals === 1 ? "" : "s"} · P ${day.protein_g}g · F ${day.fat_g}g · C ${day.carbs_g}g`}
        </div>
      </div>
      <div className="text-right">
        <div className="font-semibold">{day.calories}</div>
        <div className="text-[10px] text-white/40">
          kcal{pct !== null ? ` · ${pct}%` : ""}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-white/60">{k}</span>
      <span className="font-medium">{v}</span>
    </div>
  );
}

function formatDay(s?: string): string {
  if (!s) return "";
  try {
    const d = new Date(s + "T00:00:00");
    return d.toLocaleDateString("he-IL", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return s;
  }
}
