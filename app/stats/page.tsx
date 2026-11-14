"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  /** Window (in days) behind the rolling-average line; scales with `days`. */
  trendWindow?: number;
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
const METRICS: MetricKey[] = ["calories", "protein_g", "fat_g", "carbs_g"];

// The rolling average is drawn in a neutral tone: an orange line (the old
// choice) vanished against the carbs bars, which are the same orange.
const TREND_STROKE = "rgba(255,255,255,0.85)";

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

function metricLabel(lang: Lang, k: MetricKey): string {
  return t(lang, k === "calories" ? "macro_calories" : k === "protein_g" ? "macro_protein" : k === "fat_g" ? "macro_fat" : "macro_carbs");
}
function metricUnit(lang: Lang, k: MetricKey): string {
  return k === "calories" ? t(lang, "macro_kcal") : "g";
}

export default function StatsPage() {
  const lang = useLang();
  const [days, setDays] = useState<number>(14);
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [metric, setMetric] = useState<MetricKey>("calories");
  // The chart's tapped day. Lifted here so highlight tiles can jump to a day.
  const [selected, setSelected] = useState<string | null>(null);
  const chartRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let dead = false;
    setErr(null);

    // Show cached data immediately — but only if it was captured TODAY.
    // Without this guard, opening the page on a fresh day flashes
    // yesterday's series (with yesterday's "today" bar still painted in
    // the rightmost slot) for the duration of the refresh round-trip.
    const today = localToday();
    const cached = lsGet<Stats>(`stats-v3-${days}`);
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
          lsSet(`stats-v3-${days}`, j);
        }
      } catch (e: any) {
        if (!dead && !cachedIsToday) setErr(e.message);
      } finally {
        if (!dead) setLoading(false);
      }
    })();

    return () => { dead = true; };
  }, [days]);

  // A new range is a different series — the old selection may not exist.
  useEffect(() => {
    setSelected(null);
  }, [days]);

  const target = data?.targets ? data.targets[metric] : null;
  const max = useMemo(() => {
    if (!data) return 0;
    let m = 0;
    for (const d of data.series) m = Math.max(m, d[metric], d.trend?.[metric] ?? 0, d.goal?.[metric] ?? 0);
    if (target) m = Math.max(m, target);
    return m || 1;
  }, [data, metric, target]);

  /** Highlight tile → show that day for that metric in the chart. */
  function jumpTo(day: string, k: MetricKey) {
    setMetric(k);
    setSelected(day);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    chartRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  }

  return (
    <div className="px-5 pt-6 pb-32 space-y-6 md:max-w-3xl md:mx-auto">
      <header className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold">{t(lang, "stats_title")}</h1>
          <p className="text-sm text-white/60 mt-1 nums">
            {data
              ? t(lang, "stats_subtitle")
                  .replace("{n}", String(data.daysLogged))
                  .replace("{d}", String(data.days))
              : " "}
          </p>
        </div>
        <Segmented
          label={t(lang, "stats_range_label")}
          options={RANGES.map((r) => ({ value: r, label: t(lang, "stats_days_n").replace("{n}", String(r)) }))}
          value={days}
          onChange={setDays}
        />
      </header>

      {err && (
        <div className="card p-4 text-sm text-red-400" role="alert">{err}</div>
      )}

      {loading && !data && <StatsSkeleton />}

      {data && (
        <div className={`space-y-6 ${loading ? "animate-pulse [animation-duration:2.5s]" : ""}`}>
          {/* Daily averages vs target — tapping a tile charts that metric */}
          <section className="space-y-2.5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              {t(lang, "stats_avg_title")}
            </h2>
            <div className="grid grid-cols-2 gap-3">
              {METRICS.map((k) => (
                <AverageTile
                  key={k}
                  metric={k}
                  lang={lang}
                  value={data.averages[k]}
                  target={data.targets?.[k] ?? null}
                  active={metric === k}
                  onSelect={() => setMetric(k)}
                />
              ))}
            </div>
            {!data.targets && (
              <p className="text-[12px] text-white/45">{t(lang, "stats_no_target")}</p>
            )}
          </section>

          {/* Per-day chart */}
          <section ref={chartRef} className="card p-4 space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              {metricLabel(lang, metric)} {t(lang, "stats_per_day")}
            </h2>
            <Segmented
              label={t(lang, "stats_metric_label")}
              size="sm"
              options={METRICS.map((k) => ({
                value: k,
                label: k === "calories" ? t(lang, "macro_kcal") : metricLabel(lang, k),
                color: METRIC_COLORS[k].base,
              }))}
              value={metric}
              onChange={setMetric}
            />
            <BarChart
              series={data.series}
              metric={metric}
              max={max}
              unit={metricUnit(lang, metric)}
              lang={lang}
              trendWindow={data.trendWindow ?? Math.max(2, Math.round(data.days / 2))}
              selected={selected}
              onSelect={setSelected}
            />
          </section>

          {/* Highlights + Daily breakdown */}
          <div className="space-y-6 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-5 lg:items-start">
            <section className="space-y-2.5">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
                {t(lang, "stats_highlights")}
              </h2>
              <div className="grid grid-cols-2 gap-3">
                {data.proteinHitRate !== null && (
                  <HighlightTile
                    label={t(lang, "stats_protein_hit")}
                    value={`${data.proteinHitRate}%`}
                    meter={{ pct: data.proteinHitRate, color: METRIC_COLORS.protein_g.base }}
                  />
                )}
                {data.bestProtein && (
                  <HighlightTile
                    label={t(lang, "stats_top_protein")}
                    value={`${data.bestProtein.protein_g}g`}
                    sub={formatDay(data.bestProtein.date, lang)}
                    accent={METRIC_COLORS.protein_g.base}
                    onClick={() => jumpTo(data.bestProtein!.date, "protein_g")}
                  />
                )}
                {data.highestCal && (
                  <HighlightTile
                    label={t(lang, "stats_highest_cal")}
                    value={`${data.highestCal.calories.toLocaleString()}`}
                    unit={t(lang, "macro_kcal")}
                    sub={formatDay(data.highestCal.date, lang)}
                    accent={METRIC_COLORS.calories.base}
                    onClick={() => jumpTo(data.highestCal!.date, "calories")}
                  />
                )}
                <HighlightTile
                  label={t(lang, "stats_totals")}
                  value={data.totals.calories.toLocaleString()}
                  unit={t(lang, "macro_kcal")}
                  sub={`${data.totals.protein_g.toLocaleString()}g ${t(lang, "macro_protein")}`}
                />
              </div>
            </section>

            <section className="space-y-2.5">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
                {t(lang, "stats_breakdown")}
              </h2>
              <div className="card px-4 divide-y divide-border">
                {[...data.series].reverse().map((d) => (
                  <DayRow
                    key={d.date}
                    day={d}
                    targets={data.targets}
                    lang={lang}
                    isToday={d.date === data.today}
                  />
                ))}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

/** Full-width segmented control (M3 style). Each segment is ≥40px tall with
 *  the container padding bringing the touch row to Android's 48dp. */
function Segmented<V extends string | number>({
  label,
  options,
  value,
  onChange,
  size = "md",
}: {
  label: string;
  options: { value: V; label: string; color?: string }[];
  value: V;
  onChange: (v: V) => void;
  size?: "sm" | "md";
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid gap-1 rounded-full bg-bg-elev border border-border p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`rounded-full ${size === "sm" ? "h-9 text-[12px]" : "h-10 text-[13px]"} font-medium truncate px-2 transition-colors duration-150 ${
              active
                ? "bg-accent-sec-container text-accent-on-sec-container"
                : "text-white/65 hover:text-white"
            }`}
          >
            {o.color && (
              <span
                aria-hidden
                className="inline-block w-2 h-2 rounded-full me-1.5 align-middle"
                style={{ background: o.color, opacity: active ? 1 : 0.6 }}
              />
            )}
            <span className="align-middle">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-hidden>
      <div className="grid grid-cols-2 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card p-3.5 space-y-2.5">
            <div className="h-3 w-16 rounded bg-white/10" />
            <div className="h-6 w-20 rounded bg-white/15" />
            <div className="h-1.5 w-full rounded-full bg-white/10" />
            <div className="h-2.5 w-24 rounded bg-white/10" />
          </div>
        ))}
      </div>
      <section className="card p-4">
        <div className="h-3 w-32 rounded bg-white/10 mb-4" />
        <div className="h-9 w-full rounded-full bg-white/10 mb-4" />
        <div className="flex items-end gap-[3px] h-[160px]">
          {Array.from({ length: 14 }).map((_, i) => (
            <div
              key={i}
              className="flex-1 rounded-t bg-white/10"
              style={{ height: `${30 + ((i * 7) % 70)}%` }}
            />
          ))}
        </div>
      </section>
      <section className="card p-4 space-y-3">
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

type Status = { tone: "good" | "ok" | "bad"; label: "on" | "under" | "over" };

// Protein targets are a floor — hitting or exceeding it is good, and there's
// no real downside to going over. Calories/fat/carbs are targets to stay
// close to in either direction, so running well over isn't "good" either.
// Green = on target, amber = somewhat off, red = far off — always paired with
// a text label, so the status never rests on color alone.
function targetStatus(pct: number, metric: MetricKey): Status {
  if (metric === "protein_g") {
    if (pct >= 95) return { tone: "good", label: "on" };
    return { tone: pct >= 80 ? "ok" : "bad", label: "under" };
  }
  // Calories get a tighter tolerance than fat/carbs, which swing more.
  const off = Math.abs(pct - 100);
  const tol = metric === "calories" ? { good: 10, ok: 20 } : { good: 15, ok: 30 };
  if (off <= tol.good) return { tone: "good", label: "on" };
  return { tone: off <= tol.ok ? "ok" : "bad", label: pct < 100 ? "under" : "over" };
}

const TONE_TEXT = { good: "text-green-400", ok: "text-amber-400", bad: "text-red-400" } as const;
const TONE_CHIP = {
  good: "text-green-300 bg-green-400/10 border-green-400/30",
  ok: "text-amber-300 bg-amber-400/10 border-amber-400/30",
  bad: "text-red-300 bg-red-400/10 border-red-400/30",
} as const;

/** One daily-average KPI as a bullet chart: the bar spans 0–150% of target,
 *  with a tick at the target itself. */
function AverageTile({
  metric,
  lang,
  value,
  target,
  active,
  onSelect,
}: {
  metric: MetricKey;
  lang: Lang;
  value: number;
  target: number | null;
  active: boolean;
  onSelect: () => void;
}) {
  const c = METRIC_COLORS[metric];
  const pct = target ? Math.round((value / target) * 100) : null;
  const status = pct !== null ? targetStatus(pct, metric) : null;
  const SCALE = 150;
  const fill = pct !== null ? Math.min(pct, SCALE) / SCALE : 0;
  const unit = metricUnit(lang, metric);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`card p-3.5 text-start space-y-2 transition-colors duration-150 ${active ? "" : "hover:border-white/20"}`}
      style={active ? { borderColor: c.ring, boxShadow: `inset 0 0 0 1px ${c.ring}` } : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-white/70 min-w-0">
          <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: c.base }} />
          <span className="truncate">{metricLabel(lang, metric)}</span>
        </span>
        {status && (
          <span className={`shrink-0 text-[10px] font-medium rounded-full border px-1.5 py-0.5 ${TONE_CHIP[status.tone]}`}>
            {t(lang, status.label === "on" ? "stats_status_on" : status.label === "under" ? "stats_status_under" : "stats_status_over")}
          </span>
        )}
      </div>
      <div className="nums">
        <span className="text-2xl font-bold">{value.toLocaleString()}</span>
        <span className="text-xs text-white/50 ms-1">{unit}</span>
      </div>
      {pct !== null && target !== null ? (
        <>
          <div className="relative h-1.5 rounded-full bg-white/10" dir="ltr" aria-hidden>
            <div
              className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${fill * 100}%`, background: c.base }}
            />
            <div
              className="absolute -top-1 -bottom-1 w-[2px] rounded-full bg-white/80"
              style={{ left: `${(100 / SCALE) * 100}%` }}
            />
          </div>
          <div className="text-[11px] text-white/50 nums">
            <span className={TONE_TEXT[status!.tone]}>{pct}%</span> {t(lang, "stats_of_target")}{" "}
            {target.toLocaleString()}
            {metric === "calories" ? "" : "g"}
          </div>
        </>
      ) : (
        <div className="text-[11px] text-white/40">{t(lang, "stats_per_day")}</div>
      )}
    </button>
  );
}

function HighlightTile({
  label,
  value,
  unit,
  sub,
  accent,
  meter,
  onClick,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  accent?: string;
  meter?: { pct: number; color: string };
  /** When set, the tile is a button (jumps the chart to that day). */
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="text-[12px] text-white/60 leading-snug">{label}</div>
      <div className="nums mt-1.5">
        <span className="text-xl font-bold" style={accent ? { color: accent } : undefined}>{value}</span>
        {unit && <span className="text-xs text-white/50 ms-1">{unit}</span>}
      </div>
      {meter && (
        <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden" dir="ltr" aria-hidden>
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, meter.pct)}%`, background: meter.color }} />
        </div>
      )}
      {sub && (
        <div className="text-[11px] text-white/50 mt-1 flex items-center gap-1">
          <span className="truncate">{sub}</span>
          {onClick && (
            <svg aria-hidden viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-white/40 rtl:-scale-x-100" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m9 18 6-6-6-6" />
            </svg>
          )}
        </div>
      )}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="card p-3.5 text-start hover:border-white/20 transition-colors duration-150">
      {body}
    </button>
  ) : (
    <div className="card p-3.5">{body}</div>
  );
}

