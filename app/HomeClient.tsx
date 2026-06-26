"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import MacroRing from "@/components/MacroRing";
import InsightCard from "@/components/InsightCard";
import { useLang } from "@/components/LangProvider";
import { t } from "@/lib/i18n";

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
};

export type Suggestion = {
  body: string;
  meals_count: number;
  totals_calories: number;
  totals_protein_g: number;
  updated_at: string;
  cached: boolean;
};

function lsGet<T>(key: string): T | null {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : null; } catch { return null; }
}
function lsSet(key: string, val: unknown) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

const HOME_CACHE_KEY = "home-today-v1";
const HOME_SUGGESTION_KEY = "home-suggestion-v1";
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
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [suggestionLoading, setSuggestionLoading] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Hydrate from the previous session's snapshot immediately so the
    // page paints with real-looking content on click instead of a blank
    // skeleton, then quietly refresh from the API in the background.
    const cachedToday = lsGet<Today>(HOME_CACHE_KEY);
    if (cachedToday) {
      setData(cachedToday);
      setLoading(false);
    }
    const cachedSuggestion = lsGet<Suggestion>(HOME_SUGGESTION_KEY);
    if (cachedSuggestion) {
      setSuggestion(cachedSuggestion);
      setSuggestionLoading(false);
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
          const r = await fetch("/api/today/training", { cache: "no-store" });
          const j = await r.json();
          setTraining(j);
          lsSet(HOME_TRAINING_KEY, j);
        } catch {
          // non-fatal
        }
      })();
    }
    (async () => {
      try {
        setSuggestionLoading(true);
        const r = await fetch("/api/suggestion", { cache: "no-store" });
        const j = await r.json();
        if (j?.suggestion) {
          setSuggestion(j.suggestion);
          lsSet(HOME_SUGGESTION_KEY, j.suggestion);
        }
      } catch {
        // non-fatal
      } finally {
        setSuggestionLoading(false);
      }
    })();
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
        <Link href="/onboarding" className="inline-block rounded-xl bg-accent-brand px-5 py-3 text-sm font-semibold">
          {t(lang, "home_start_onboarding")}
        </Link>
      </div>
    );
  }

  const { totals, profile, meals, latestInsight, targets } = data;
  const todaysWorkout = training?.todaysWorkout ?? null;
  const recovery = training?.recovery ?? null;
  const today = new Date(data.date);
  const burn = training?.training_burn_kcal ?? 0;
  const baseCal = targets.base_calories;
  const effectiveCal = baseCal + burn;

  return (
    <div className={`px-5 pt-6 pb-6 space-y-5 ${loading ? "animate-pulse [animation-duration:2.5s]" : ""}`}>
      <div className="flex items-end justify-between">
        <div>
          <div className="text-xs text-white/50 uppercase tracking-wider">
            {today.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
          </div>
          <h1 className="text-2xl font-bold mt-0.5">{t(lang, "home_title")}</h1>
        </div>
        <Link href="/profile" className="text-[11px] text-white/50 hover:text-white/80 transition-colors">
          {userDisplayName}
        </Link>
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
              <MacroRing label={t(lang, "macro_calories")} value={totals.calories} target={effectiveCal || profile.goal_calories || 0} unit="" color="#10b981" />
              <MacroRing label={t(lang, "macro_protein")} value={totals.protein_g} target={targets.protein_g || profile.goal_protein_g || 0} unit="g" color="#ef4444" />
              <MacroRing label={t(lang, "macro_carbs")} value={totals.carbs_g} target={targets.carbs_g || profile.goal_carbs_g || 0} unit="g" color="#f59e0b" />
              <MacroRing label={t(lang, "macro_fat")} value={totals.fat_g} target={targets.fat_g || profile.goal_fat_g || 0} unit="g" color="#3b82f6" />
            </div>
            {burn > 0 && (
              <div className="mt-4 rounded-lg bg-bg-elev border border-border px-3 py-2 text-[11px] text-white/60 leading-relaxed">
                <span className="text-white/80 font-medium">+{burn} {t(lang, "macro_kcal")}</span> {t(lang, "home_from_training")}{" "}
                <span className="text-white/40">({baseCal} {t(lang, "home_base")} → {effectiveCal} {t(lang, "home_effective")})</span>
              </div>
            )}
          </section>

          <section className="card p-5">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">{t(lang, "home_next_meal")}</h2>
              {suggestion?.updated_at && (
                <span className="text-[10px] text-white/40">
                  {new Date(suggestion.updated_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
              )}
            </div>
            {suggestion ? (
              <p className="text-[13px] leading-relaxed text-white/80">{suggestion.body}</p>
            ) : suggestionLoading ? (
              <p className="text-[13px] text-white/40">{t(lang, "home_thinking")}</p>
            ) : (
              <p className="text-[13px] text-white/40">{t(lang, "home_no_suggestion")}</p>
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
                  <p className="text-[12px] text-white/60 mt-2 leading-snug">{recovery.rationale}</p>
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
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">{t(lang, "home_todays_workout")}</h2>
                <Link href="/workouts" className="text-xs text-accent-brand">{t(lang, "home_all_workouts")}</Link>
              </div>
              {!training ? (
                <div className="animate-pulse space-y-2">
                  <div className="h-4 w-2/3 rounded bg-white/10" />
                  <div className="h-3 w-1/2 rounded bg-white/10" />
                </div>
              ) : todaysWorkout ? (
                <div>
                  <div className="font-semibold">{todaysWorkout.title}</div>
                  <div className="text-xs text-white/50 mt-0.5">
                    {new Date(todaysWorkout.start_time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}{" "}
                    · {todaysWorkout.duration_min} min · {Math.round(todaysWorkout.volume_kg).toLocaleString()} kg volume
                  </div>
                  <div className="text-[11px] text-white/40 mt-1">≈ {todaysWorkout.burn_kcal} kcal burned ({todaysWorkout.burn_reason})</div>
                </div>
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
              <Link href="/insights" className="text-xs text-accent-brand">{t(lang, "home_all_insights")}</Link>
            </div>
            {latestInsight ? (
              <InsightCard
                headline={latestInsight.headline}
                body={latestInsight.body}
                type={latestInsight.type}
                tags={latestInsight.tags}
                date={new Date(latestInsight.created_at).toLocaleString()}
              />
            ) : (
              <div className="card p-5 text-sm text-white/60">
                {t(lang, "home_no_insights")}{" "}
                <Link href="/insights" className="text-accent-brand underline underline-offset-2">
                  {t(lang, "home_generate_first")}
                </Link>.
              </div>
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
      <div className="card p-5 space-y-2">
        <div className="h-3 w-24 rounded bg-white/10" />
        <div className="h-3 w-full rounded bg-white/10" />
        <div className="h-3 w-4/5 rounded bg-white/10" />
      </div>
    </div>
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

function MusclePill({ status, todayLabel }: { status: MuscleStatus; todayLabel: string }) {
  const colors = {
    rest: "border-red-500/40 text-red-400 bg-red-500/10",
    cautious: "border-yellow-500/40 text-yellow-400 bg-yellow-500/10",
    ready: "border-emerald-500/40 text-emerald-400 bg-emerald-500/10",
  };
  return (
    <div className={`rounded-lg border px-1.5 py-1 text-center ${colors[status.readiness]}`}>
      <div className="text-[9px] font-semibold uppercase tracking-wide truncate">{status.muscle}</div>
      <div className="text-[9px] mt-0.5">
        {status.daysSince === 0 ? todayLabel : status.daysSince === null ? "—" : `${status.daysSince}d`}
      </div>
    </div>
  );
}
