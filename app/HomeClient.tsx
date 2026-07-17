"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import MacroRing from "@/components/MacroRing";
import InsightCard from "@/components/InsightCard";
import { useLang } from "@/components/LangProvider";
import { t, Lang } from "@/lib/i18n";

type MuscleStatus = {
  muscle: string;
  daysSince: number | null;
  readiness: "rest" | "cautious" | "ready";
};

type Recovery = {
  score: number;
  band: "low" | "moderate" | "good" | "high";
  proteinAdherencePct: number;
  calorieDeviationPct: number;
  backToBackSessions: boolean;
  avgRpeLast3Days: number | null;
  byMuscle: MuscleStatus[];
  rationale: string;
  signalsUsed: {
    protein: boolean;
    calories: boolean;
    workouts: boolean;
    sleep: boolean;
    rpe: boolean;
  };
};

export type Today = {
  date: string;
  profile: any | null;
  totals: { calories: number; protein_g: number; fat_g: number; carbs_g: number };
  targets: {
    base_calories: number;
    training_burn_kcal: number;
    effective_calories: number;
    protein_g: number;
    fat_g: number;
    carbs_g: number;
  };
  meals: any[];
  latestInsight: {
    id: number;
    type: "daily" | "weekly";
    headline: string;
    body: string;
    created_at: string;
    tags: string[];
  } | null;
};

type Training = {
  todaysWorkout: {
    id: string;
    title: string;
    volume_kg: number;
    start_time: string;
    duration_min: number;
    burn_kcal: number;
    burn_reason: string;
  } | null;
  training_burn_kcal: number;
  recovery: Recovery | null;
  week: {
    starts_on: string;
    completed: number;
    target: number;
    pace: "behind" | "on" | "ahead";
  } | null;
};

function lsGet<T>(key: string): T | null {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : null; } catch { return null; }
}
function lsSet(key: string, val: unknown) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

/** Local-time YYYY-MM-DD — matches lib/db.ts `todayStr()` for the wall-clock
 *  day, used to invalidate the home snapshot when the user opens the app on
 *  a new day. */