function BarChart({
  series,
  metric,
  max,
  unit,
  lang,
  trendWindow,
  selected,
  onSelect,
}: {
  series: DayBucket[];
  metric: MetricKey;
  max: number;
  unit: string;
  lang: Lang;
  trendWindow: number;
  selected: string | null;
  onSelect: (d: string | null) => void;
}) {
  const HEIGHT = 160;
  // "{n}-day avg" — the window scales with the selected range.
  const trendLabel = t(lang, "stats_trend_avg").replace("{n}", String(trendWindow));
  const selectedDay = series.find((d) => d.date === selected) ?? null;
  const c = METRIC_COLORS[metric];
  const n = series.length;

  // Per-day target line — steps whenever the goal changed, so a day is
  // shown against the goal that was in effect then.
  let goalPath = "";
  let penUp = true;
  series.forEach((day, i) => {
    const g = day.goal?.[metric];
    if (g == null) { penUp = true; return; }
    const y = 100 - (g / max) * 100;
    goalPath += `${penUp ? "M" : "L"} ${(i / n) * 100} ${y} L ${((i + 1) / n) * 100} ${y} `;
    penUp = false;
  });
  const latestGoal = [...series].reverse().find((s) => s.goal?.[metric] != null)?.goal?.[metric];

  const trendPoints = series
    .map((d, i) => `${((i + 0.5) / n) * 100},${100 - ((d.trend?.[metric] ?? 0) / max) * 100}`)
    .join(" ");

  const mid = n > 2 ? series[Math.floor((n - 1) / 2)] : null;

  return (
    <div>
      {/* Tapped-day readout — fixed height so the chart never jumps. */}
      <div className="min-h-[52px] rounded-xl bg-bg-elev border border-border px-3 py-2 mb-3 flex items-center" aria-live="polite">
        {selectedDay ? (
          <div className="flex-1 min-w-0 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[12px] text-white/60 truncate">{formatDay(selectedDay.date, lang)}</div>
              <div className="nums">
                <span className="text-lg font-bold" style={{ color: c.base }}>{selectedDay[metric].toLocaleString()}</span>
                <span className="text-xs text-white/50 ms-1">{unit}</span>
              </div>
            </div>
            <div className="text-end text-[11px] text-white/55 nums leading-relaxed">
              {selectedDay.meals === 0 ? (
                <div>{t(lang, "stats_no_meals")}</div>
              ) : (
                <div>{mealsLabel(lang, selectedDay.meals)}</div>
              )}
              {selectedDay.goal?.[metric] != null && (
                <div>{t(lang, "stats_legend_target")} {selectedDay.goal[metric].toLocaleString()}</div>
              )}
              <div>{trendLabel} {selectedDay.trend[metric].toLocaleString()}</div>
            </div>
            <button
              type="button"
              onClick={() => onSelect(null)}
              aria-label={t(lang, "stats_clear_selection")}
              className="shrink-0 -me-1 w-9 h-9 rounded-full text-white/50 hover:text-white flex items-center justify-center"
            >
              ×
            </button>
          </div>
        ) : (
          <div className="text-[12px] text-white/45">{t(lang, "stats_tap_hint")}</div>
        )}
      </div>

      {/* Time runs left→right in both languages: the SVG overlays are drawn
          in LTR coordinates, so the bar row must not flip under dir=rtl. */}
      <div dir="ltr">
        <div className="relative" style={{ height: HEIGHT }}>
          {/* Gridlines at half and full scale */}
          {[0.5, 1].map((f) => (
            <div
              key={f}
              aria-hidden
              className="absolute inset-x-0 border-t border-white/[0.06]"
              style={{ top: HEIGHT - f * HEIGHT }}
            />
          ))}
          <span aria-hidden className="absolute left-0 -top-0.5 text-[10px] text-white/35 nums">
            {Math.round(max).toLocaleString()}
          </span>

          {/* Bars — each column is a button covering the full height */}
          <div className="absolute inset-0 flex items-end gap-[3px]">
            {series.map((d, i) => {
              const v = d[metric];
              const h = Math.max(2, (v / max) * HEIGHT);
              const isToday = i === n - 1;
              const empty = d.meals === 0;
              const isSelected = selected === d.date;
              // Today's bar is striped so the still-unfolding day reads
              // differently from finished days, even when its tally is low.
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
                <button
                  key={d.date}
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`${formatDay(d.date, lang)}: ${v.toLocaleString()} ${unit}`}
                  onClick={() => onSelect(isSelected ? null : d.date)}
                  className="group flex-1 h-full flex items-end rounded-t-[5px] focus-visible:outline-offset-0 [touch-action:manipulation]"
                >
                  <span
                    className={`block w-full rounded-t-[5px] transition-[height,background] duration-300 motion-reduce:transition-none ${
                      isSelected ? "" : "group-hover:brightness-125"
                    } ${selected && !isSelected ? "opacity-50" : ""}`}
                    style={barStyle}
                  />
                </button>
              );
            })}
          </div>

          {/* Target (dashed, stepped) + rolling average (solid) */}
          <svg
            aria-hidden
            className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {goalPath && (
              <path d={goalPath} fill="none" stroke="var(--primary)" strokeOpacity={0.75} strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
            )}
            <polyline
              points={trendPoints}
              fill="none"
              stroke="rgba(0,0,0,0.45)"
              strokeWidth={4}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            <polyline
              points={trendPoints}
              fill="none"
              stroke={TREND_STROKE}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {latestGoal != null && (
            <span
              aria-hidden
              className="absolute right-0 text-[10px] font-medium text-accent-primary nums bg-bg-card/80 rounded px-1"
              style={{ top: Math.max(0, HEIGHT - (latestGoal / max) * HEIGHT - 16) }}
            >
              {latestGoal.toLocaleString()}
            </span>
          )}
        </div>

        {/* X axis: first, middle, last day */}
        <div className="relative h-5 mt-1.5 text-[10px] text-white/45" aria-hidden>
          <span className="absolute left-0">{formatShort(series[0]?.date, lang)}</span>
          {mid && (
            <span className="absolute -translate-x-1/2" style={{ left: `${((Math.floor((n - 1) / 2) + 0.5) / n) * 100}%` }}>
              {formatShort(mid.date, lang)}
            </span>
          )}
          <span className="absolute right-0">{formatShort(series[n - 1]?.date, lang)}</span>
        </div>
      </div>

      {/* Legend — line styles differ, so it doesn't rely on color alone */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-white/55">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: c.dim }} />
          {t(lang, "stats_legend_daily")}
        </span>
        <span className="flex items-center gap-1.5">
          <svg aria-hidden width="16" height="4" viewBox="0 0 16 4"><line x1="0" y1="2" x2="16" y2="2" stroke="var(--primary)" strokeWidth="1.5" strokeDasharray="4 3" /></svg>
          {t(lang, "stats_legend_target")}
        </span>
        <span className="flex items-center gap-1.5">
          <svg aria-hidden width="16" height="4" viewBox="0 0 16 4"><line x1="0" y1="2" x2="16" y2="2" stroke={TREND_STROKE} strokeWidth="2" strokeLinecap="round" /></svg>
          {trendLabel}
        </span>
      </div>
    </div>
  );
}

