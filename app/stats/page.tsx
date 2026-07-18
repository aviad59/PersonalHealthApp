"use client";

import { useEffect, useMemo, useState } from "react";
import { useLang } from "@/components/LangProvider";
import { t, Lang } from "@/lib/i18n";

type Macros = { calories: number; protein_g: number; fat_g: number; carbs_g: number };

type DayBucket = Macros & {
  date: string;
  meals: number;
  trend: Macros;
  goal: Macros | null;
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

const RANGES = [7, 14, 30] as const;

/** Per-metric palette — matches the home dashboard macro rings so visual
 *  identity stays consistent: kcal=green, protein=red, carbs=orange,
 *  fat=blue. `base` is used for today's filled bar; `dim` for past days. */
const METRIC_COLORS = {
  calories: { base: "#10b981", dim: "rgba(16, 185, 129, 0.55)", ring: "rgba(16, 185, 129, 0.45)" },
  protein_g: { base: "#ef4444", dim: "rgba(239, 68, 68, 0.55)", ring: "rgba(239, 68, 68, 0.45)" },
  fat_g: { base: "#3b82f6", dim: "rgba(59, 130, 246, 0.55)", ring: "rgba(59, 130, 246, 0.45)" },
  carbs_g: { base: "#f59e0b", dim: "rgba(245, 158, 11, 0.55)", ring: "rgba(245, 158, 11, 0.45)" },
} as const;
type MetricKey = keyof typeof METRIC_COLORS;

function lsGet<T>(key: string): T | null {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : null; } catch { return null; }
}
function lsSet(key: string, val: unknown) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

/** Local-time YYYY-MM-DD. Matches the server's `todayStr()` from
 *  lib/db.ts for the user's wall-clock day, which is what the stats API
 *  uses to bucket meals. */