function localToday(): string {
  return new Date().toLocaleDateString("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

const HOME_CACHE_KEY = "home-today-v1";
const HOME_TRAINING_KEY = "home-training-v1";

export default function HomeClient({
  hasWorkouts,
  userDisplayName,
}: {
  hasWorkouts: boolean;
  userDisplayName: string;
}) {
  const lang = useLang();
  const [data, setData] = useState<Today | null>(null);
  const [training, setTraining] = useState<Training | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  async function generateInsight() {
    if (generating) return;
    setGenerating(true);
    try {
      const r = await fetch("/api/insights/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "daily" }),
      });
      const j = await r.json();
      if (r.ok && j.insight) {
        setData((d) =>
          d
            ? {
                ...d,
                latestInsight: {
                  id: j.insight.id,
                  type: (j.insight.type as "daily" | "weekly") ?? "daily",
                  headline: j.insight.headline,
                  body: j.insight.body,
                  created_at: j.insight.created_at ?? new Date().toISOString(),
                  tags: j.insight.tags ?? [],
                },
              }
            : d,
        );
      }
    } catch {
      // non-fatal
    } finally {
      setGenerating(false);
    }
  }

  useEffect(() => {
    // Hydrate from the previous session's snapshot immediately so the
    // page paints with real-looking content on click instead of a blank
    // skeleton, then quietly refresh from the API in the background.
    // The snapshot is only reused when it was captured on the same
    // calendar day — otherwise yesterday's macros/meals would flash on
    // screen and make it look like today's totals were carried over.
    const today = localToday();
    const cachedToday = lsGet<Today>(HOME_CACHE_KEY);
    if (cachedToday && cachedToday.date === today) {
      setData(cachedToday);
      setLoading(false);
    }
    if (hasWorkouts) {
      const cachedTraining = lsGet<Training>(HOME_TRAINING_KEY);
      if (cachedTraining) setTraining(cachedTraining);
    }

    (async () => {
      try {
        const r = await fetch("/api/today", { cache: "no-store" });
        const j = await r.json();
        if (j && !j.error) {
          setData(j);
          lsSet(HOME_CACHE_KEY, j);
        }
      } catch {
        // non-fatal — cached data (if any) stays on screen
      } finally {
        setLoading(false);
      }
    })();

    if (hasWorkouts) {
      (async () => {
        try {
          // Show cached training immediately from the panel above, then:
          // 1) GET /api/workouts warms the workout cache and auto-syncs
          //    from Hevy if it's >10min stale (cheap when fresh) — this is
          //    the "auto-sync on open" so the Workouts tab isn't needed.
          // 2) Re-read /api/today/training so the week counter + recovery
          //    reflect the freshly-synced sessions.
          await fetch("/api/workouts", { cache: "no-store" }).catch(() => {});
          const r = await fetch("/api/today/training", { cache: "no-store" });
          const j = await r.json();
          setTraining(j);
          lsSet(HOME_TRAINING_KEY, j);
        } catch {
          // non-fatal
        }
      })();
    }
  }, [hasWorkouts]);

  if (err) return <div className="p-6 text-red-400">{err}</div>;

  // First-ever visit (or cleared storage): show a quick skeleton while
  // /api/today resolves, instead of flashing the onboarding CTA.
  if (!data) return <HomeSkeleton />;

  if (!data.profile) {
    return (
      <div className="px-5 pt-10 space-y-4">
        <h1 className="text-3xl font-bold">{t(lang, "home_welcome")}</h1>
        <p className="text-white/60">{t(lang, "home_onboarding_desc")}</p>
        <Link href="/onboarding" className="inline-block rounded-full bg-accent-brand px-5 py-3 text-sm font-semibold">
          {t(lang, "home_start_onboarding")}
        </Link>
      </div>
    );
  }

  const { totals, profile, meals, latestInsight, targets } = data;
  const recovery = training?.recovery ?? null;
  const today = new Date(data.date);
  const burn = training?.training_burn_kcal ?? 0;
  const baseCal = targets.base_calories;
  const effectiveCal = baseCal + burn;

  return (
    <div className={`px-5 pt-6 pb-6 space-y-5 ${loading ? "animate-pulse [animation-duration:2.5s]" : ""}`}>
      {/* Branded top header — gradient rounded-bottom rectangle with the app
          logo, a profile avatar, and a greeting (inspired by the reference). */}
      <div className="-mx-5 -mt-6 px-5 pt-7 pb-6 rounded-b-[28px] bg-gradient-to-br from-[#12b0f0] via-[#0b82b6] to-[#0a4e6d] relative overflow-hidden shadow-[0_10px_30px_-12px_rgba(14,165,233,0.5)]">
        {/* soft decorative glow, top-right */}
        <div className="absolute -top-10 -right-8 w-36 h-36 rounded-full bg-white/10 blur-2xl pointer-events-none" />
        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-2xl bg-white/15 flex items-center justify-center">
              <PulseLogo className="h-5 w-5 text-white" />
            </span>
            <span className="text-lg font-bold tracking-tight text-white">Health</span>
          </div>
          <Link
            href="/profile"
            aria-label={userDisplayName}
            className="w-9 h-9 rounded-full bg-white/15 hover:bg-white/25 transition-colors flex items-center justify-center text-white text-sm font-semibold"
          >
            {userDisplayName.slice(0, 1).toUpperCase()}
          </Link>
        </div>
        <div className="relative mt-4">
          <div className="text-[11px] uppercase tracking-wider text-white/70">
            {today.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
          </div>
          <div className="text-xl font-bold text-white mt-0.5">
            {t(lang, "home_greeting")} {userDisplayName}
          </div>
        </div>
      </div>

      <div className="space-y-5 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-5 lg:items-start">
        <div className="space-y-5">
          <section className="card p-5">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">{t(lang, "home_macros")}</h2>
              <Link href="/meals/log" className="text-xs text-accent-brand font-medium">
                {t(lang, "home_log_meal")}
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-y-4 place-items-center">
              <MacroRing label={t(lang, "macro_calories")} value={totals.calories} target={effectiveCal || profile.goal_calories || 0} unit="" color="#10b981" warnOnOver />
              <MacroRing label={t(lang, "macro_protein")} value={totals.protein_g} target={targets.protein_g || profile.goal_protein_g || 0} unit="g" color="#ef4444" warnOnOver={false} />
              <MacroRing label={t(lang, "macro_carbs")} value={totals.carbs_g} target={targets.carbs_g || profile.goal_carbs_g || 0} unit="g" color="#f59e0b" warnOnOver={false} />
              <MacroRing label={t(lang, "macro_fat")} value={totals.fat_g} target={targets.fat_g || profile.goal_fat_g || 0} unit="g" color="#3b82f6" warnOnOver />
            </div>
            {burn > 0 && (
              <div className="mt-4 rounded-lg bg-bg-elev border border-border px-3 py-2 text-[11px] text-white/60 leading-relaxed">
                <span className="text-white/80 font-medium">+{burn} {t(lang, "macro_kcal")}</span> {t(lang, "home_from_training")}{" "}
                <span className="text-white/40">({baseCal} {t(lang, "home_base")} → {effectiveCal} {t(lang, "home_effective")})</span>
              </div>
            )}
          </section>

          {!hasWorkouts ? null : !training ? (
            <section className="card p-5 animate-pulse">
              <div className="h-3 w-24 rounded bg-white/10 mb-4" />
              <div className="flex items-end gap-4">
                <div className="h-10 w-12 rounded bg-white/10" />
                <div className="flex-1 space-y-2">
                  <div className="h-1.5 w-full rounded-full bg-white/10" />
                  <div className="h-3 w-5/6 rounded bg-white/10" />
                </div>
              </div>
            </section>
          ) : recovery ? (
            <section className="card p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">{t(lang, "home_recovery")}</h2>
                <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border ${bandClasses(recovery.band)}`}>
                  {recovery.band}
                </span>
              </div>
              <div className="flex items-end gap-4">
                <div>
                  <div className="text-3xl font-bold leading-none">{recovery.score}</div>
                  <div className="text-[10px] uppercase tracking-wide text-white/40 mt-1">/ 100</div>
                </div>
                <div className="flex-1">
                  <ScoreBar score={recovery.score} band={recovery.band} />
                  <RecoveryRationale recovery={recovery} lang={lang} />
                </div>
              </div>
              <div className="mt-4">
                <div className="text-[10px] uppercase tracking-wide text-white/40 mb-1.5">{t(lang, "home_per_muscle")}</div>
                <div className="grid grid-cols-5 gap-1.5">
                  {recovery.byMuscle.map((m) => (
                    <MusclePill key={m.muscle} status={m} todayLabel={t(lang, "home_today_label")} />
                  ))}
                </div>
              </div>
              {!recovery.signalsUsed.workouts && (
                <p className="text-[10px] text-white/30 mt-3">
                  {t(lang, "home_refresh_workouts")}
                </p>
              )}
            </section>
          ) : null}

          {hasWorkouts && (
            <section className="card p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">{t(lang, "home_this_week")}</h2>
                <Link href="/workouts" className="text-xs text-accent-brand">{t(lang, "home_all_workouts")}</Link>
              </div>
              {!training ? (
                <div className="animate-pulse space-y-2">
                  <div className="h-4 w-1/3 rounded bg-white/10" />
                  <div className="h-1.5 w-full rounded-full bg-white/10" />
                </div>
              ) : training.week ? (
                <WeekWorkoutsBar week={training.week} lang={lang} todaysWorkout={training.todaysWorkout} />
              ) : (
                <div className="text-sm text-white/50">{t(lang, "home_no_workout")}</div>
              )}
            </section>
          )}
        </div>

        <div className="space-y-5">
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">{t(lang, "home_latest_insight")}</h2>
              <div className="flex items-center gap-3">
                <button
                  onClick={generateInsight}
                  disabled={generating}
                  className="text-xs font-medium text-accent-brand disabled:opacity-50"
                >
                  {generating ? t(lang, "insights_generating") : t(lang, "home_gen_insight")}
                </button>
                <Link href="/insights" className="text-xs text-white/45">{t(lang, "home_all_insights")}</Link>
              </div>
            </div>
            {generating && !latestInsight ? (
              <div className="card p-5 text-sm text-white/50 animate-pulse">{t(lang, "insights_generating")}</div>
            ) : latestInsight ? (
              <div className={generating ? "animate-pulse [animation-duration:2.5s]" : ""}>
                <InsightCard
                  headline={latestInsight.headline}
                  body={latestInsight.body}
                  type={latestInsight.type}
                  tags={latestInsight.tags}
                  date={new Date(latestInsight.created_at).toLocaleString()}
                />
              </div>
            ) : (
              <button
                onClick={generateInsight}
                className="card p-5 text-sm text-white/60 w-full text-start hover:border-accent-brand/40"
              >
                {t(lang, "home_no_insights")}{" "}
                <span className="text-accent-brand underline underline-offset-2">
                  {t(lang, "home_generate_first")}
                </span>
              </button>
            )}
          </section>

          {meals.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50 mb-2">{t(lang, "home_todays_meals")}</h2>
              <div className="space-y-2">
                {meals.map((m) => (
                  <div key={m.id} className="card p-3 flex gap-3 items-center">
                    {m.photo_thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.photo_thumb} alt="" width={56} height={56} decoding="async" className="w-14 h-14 rounded-lg object-cover bg-bg-elev" />
                    ) : m.photo_path ? (
                      <Image src={m.photo_path} alt="" width={56} height={56} quality={55} sizes="56px" loading="lazy" className="w-14 h-14 rounded-lg object-cover bg-bg-elev" />
                    ) : (
                      <div className="w-14 h-14 rounded-lg bg-bg-elev" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{m.description || "Meal"}</div>
                      <div className="text-[11px] text-white/50 mt-0.5">
                        {Math.round(m.calories)} kcal · P{Math.round(m.protein_g)} C{Math.round(m.carbs_g)} F{Math.round(m.fat_g)}
                      </div>
                    </div>
                    <div className="text-[11px] text-white/40">
                      {new Date(m.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="px-5 pt-6 pb-6 space-y-5 animate-pulse [animation-duration:1.6s]">
      <div className="h-3 w-32 rounded bg-white/10" />
      <div className="h-6 w-24 rounded bg-white/10" />
      <div className="card p-5 space-y-4">
        <div className="h-3 w-20 rounded bg-white/10" />
        <div className="grid grid-cols-2 gap-y-4 place-items-center">
          <div className="h-[92px] w-[92px] rounded-full bg-white/10" />
          <div className="h-[92px] w-[92px] rounded-full bg-white/10" />
          <div className="h-[92px] w-[92px] rounded-full bg-white/10" />
          <div className="h-[92px] w-[92px] rounded-full bg-white/10" />
        </div>
      </div>
    </div>
  );
}

function WeekWorkoutsBar({
  week,
  lang,
  todaysWorkout,
}: {
  week: NonNullable<Training["week"]>;
  lang: Lang;
  todaysWorkout: Training["todaysWorkout"];
}) {
  const { completed, target, pace } = week;
  const ratio = target > 0 ? Math.min(1, completed / target) : 0;
  const accent =
    pace === "behind"
      ? { text: "text-amber-400", bar: "bg-amber-400" }
      : pace === "ahead"
      ? { text: "text-emerald-400", bar: "bg-emerald-500" }
      : { text: "text-accent-brand", bar: "bg-accent-brand" };
  const remaining = Math.max(0, target - completed);
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="flex items-baseline gap-1.5">
          <span className="text-3xl font-bold leading-none">{completed}</span>
          <span className="text-sm text-white/40">
            / {target || "—"} {t(lang, "home_workouts_short")}
          </span>
        </div>
        <span className={`text-[11px] uppercase tracking-wider font-medium ${accent.text}`}>
          {pace === "behind"
            ? t(lang, "home_pace_behind")
            : pace === "ahead"
            ? t(lang, "home_pace_ahead")
            : t(lang, "home_pace_on_track")}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
        <div className={`h-full rounded-full ${accent.bar} transition-all`} style={{ width: `${ratio * 100}%` }} />
      </div>
      {target > 0 && remaining > 0 && (
        <p className="text-[11px] text-white/50 mt-2">
          {remaining} {t(lang, "home_workouts_left_this_week")}
        </p>
      )}
      {todaysWorkout && (
        <div className="mt-3 pt-3 border-t border-border text-[12px]">
          <div className="text-white/85">
            <span className="text-accent-brand mr-1.5">●</span>
            {todaysWorkout.title}
          </div>
          <div className="text-[11px] text-white/40 mt-0.5">
            {new Date(todaysWorkout.start_time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            {" · "}
            {todaysWorkout.duration_min} min · {Math.round(todaysWorkout.volume_kg).toLocaleString()} kg
            {" · ≈"}{todaysWorkout.burn_kcal} kcal
          </div>
        </div>
      )}
    </div>
  );
}

function RecoveryRationale({ recovery, lang }: { recovery: Recovery; lang: Lang }) {
  const [open, setOpen] = useState(false);
  // Turn the flat rationale into a tap-target that expands an inline
  // breakdown of the signals that drove the score. No portal/modal — a
  // disclosure feels lighter on the small home cards.
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex items-start gap-1.5 text-left leading-snug hover:opacity-90 transition-opacity"
      >
        <span className="text-[12px] text-white/60">{recovery.rationale}</span>
        <svg
          viewBox="0 0 24 24"
          className={`mt-[3px] h-3 w-3 shrink-0 text-accent-brand transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-border bg-bg-elev p-3 space-y-1.5 text-[11px]">
          <div className="text-[10px] uppercase tracking-wide text-white/40 mb-1">
            {t(lang, "home_recovery_breakdown")}
          </div>
          <RationaleRow
            label={t(lang, "home_recovery_protein")}
            value={`${recovery.proteinAdherencePct}%`}
            highlight={recovery.proteinAdherencePct < 85}
          />
          <RationaleRow
            label={t(lang, "home_recovery_calories")}
            value={`${recovery.calorieDeviationPct}% ${t(lang, "home_recovery_off_target")}`}
            highlight={recovery.calorieDeviationPct > 15}
          />
          {recovery.signalsUsed.workouts && (
            <RationaleRow
              label={t(lang, "home_recovery_back_to_back")}
              value={recovery.backToBackSessions ? t(lang, "home_recovery_yes") : t(lang, "home_recovery_no")}
              highlight={recovery.backToBackSessions}
            />
          )}
          {recovery.avgRpeLast3Days !== null && (
            <RationaleRow
              label={t(lang, "home_recovery_rpe")}
              value={recovery.avgRpeLast3Days.toFixed(1)}
              highlight={recovery.avgRpeLast3Days >= 8.5}
            />
          )}
          <p className="text-[10px] text-white/40 leading-snug pt-1.5 mt-1.5 border-t border-border">
            {t(lang, "home_recovery_explainer")}
          </p>
        </div>
      )}
    </div>
  );
}

function RationaleRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/60">{label}</span>
      <span className={highlight ? "text-amber-400 font-medium" : "text-white/85"}>{value}</span>
    </div>
  );
}

