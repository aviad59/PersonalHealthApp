"use client";

import { useEffect, useMemo, useState } from "react";
import InsightCard from "@/components/InsightCard";

type Insight = {
  id: number;
  type: "daily" | "weekly";
  for_date: string;
  headline: string;
  body: string;
  tags: string[];
  created_at: string;
};

export default function InsightsPage() {
  const [filter, setFilter] = useState<"all" | "daily" | "weekly">("all");
  const [items, setItems] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState<null | "daily" | "weekly">(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const q = filter === "all" ? "" : `?type=${filter}`;
    const r = await fetch(`/api/insights${q}`, { cache: "no-store" });
    const j = await r.json();
    setItems(j.insights || []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, [filter]);

  async function generate(type: "daily" | "weekly") {
    setGenerating(type);
    setErr(null);
    try {
      const r = await fetch("/api/insights/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "generate failed");
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setGenerating(null);
    }
  }

  return (
    <div className="px-5 pt-6 pb-10 space-y-5">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-bold">Insights</h1>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => generate("daily")}
          disabled={!!generating}
          className="flex-1 rounded-xl bg-accent-brand py-3 text-sm font-semibold text-white disabled:opacity-40"
        >
          {generating === "daily" ? "Generating…" : "Generate daily"}
        </button>
        <button
          onClick={() => generate("weekly")}
          disabled={!!generating}
          className="flex-1 rounded-xl bg-bg-elev border border-border py-3 text-sm font-semibold disabled:opacity-40"
        >
          {generating === "weekly" ? "Generating…" : "Generate weekly"}
        </button>
      </div>

      <div className="flex gap-2 text-sm">
        {(["all", "daily", "weekly"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={`px-3 py-1.5 rounded-full border transition-colors ${
              filter === k
                ? "bg-accent-brand border-accent-brand"
                : "bg-bg-elev border-border text-white/60"
            }`}
          >
            {k[0].toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>

      {err && <div className="text-sm text-red-400">{err}</div>}

      {loading ? (
        <div className="text-white/50 text-sm">Loading…</div>
      ) : items.length === 0 ? (
        <div className="card p-6 text-center text-sm text-white/60">
          No insights yet. Generate your first one above.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((it) => (
            <InsightCard
              key={it.id}
              headline={it.headline}
              body={it.body}
              type={it.type}
              tags={it.tags}
              date={new Date(it.created_at).toLocaleString()}
            />
          ))}
        </div>
      )}
    </div>
  );
}