function localToday(): string {
  return new Date().toLocaleDateString("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export default function StatsPage() {
  const lang = useLang();
  const [days, setDays] = useState<number>(14);
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [metric, setMetric] = useState<"calories" | "protein_g" | "fat_g" | "carbs_g">("calories");

  useEffect(() => {
    let dead = false;
    setErr(null);

    // Show cached data immediately — but only if it was captured TODAY.
    // Without this guard, opening the page on a fresh day flashes
    // yesterday's series (with yesterday's "today" bar still painted in
    // the rightmost slot) for the duration of the refresh round-trip.
    const today = localToday();
    const cached = lsGet<Stats>(`stats-v2-${days}`);
    const cachedIsToday = cached && cached.today === today;
    if (cachedIsToday) {
      setData(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }

    (async () => {
      try {
        const r = await fetch(`/api/stats?days=${days}`, { cache: "no-store" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "stats failed");
        if (!dead) {
          setData(j);
          lsSet(`stats-v2-${days}`, j);
        }
      } catch (e: any) {
        if (!dead && !cachedIsToday) setErr(e.message);
      } finally {
        if (!dead) setLoading(false);
      }
    })();

    return () => { dead = true; };
  }, [days]);

  const target = data?.targets ? data.targets[metric] : null;
  const max = useMemo(() => {
    if (!data) return 0;
    let m = 0;
    for (const d of data.series) m = Math.max(m, d[metric], d.trend?.[metric] ?? 0);
    if (target) m = Math.max(m, target);
    return m || 1;
  }, [data, metric, target]);

  const metricLabel: Record<typeof metric, string> = {
    calories: t(lang, "macro_calories"),
    protein_g: t(lang, "macro_protein"),
    fat_g: t(lang, "macro_fat"),
    carbs_g: t(lang, "macro_carbs"),
  };
  const metricUnit: Record<typeof metric, string> = {
    calories: t(lang, "macro_kcal"),
    protein_g: "g",
    fat_g: "g",
    carbs_g: "g",
  };

  return (
    <div className="px-5 pt-6 pb-32 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t(lang, "stats_title")}</h1>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setDays(r)}
              className={`text-[11px] rounded-lg px-3 py-1.5 border transition-colors ${
                days === r
                  ? "bg-accent-sec-container text-accent-on-sec-container border-transparent font-medium"
                  : "bg-transparent text-white/70 border-border"
              }`}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="card p-4 text-sm text-red-400">{err}</div>
      )}

      {loading && !data && <StatsSkeleton />}

      {data && (
        <div className={`space-y-5 ${loading ? "animate-pulse [animation-duration:2.5s]" : ""}`}>
          {/* Averages summary */}
          <section className="card p-4">
            <div className="text-[10px] uppercase tracking-wider text-white/50 mb-3">
              {t(lang, "stats_avg_prefix")} {data.days} {t(lang, "stats_days")} · {t(lang, "stats_logged")} {data.daysLogged}/{data.days}
            </div>
            <div className="grid grid-cols-4 gap-3">
              <Stat
                label={t(lang, "macro_kcal")}
                value={data.averages.calories}
                target={data.targets?.calories}
                ofTarget={t(lang, "stats_of_target")}
                metric="calories"
              />
              <Stat
                label={t(lang, "macro_protein")}
                value={data.averages.protein_g}
                unit="g"
                target={data.targets?.protein_g}
                ofTarget={t(lang, "stats_of_target")}
                metric="protein_g"
              />
              <Stat
                label={t(lang, "macro_fat")}
                value={data.averages.fat_g}
                unit="g"
                target={data.targets?.fat_g}
                ofTarget={t(lang, "stats_of_target")}
                metric="fat_g"
              />
              <Stat
                label={t(lang, "macro_carbs")}
                value={data.averages.carbs_g}
                unit="g"
                target={data.targets?.carbs_g}
                ofTarget={t(lang, "stats_of_target")}
                metric="carbs_g"
              />
            </div>
          </section>

          {/* Metric switcher + bar chart */}
          <section className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] uppercase tracking-wider text-white/50">
                {metricLabel[metric]} {t(lang, "stats_per_day")}
              </div>
              <div className="flex gap-1">
                {(["calories", "protein_g", "fat_g", "carbs_g"] as const).map((k) => {
                  const c = METRIC_COLORS[k];
                  const active = metric === k;
                  return (
                    <button
                      key={k}
                      onClick={() => setMetric(k)}
                      className="text-[10px] rounded-full px-2.5 py-1 border transition-colors"
                      style={
                        active
                          ? {
                              backgroundColor: `${c.base}26`,
                              color: c.base,
                              borderColor: c.ring,
                            }
                          : undefined
                      }
                    >
                      <span className={active ? "" : "text-white/60"}>
                        {k === "calories" ? t(lang, "macro_kcal") : k === "protein_g" ? "P" : k === "fat_g" ? "F" : "C"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <BarChart
              series={data.series}
              metric={metric}
              max={max}
              target={target ?? null}
              unit={metricUnit[metric]}
              lang={lang}
            />
          </section>

          {/* Highlights + Daily breakdown */}
          <div className="space-y-5 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-5 lg:items-start">
            {/* Highlights */}
            <section className="card p-4 space-y-3">
              <div className="text-[10px] uppercase tracking-wider text-white/50">{t(lang, "stats_highlights")}</div>
              {data.proteinHitRate !== null && (
                <Row
                  k={t(lang, "stats_protein_hit")}
                  v={`${data.proteinHitRate}%`}
                />
              )}
              {data.bestProtein && (
                <Row
                  k={t(lang, "stats_top_protein")}
                  v={`${formatDay(data.bestProtein.date, lang)} · ${data.bestProtein.protein_g}g`}
                />
              )}
              {data.highestCal && (
                <Row
                  k={t(lang, "stats_highest_cal")}
                  v={`${formatDay(data.highestCal.date, lang)} · ${data.highestCal.calories} ${t(lang, "macro_kcal")}`}
                />
              )}
              <Row k={t(lang, "stats_total_kcal")} v={`${data.totals.calories.toLocaleString()}`} />
              <Row k={t(lang, "stats_total_protein")} v={`${data.totals.protein_g} g`} />
            </section>

            {/* Daily breakdown */}
            <section className="card p-4">
              <div className="text-[10px] uppercase tracking-wider text-white/50 mb-3">
                {t(lang, "stats_breakdown")}
              </div>
              <div className="divide-y divide-border">
                {[...data.series].reverse().map((d) => (
                  <DayRow key={d.date} day={d} targets={data.targets} lang={lang} />
                ))}
              </div>
            </section>
          </div>
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

// Protein targets are a floor — hitting or exceeding it is good, and there's
// no real downside to going over. Calories/fat/carbs are targets to stay
// close to in either direction, so running well over isn't "good" either.
function pctColor(pct: number, metric: "calories" | "protein_g" | "fat_g" | "carbs_g") {
  if (metric === "protein_g") {
    if (pct >= 95) return "text-green-400";
    if (pct < 90) return "text-amber-400";
    return "text-white/50";
  }
  if (pct >= 90 && pct <= 105) return "text-green-400";
  if (pct < 85 || pct > 115) return "text-amber-400";
  return "text-white/50";
}

function Stat({
  label,
  value,
  unit,
  target,
  ofTarget,
  metric,
}: {
  label: string;
  value: number;
  unit?: string;
  target?: number;
  ofTarget: string;
  metric: "calories" | "protein_g" | "fat_g" | "carbs_g";
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
        <div className={`text-[10px] mt-0.5 ${pctColor(pct, metric)}`}>
          {pct}% {ofTarget}
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
  lang,
}: {
  series: DayBucket[];
  metric: "calories" | "protein_g" | "fat_g" | "carbs_g";
  max: number;
  target: number | null;
  unit: string;
  lang: Lang;
}) {
  // Render up to ~30 bars. Container height ~120px.
  const HEIGHT = 120;
  const [selected, setSelected] = useState<string | null>(null);

  // Clear the selection when the date range changes (new series).
  useEffect(() => {
    setSelected(null);
  }, [series]);

  const selectedDay = series.find((d) => d.date === selected) ?? null;

  return (
    <div>
      {/* Tapped-day readout */}
      <div className="h-6 mb-1 flex items-center justify-center">
        {selectedDay && (
          <span className="text-[11px] text-white bg-bg-elev border border-accent-brand/40 rounded-full px-2.5 py-0.5">
            {formatDay(selectedDay.date, lang)} · {selectedDay[metric]} {unit}
            {selectedDay.meals === 0 ? ` · ${t(lang, "stats_no_meals")}` : ""}
            {selectedDay.trend ? ` · ${t(lang, "stats_trend_avg")} ${selectedDay.trend[metric]}` : ""}
          </span>
        )}
      </div>
      <div className="relative" style={{ height: HEIGHT + 16 }}>
        {/* Per-day target line — steps whenever the goal changed, so a day
            is shown against the goal that was in effect then. */}
        {(() => {
          const n = series.length;
          if (n === 0) return null;
          let d = "";
          let penUp = true;
          series.forEach((day, i) => {
            const g = day.goal?.[metric];
            if (g == null) { penUp = true; return; }
            const x0 = (i / n) * 100;
            const x1 = ((i + 1) / n) * 100;
            const y = 100 - (g / max) * 100;
            d += `${penUp ? "M" : "L"} ${x0} ${y} L ${x1} ${y} `;
            penUp = false;
          });
          const latest = [...series].reverse().find((s) => s.goal?.[metric] != null)?.goal?.[metric];
          return (
            <>
              <svg
                className="absolute inset-x-0 top-0 w-full pointer-events-none"
                style={{ height: HEIGHT }}
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                <path d={d} fill="none" stroke="var(--primary)" strokeOpacity={0.55} strokeWidth={1.2} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
              </svg>
              {latest != null && (
                <span className="absolute right-0 text-[9px] text-accent-primary/80" style={{ top: HEIGHT - (latest / max) * HEIGHT - 12 }}>
                  target {latest}
                </span>
              )}
            </>
          );
        })()}
        <div className="absolute inset-x-0 bottom-4 flex items-end gap-[2px] h-[120px]">
          {series.map((d) => {
            const v = d[metric];
            const h = Math.max(2, (v / max) * HEIGHT);
            const isToday = d.date === series[series.length - 1].date;
            const empty = d.meals === 0;
            const isSelected = selected === d.date;
            const c = METRIC_COLORS[metric];
            // Today's bar gets a diagonal-stripe overlay + a thin dashed
            // ring so the still-unfolding day reads visually different from
            // historical days, even when the macro tally is low.
            const barStyle: React.CSSProperties = isSelected
              ? { height: h, background: "#fff" }
              : empty
              ? { height: h, background: "rgba(255,255,255,0.1)" }
              : isToday
              ? {
                  height: h,
                  background: `repeating-linear-gradient(135deg, ${c.base} 0 4px, ${c.base}99 4px 8px)`,
                  boxShadow: `inset 0 0 0 1px ${c.ring}`,
                }
              : { height: h, background: c.dim };
            return (
              <div
                key={d.date}
                className="flex-1 h-full flex items-end cursor-pointer"
                onClick={() => setSelected((prev: string | null) => (prev === d.date ? null : d.date))}
              >
                <div
                  className="w-full rounded-t-sm transition-[height,background] duration-300"
                  style={barStyle}
                />
              </div>
            );
          })}
        </div>
        {/* 7-day rolling average trend line */}
        <svg
          className="absolute inset-x-0 bottom-4 w-full h-[120px] pointer-events-none"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <polyline
            points={series
              .map((d, i) => {
                const x = ((i + 0.5) / series.length) * 100;
                const y = 100 - ((d.trend?.[metric] ?? 0) / max) * 100;
                return `${x},${y}`;
              })
              .join(" ")}
            fill="none"
            stroke="#f5a623"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="absolute inset-x-0 bottom-0 flex justify-between text-[9px] text-white/40">
          <span>{formatDay(series[0]?.date, lang)}</span>
          <span>{formatDay(series[series.length - 1]?.date, lang)}</span>
        </div>
      </div>
      {/* Legend for the trend line */}
      <div className="flex items-center justify-end gap-1.5 mt-1.5 text-[9px] text-white/40">
        <span className="inline-block w-3 h-[2px] rounded-full bg-[#f5a623]" />
        {t(lang, "stats_trend_avg")}
      </div>
    </div>
  );
}

function DayRow({
  day,
  targets,
  lang,
}: {
  day: DayBucket;
  targets: Stats["targets"];
  lang: Lang;
}) {
  // % against the calorie goal that was in effect on that specific day.
  const dayGoalCal = day.goal?.calories ?? targets?.calories ?? null;
  const pct = dayGoalCal ? Math.round((day.calories / dayGoalCal) * 100) : null;
  const empty = day.meals === 0;
  return (
    <div className="flex items-center justify-between py-2.5 text-sm">
      <div>
        <div className="font-medium">{formatDay(day.date, lang)}</div>
        <div className="text-[11px] text-white/50">
          {empty
            ? t(lang, "stats_no_meals")
            : `${day.meals} meal${day.meals === 1 ? "" : "s"} · P ${day.protein_g}g · F ${day.fat_g}g · C ${day.carbs_g}g`}
        </div>
      </div>
      <div className="text-right">
        <div className="font-semibold">{day.calories}</div>
        <div className="text-[10px] text-white/40">
          {t(lang, "macro_kcal")}{pct !== null ? ` · ${pct}%` : ""}
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

function formatDay(s: string | undefined, lang: Lang): string {
  if (!s) return "";
  try {
    const d = new Date(s + "T00:00:00");
    return d.toLocaleDateString(lang === "he" ? "he-IL" : undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return s;
  }
}