function DayRow({
  day,
  targets,
  lang,
  isToday,
}: {
  day: DayBucket;
  targets: Stats["targets"];
  lang: Lang;
  isToday: boolean;
}) {
  // % against the calorie goal that was in effect on that specific day.
  const dayGoalCal = day.goal?.calories ?? targets?.calories ?? null;
  const pct = dayGoalCal ? Math.round((day.calories / dayGoalCal) * 100) : null;
  const empty = day.meals === 0;
  return (
    <div className={`py-3 ${empty ? "opacity-55" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium flex items-center gap-2">
            <span className="truncate">{formatDay(day.date, lang)}</span>
            {isToday && (
              <span className="text-[10px] font-medium rounded-full px-1.5 py-0.5 bg-accent-sec-container text-accent-on-sec-container">
                {t(lang, "meal_today_btn")}
              </span>
            )}
          </div>
          <div className="text-[12px] text-white/55 mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 nums">
            {empty ? (
              t(lang, "stats_no_meals")
            ) : (
              <>
                <span>{mealsLabel(lang, day.meals)}</span>
                {(["protein_g", "fat_g", "carbs_g"] as const).map((k) => (
                  <span key={k} className="flex items-center gap-1">
                    <span aria-hidden className="w-1.5 h-1.5 rounded-full" style={{ background: METRIC_COLORS[k].base }} />
                    {k === "protein_g" ? "P" : k === "fat_g" ? "F" : "C"} {day[k]}g
                  </span>
                ))}
              </>
            )}
          </div>
        </div>
        <div className="text-end shrink-0 nums">
          <div className="text-sm font-semibold">
            {day.calories.toLocaleString()}
            <span className="text-[11px] font-normal text-white/45 ms-1">{t(lang, "macro_kcal")}</span>
          </div>
          {pct !== null && !empty && (
            <div className={`text-[11px] ${TONE_TEXT[targetStatus(pct, "calories").tone]}`}>{pct}%</div>
          )}
        </div>
      </div>
      {pct !== null && !empty && (
        <div className="mt-2 h-1 rounded-full bg-white/[0.07] overflow-hidden" dir="ltr" aria-hidden>
          <div
            className="h-full rounded-full"
            style={{ width: `${Math.min(100, pct)}%`, background: METRIC_COLORS.calories.dim }}
          />
        </div>
      )}
    </div>
  );
}

function mealsLabel(lang: Lang, n: number): string {
  return n === 1 ? t(lang, "stats_meals_one") : t(lang, "stats_meals_n").replace("{n}", String(n));
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

/** Compact axis label: day + month, no weekday. */
function formatShort(s: string | undefined, lang: Lang): string {
  if (!s) return "";
  try {
    return new Date(s + "T00:00:00").toLocaleDateString(lang === "he" ? "he-IL" : undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return s;
  }
}
