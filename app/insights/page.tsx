"use client";

import { useEffect, useState } from "react";
import InsightCard from "@/components/InsightCard";
import { safeFetchJson } from "@/lib/fetch-json";
import { useLang } from "@/components/LangProvider";
import { t, TKey } from "@/lib/i18n";

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
  const lang = useLang();
  const [filter, setFilter] = useState<"all" | "daily" | "weekly">("all");
  const [items, setItems] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState<null | "daily" | "weekly">(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const q = filter === "all" ? "" : `?type=${filter}`;
      const j = await safeFetchJson<{ insights: Insight[] }>(`/api/insights${q}`, {
        cache: "no-store",
      });
      setItems(j.insights || []);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [filter]);

  async function generate(type: "daily" | "weekly") {
    setGenerating(type);
    setErr(null);
    try {
      // Insight generation legitimately takes 10–30 s (Claude is summarizing
      // a week of data). safeFetchJson surfaces real timeouts as a clear
      // "Server timed out" message instead of a JSON parse crash.
      await safeFetchJson("/api/insights/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type }),
      });
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
        <h1 className="text-2xl font-bold">{t(lang, "insights_title")}</h1>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => generate("daily")}
          disabled={!!generating}
          className="flex-1 rounded-xl bg-accent-brand py-3 text-sm font-semibold text-white disabled:opacity-40"
        >
          {generating === "daily" ? t(lang, "insights_generating") : t(lang, "insights_gen_daily")}
        </button>
        <button
          onClick={() => generate("weekly")}
          disabled={!!generating}
          className="flex-1 rounded-xl bg-bg-elev border border-border py-3 text-sm font-semibold disabled:opacity-40"
        >
          {generating === "weekly" ? t(lang, "insights_generating") : t(lang, "insights_gen_weekly")}
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
            {t(lang, `insights_${k}` as TKey)}
          </button>
        ))}
      </div>

      {err && <div className="text-sm text-red-400">{err}</div>}

      {loading ? (
        <div className="text-white/50 text-sm">{t(lang, "insights_loading")}</div>
      ) : items.length === 0 ? (
        <div className="card p-6 text-center text-sm text-white/60">
          {t(lang, "insights_empty")}
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
