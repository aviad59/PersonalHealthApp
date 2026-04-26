"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import MacroRing from "@/components/MacroRing";
import InsightCard from "@/components/InsightCard";

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
  byMuscle: MuscleStatus[];
  rationale: string;
  signalsUsed: {
    protein: boolean;
    calories: boolean;
    workouts: boolean;
    sleep: boolean;
  };
};

type Today = {
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
  todaysWorkout: {
    id: string;
    title: string;
    volume_kg: number;
    start_time: string;
    duration_min: number;
    burn_kcal: number;
    burn_reason: string;
  } | null;
  recovery: Recovery | null;
  latestInsight: {
    id: number;
    type: "daily" | "weekly";
    headline: string;
    body: string;
    created_at: string;
    tags: string[];
  } | null;
};

export default function HomePage() {
  const [data, setData] = useState<Today | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/today", { cache: "no-store" });
        const j = await r.json();
        setData(j);
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="p-6 text-white/60">Loading…</div>;
  if (err) return <div className="p-6 text-red-400">{err}</div>;
  if (!data) return null;

  if (!data.profile) {
    return (
      <div className="px-5 pt-10 space-y-4">
        <h1 className="text-3xl font-bold">Welcome</h1>
        <p className="text-white/60">Let&apos;s set up your profile so we can calculate personalized targets.</p>
        <Link
          href="/onboarding"
          className="inline-block rounded-xl bg-accent-brand px-5 py-3 text-sm font-semibold"
        >
          Start onboarding
        </Link>
      </div>
    );
  }

  const { totals, profile, meals, todaysWorkout, latestInsight, targets, recovery } = data;
  const today = new Date(data.date);
  const burn = targets.training_burn_kcal;

  return (
    <div className="px-5 pt-6 pb-6 space-y-5">
      <div>
        <div className="text-xs text-white/50 uppercase tracking-wider">
          {today.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
        </div>
        <h1 className="text-2xl font-bold mt-0.5">Today</h1>
      </div>

      <section className="card p-5">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">Macros</h2>
          <Link href="/meals/log" className="text-xs text-accent-brand font-medium">
            + Log meal
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-y-4 place-items-center">
          <MacroRing
            label="Calories"
            value={totals.calories}
            target={targets.effective_calories || profile.goal_calories || 0}
            unit=""
            color="#10b981"
          />
          <MacroRing
            label="Protein"
            value={totals.protein_g}
            target={targets.protein_g || profile.goal_protein_g || 0}
            unit="g"
            color="#ef4444"
          />
          <MacroRing
            label="Carbs"
            value={totals.carbs_g}
            target={targets.carbs_g || profile.goal_carbs_g || 0}
            unit="g"
            color="#f59e0b"
          />
          <MacroRing
            label="Fat"
            value={totals.fat_g}
            target={targets.fat_g || profile.goal_fat_g || 0}
            unit="g"
            color="#3b82f6"
          />
        </div>
        {burn > 0 && (
          <div className="mt-4 rounded-lg bg-bg-elev border border-border px-3 py-2 text-[11px] text-white/60 leading-relaxed">
            <span className="text-white/80 font-medium">+{burn} kcal</span> from today&apos;s training{" "}
            <span className="text-white/40">
              ({targets.base_calories} base → {targets.effective_calories} effective)
            </span>
          </div>
        )}
      </section>

      {recovery && (
        <section className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">Recovery</h2>
            <span
              className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border ${bandClasses(
                recovery.band,
              )}`}
            >
              {recovery.band}
            </span>
          </div>

          <div className="flex items-end gap-4">
            <div>
              <div className="text-3xl font-bold leading-none">{recovery.score}</div>
              <div className="text-[10px] uppercase tracking-wide text-white/40 mt-1">
                / 100
              </div>
            </div>
            <div className="flex-1">
              <ScoreBar score={recovery.score} band={recovery.band} />
              <p className="text-[12px] text-white/60 mt-2 leading-snug">{recovery.rationale}</p>
            </div>
          </div>

          <div className="mt-4">
            <div className="text-[10px] uppercase tracking-wide text-white/40 mb-1.5">Per muscle</div>
            <div className="grid grid-cols-5 gap-1.5">
              {recovery.byMuscle.map((m) => (
                <MusclePill key={m.muscle} status={m} />
              ))}
            </div>
          </div>

          {!recovery.signalsUsed.workouts && (
            <p className="text-[10px] text-white/30 mt-3">
              Hit Refresh on the Workouts page to populate per-muscle data.
            </p>
          )}
        </section>
      )}

      <section className="card p-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">Today&apos;s workout</h2>
          <Link href="/workouts" className="text-xs text-accent-brand">All →</Link>
        </div>
        {todaysWorkout ? (
          <div>
            <div className="font-semibold">{todaysWorkout.title}</div>
            <div className="text-xs text-white/50 mt-0.5">
              {new Date(todaysWorkout.start_time).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}{" "}
              · {todaysWorkout.duration_min} min · {Math.round(todaysWorkout.volume_kg).toLocaleString()} kg volume
            </div>
            <div className="text-[11px] text-white/40 mt-1">≈ {todaysWorkout.burn_kcal} kcal burned ({todaysWorkout.burn_reason})</div>
          </div>
        ) : (
          <div className="text-sm text-white/50">No workout logged in Hevy yet.</div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">Latest insight</h2>
          <Link href="/insights" className="text-xs text-accent-brand">All →</Link>
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
            No insights yet.{" "}
            <Link href="/insights" className="text-accent-brand underline underline-offset-2">
              Generate your first one
            </Link>
            .
          </div>
        )}
      </section>

      {meals.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50 mb-2">
            Today&apos;s meals
          </h2>
          <div className="space-y-2">
            {meals.map((m) => (
              <div key={m.id} className="card p-3 flex gap-3 items-center">
                {m.photo_path ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.photo_path} alt="" className="w-14 h-14 rounded-lg object-cover" />
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
                  {new Date(m.created_at).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function bandClasses(band: Recovery["band"]) {
  switch (band) {
    case "high":
      return "text-emerald-300 border-emerald-500/40 bg-emerald-500/10";
    case "good":
      return "text-emerald-300 border-emerald-500/30 bg-emerald-500/5";
    case "moderate":
      return "text-amber-300 border-amber-500/40 bg-amber-500/10";
    case "low":
      return "text-red-300 border-red-500/40 bg-red-500/10";
  }
}

function ScoreBar({ score, band }: { score: number; band: Recovery["band"] }) {
  const fill =
    band === "high" || band === "good"
      ? "bg-emerald-500"
      : band === "moderate"
        ? "bg-amber-500"
        : "bg-red-500";
  return (
    <div className="h-1.5 rounded-full bg-bg-elev overflow-hidden">
      <div className={`h-full ${fill}`} style={{ width: `${Math.max(2, score)}%` }} />
    </div>
  );
}

function MusclePill({ status }: { status: MuscleStatus }) {
  const cls =
    status.readiness === "rest"
      ? "border-red-500/40 bg-red-500/10 text-red-300"
      : status.readiness === "cautious"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
        : "border-emerald-500/30 bg-emerald-500/5 text-emerald-300";
  const days =
    status.daysSince === null
      ? "—"
      : status.daysSince === 0
        ? "today"
        : `${status.daysSince}d`;
  return (
    <div
      className={`rounded-md border ${cls} px-1.5 py-1 text-center`}
      title={`${status.muscle} — ${status.readiness}${
        status.daysSince === null ? "" : ` (last hit ${days} ago)`
      }`}
    >
      <div className="text-[10px] capitalize leading-tight">{status.muscle}</div>
      <div className="text-[9px] opacity-70 leading-tight">{days}</div>
    </div>
  );
}
