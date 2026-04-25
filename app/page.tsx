"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import MacroRing from "@/components/MacroRing";
import InsightCard from "@/components/InsightCard";

type Today = {
  date: string;
  profile: any | null;
  totals: { calories: number; protein_g: number; fat_g: number; carbs_g: number };
  meals: any[];
  todaysWorkout: { id: string; title: string; volume_kg: number; start_time: string } | null;
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

  const { totals, profile, meals, todaysWorkout, latestInsight } = data;
  const today = new Date(data.date);

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
            target={profile.goal_calories ?? 0}
            unit=""
            color="#10b981"
          />
          <MacroRing
            label="Protein"
            value={totals.protein_g}
            target={profile.goal_protein_g ?? 0}
            unit="g"
            color="#ef4444"
          />
          <MacroRing
            label="Carbs"
            value={totals.carbs_g}
            target={profile.goal_carbs_g ?? 0}
            unit="g"
            color="#f59e0b"
          />
          <MacroRing
            label="Fat"
            value={totals.fat_g}
            target={profile.goal_fat_g ?? 0}
            unit="g"
            color="#3b82f6"
          />
        </div>
      </section>

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
              · {Math.round(todaysWorkout.volume_kg).toLocaleString()} kg volume
            </div>
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