function PulseLogo(props: React.SVGProps<SVGSVGElement>) {
  // Heart + heartbeat line — a compact health mark for the header.
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M20.8 5.6a5 5 0 0 0-7.1 0l-1.7 1.7-1.7-1.7a5 5 0 1 0-7.1 7.1l1.7 1.7L12 21l7.1-7.1 1.7-1.7a5 5 0 0 0 0-7.1Z" opacity="0.55" />
      <path d="M3 12.5h4l2-3 2.5 5 2-4 1.5 2H21" />
    </svg>
  );
}

function bandClasses(band: Recovery["band"]) {
  if (band === "high") return "border-emerald-500/40 text-emerald-400 bg-emerald-500/10";
  if (band === "good") return "border-green-500/40 text-green-400 bg-green-500/10";
  if (band === "moderate") return "border-yellow-500/40 text-yellow-400 bg-yellow-500/10";
  return "border-red-500/40 text-red-400 bg-red-500/10";
}

function ScoreBar({ score, band }: { score: number; band: Recovery["band"] }) {
  const pct = Math.min(100, Math.max(0, score));
  const color =
    band === "high" ? "bg-emerald-500" :
    band === "good" ? "bg-green-500" :
    band === "moderate" ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="h-1.5 w-full rounded-full bg-white/10">
      <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Long muscle names get a 6-or-fewer-char abbreviation so the recovery
 *  pills don't ellipsize at narrow widths. Names ≤6 chars stay verbatim. */
const MUSCLE_SHORT: Record<string, string> = {
  shoulders: "SHLDR",
  hamstrings: "HAMS",
  triceps: "TRI",
};

function shortenMuscle(name: string): string {
  return MUSCLE_SHORT[name.toLowerCase()] ?? name;
}

function MusclePill({ status, todayLabel }: { status: MuscleStatus; todayLabel: string }) {
  const colors = {
    rest: "border-red-500/40 text-red-400 bg-red-500/10",
    cautious: "border-yellow-500/40 text-yellow-400 bg-yellow-500/10",
    ready: "border-emerald-500/40 text-emerald-400 bg-emerald-500/10",
  };
  return (
    <div className={`rounded-lg border px-1 py-1 text-center ${colors[status.readiness]}`}>
      <div className="text-[9px] sm:text-[10px] font-semibold uppercase tracking-tight whitespace-nowrap">
        {shortenMuscle(status.muscle)}
      </div>
      <div className="text-[9px] mt-0.5">
        {status.daysSince === 0 ? todayLabel : status.daysSince === null ? "—" : `${status.daysSince}d`}
      </div>
    </div>
  );
}
