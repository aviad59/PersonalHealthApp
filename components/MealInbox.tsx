"use client";

// The quick-snap inbox on /meals/log: meals photographed (with a note) at
// eating time and analyzed in the background, waiting for a one-tap confirm.
// Portions and macros can be adjusted first; confirming turns the draft into
// a real meal on the day it was snapped.

import { useCallback, useEffect, useRef, useState } from "react";
import { safeFetchJson } from "@/lib/fetch-json";
import { t, Lang } from "@/lib/i18n";
import { applyPortions, itemsWithPortions, fullPortions, type Macros, type PortionItem } from "@/lib/portions";
import ItemPortions from "@/components/ItemPortions";
import { requestItemFix, applyItemFix } from "@/lib/item-fix";

/** Fired after a snap lands server-side, so an open inbox reloads. */
export const DRAFTS_CHANGED_EVENT = "meal-drafts-changed";

type DraftAnalysis = {
  description: string;
  items: PortionItem[];
  total: Macros;
  confidence: string;
  clarifying_question?: string;
};

type Draft = {
  id: number;
  date: string;
  note: string | null;
  status: "pending" | "analyzing" | "ready" | "error";
  analysis: DraftAnalysis | null;
  error: string | null;
  photo_thumb: string | null;
  photo_thumb_2: string | null;
  photo_path: string | null;
  photo_path_2: string | null;
  needs_analysis: boolean;
};

/** The user's in-progress adjustments to one ready draft. */
type Local = {
  fractions: number[];
  editing: Macros;
  clarifyAnswer: string;
  clarifySkipped: boolean;
};

const POLL_MS = 4000;

export default function MealInbox({
  lang,
  onConfirmed,
  onZoom,
}: {
  lang: Lang;
  /** Days that gained a meal, so the page can refresh what it shows. */
  onConfirmed: (dates: string[]) => void;
  onZoom: (srcs: string[]) => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [local, setLocal] = useState<Record<number, Local>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [allBusy, setAllBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Drafts we've already asked the server to (re)analyze this session, so a
  // reload doesn't fire a second call for the same one.
  const kicked = useRef(new Set<number>());

  const upsert = useCallback((d: Draft) => {
    setDrafts((prev) => prev.map((x) => (x.id === d.id ? d : x)));
  }, []);

  const reanalyze = useCallback(
    async (id: number, hint?: string) => {
      kicked.current.add(id);
      setDrafts((prev) => prev.map((x) => (x.id === id ? { ...x, status: "analyzing", error: null } : x)));
      setLocal((prev) => {
        const { [id]: _, ...rest } = prev;
        return rest;
      });
      try {
        const j = await safeFetchJson<{ draft: Draft }>(`/api/meal-drafts/${id}/analyze`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hint }),
        });
        upsert(j.draft);
      } catch (e: any) {
        setDrafts((prev) =>
          prev.map((x) => (x.id === id ? { ...x, status: "error", error: e?.message ?? "analyze failed" } : x)),
        );
      }
    },
    [upsert],
  );

  const load = useCallback(async () => {
    try {
      const j = await safeFetchJson<{ drafts: Draft[] }>("/api/meal-drafts", { cache: "no-store" });
      setDrafts(j.drafts);
      // Finish anything whose capture request never completed.
      for (const d of j.drafts) {
        if (d.needs_analysis && !kicked.current.has(d.id)) reanalyze(d.id);
      }
    } catch {
      // non-fatal — the inbox just stays as it was
    }
  }, [reanalyze]);

  useEffect(() => {
    load();
    const onChanged = () => load();
    window.addEventListener(DRAFTS_CHANGED_EVENT, onChanged);
    window.addEventListener("focus", onChanged);
    return () => {
      window.removeEventListener(DRAFTS_CHANGED_EVENT, onChanged);
      window.removeEventListener("focus", onChanged);
    };
  }, [load]);

  // A snap captured elsewhere may still be analyzing server-side — poll until
  // it settles. Drafts we re-analyze ourselves resolve via their own call.
  const settling = drafts.some((d) => d.status === "analyzing" && !kicked.current.has(d.id));
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(load, POLL_MS);
    return () => clearTimeout(timer);
  }, [settling, drafts, load]);

  // Seed the editable state the first time a draft's analysis shows up.
  useEffect(() => {
    setLocal((prev) => {
      let next = prev;
      for (const d of drafts) {
        if (d.status === "ready" && d.analysis && !prev[d.id]) {
          next = next === prev ? { ...prev } : next;
          next[d.id] = {
            fractions: fullPortions(d.analysis.items?.length ?? 0),
            editing: { ...d.analysis.total },
            clarifyAnswer: "",
            clarifySkipped: false,
          };
        }
      }
      return next;
    });
  }, [drafts]);

  function patchLocal(id: number, patch: Partial<Local>) {
    setLocal((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));
  }

  /** Correct one misread item. Saved on the draft so the inbox's reloads
   *  don't bring the old reading back. */
  async function fixItem(d: Draft, index: number, prompt: string) {
    const l = local[d.id];
    if (!d.analysis || !l) return;
    const fix = await requestItemFix(d.analysis, index, prompt);
    const r = applyItemFix(d.analysis, l.fractions, index, fix);
    const j = await safeFetchJson<{ draft: Draft | null }>(`/api/meal-drafts/${d.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ analysis: r.meal }),
    });
    upsert(j.draft ?? { ...d, analysis: r.meal });
    patchLocal(d.id, { fractions: r.fractions, editing: r.editing });
  }

  async function confirmOne(d: Draft): Promise<string | null> {
    const l = local[d.id];
    if (d.status !== "ready" || !d.analysis || !l) return null;
    setBusy((b) => ({ ...b, [d.id]: true }));
    try {
      await safeFetchJson(`/api/meal-drafts/${d.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date: d.date,
          description: d.analysis.description,
          ...l.editing,
          items: itemsWithPortions(d.analysis.items ?? [], l.fractions),
          confidence: d.analysis.confidence,
        }),
      });
      setDrafts((prev) => prev.filter((x) => x.id !== d.id));
      return d.date;
    } finally {
      setBusy((b) => ({ ...b, [d.id]: false }));
    }
  }

  async function confirm(d: Draft) {
    setErr(null);
    try {
      const day = await confirmOne(d);
      if (day) onConfirmed([day]);
    } catch (e: any) {
      setErr(e?.message ?? "save failed");
    }
  }

  async function confirmAll() {
    setErr(null);
    setAllBusy(true);
    const days = new Set<string>();
    try {
      // Sequential, like the batch save — a handful of rows, stable order.
      for (const d of drafts) {
        const day = await confirmOne(d);
        if (day) days.add(day);
      }
    } catch (e: any) {
      setErr(e?.message ?? "save failed");
    } finally {
      setAllBusy(false);
      if (days.size) onConfirmed(Array.from(days));
    }
  }

  async function discard(d: Draft) {
    if (!window.confirm(t(lang, "meal_inbox_discard_confirm"))) return;
    setErr(null);
    try {
      await safeFetchJson(`/api/meal-drafts/${d.id}`, { method: "DELETE" });
      setDrafts((prev) => prev.filter((x) => x.id !== d.id));
    } catch (e: any) {
      setErr(e?.message ?? "delete failed");
    }
  }

  async function changeDate(d: Draft, date: string) {
    if (!date || date === d.date) return;
    upsert({ ...d, date });
    try {
      await safeFetchJson(`/api/meal-drafts/${d.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date }),
      });
    } catch (e: any) {
      upsert(d);
      setErr(e?.message ?? "update failed");
    }
  }

  if (drafts.length === 0) return null;
  const readyCount = drafts.filter((d) => d.status === "ready" && local[d.id]).length;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/70">
          {t(lang, "meal_inbox_title")} ({drafts.length})
        </h2>
        {readyCount > 1 && (
          <button
            onClick={confirmAll}
            disabled={allBusy}
            className="text-[12px] text-accent-brand disabled:opacity-40"
          >
            {allBusy ? t(lang, "meal_saving_short") : `${t(lang, "meal_inbox_confirm_all")} (${readyCount})`}
          </button>
        )}
      </div>

      {drafts.map((d) => {
        const l = local[d.id];
        const a = d.analysis;
        const working = !!busy[d.id] || allBusy;
        const question = a?.clarifying_question && !l?.clarifySkipped ? a.clarifying_question : null;
        const photos = [d.photo_path, d.photo_path_2].filter((p): p is string => !!p);
        return (
          <div key={d.id} className="card p-3 space-y-2">
            <div className="flex gap-3">
              <div className="relative shrink-0 w-16 h-16">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={d.photo_thumb ?? ""}
                  alt="meal"
                  onClick={() => photos.length && onZoom(photos)}
                  className="w-16 h-16 rounded-xl object-cover border border-border bg-bg-elev cursor-zoom-in"
                />
                {d.photo_thumb_2 && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={d.photo_thumb_2}
                    alt="meal, second photo"
                    onClick={() => onZoom(photos)}
                    className="absolute -bottom-1.5 -right-1.5 w-8 h-8 rounded-lg object-cover border-2 border-bg-card cursor-zoom-in"
                  />
                )}
              </div>
              <div className="flex-1 min-w-0 space-y-1">
                <input
                  type="date"
                  value={d.date}
                  onChange={(e) => changeDate(d, e.target.value)}
                  disabled={working}
                  className="bg-transparent border-0 p-0 text-[11px] text-ink/75 focus:outline-none"
                />
                {d.note && (
                  <div className="text-[12px] text-ink/75" dir={/[֐-׿]/.test(d.note) ? "rtl" : "ltr"}>
                    “{d.note}”
                  </div>
                )}
                {(d.status === "pending" || d.status === "analyzing") && (
                  <div className="text-[12px] text-ink/70 animate-pulse">{t(lang, "meal_inbox_pending")}</div>
                )}
                {d.status === "error" && (
                  <div className="text-[12px] text-bad">
                    {t(lang, "meal_inbox_error")}
                    {" · "}
                    <button onClick={() => reanalyze(d.id)} className="text-accent-brand">
                      {t(lang, "meal_inbox_retry")}
                    </button>
                  </div>
                )}
                {d.status === "ready" && a && (
                  <div className="text-[13px] font-medium leading-snug" dir={/[֐-׿]/.test(a.description) ? "rtl" : "ltr"}>
                    {a.description}
                  </div>
                )}
              </div>
            </div>

            {d.status === "ready" && a && l && (
              <>
                <ItemPortions
                  items={a.items ?? []}
                  fractions={l.fractions}
                  onChange={(next) =>
                    patchLocal(d.id, { fractions: next, editing: applyPortions(a.total, a.items ?? [], next) })
                  }
                  onFix={(i, prompt) => fixItem(d, i, prompt)}
                  lang={lang}
                  disabled={working}
                  compact
                />
                <div className="grid grid-cols-4 gap-1.5">
                  {(
                    [
                      ["calories", t(lang, "macro_kcal")],
                      ["protein_g", "P"],
                      ["fat_g", "F"],
                      ["carbs_g", "C"],
                    ] as const
                  ).map(([k, label]) => (
                    <label key={k} className="block">
                      <span className="block text-[9px] uppercase tracking-wide text-ink/65 mb-0.5">{label}</span>
                      <input
                        type="number"
                        value={Math.round(l.editing[k])}
                        onChange={(e) =>
                          patchLocal(d.id, { editing: { ...l.editing, [k]: Number(e.target.value) || 0 } })
                        }
                        disabled={working}
                        className="w-full rounded-lg bg-bg-elev border border-border px-1.5 py-1.5 text-[12px] nums text-center"
                      />
                    </label>
                  ))}
                </div>

                {question && (
                  <div className="rounded-xl border border-warn/30 bg-warn/5 p-2.5 space-y-1.5">
                    <div className="text-[11px] font-medium text-warn">{t(lang, "meal_clarify_label")}</div>
                    <div className="text-[12px] text-ink/90" dir={/[֐-׿]/.test(question) ? "rtl" : "ltr"}>
                      {question}
                    </div>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={l.clarifyAnswer}
                        onChange={(e) => patchLocal(d.id, { clarifyAnswer: e.target.value })}
                        dir={/[֐-׿]/.test(l.clarifyAnswer) ? "rtl" : "ltr"}
                        placeholder={t(lang, "meal_clarify_placeholder")}
                        disabled={working}
                        className="flex-1 min-w-0 rounded-lg bg-bg-elev border border-border px-2.5 py-1.5 text-[12px]"
                      />
                      <button
                        onClick={() => reanalyze(d.id, `${question} Answer: ${l.clarifyAnswer.trim()}`)}
                        disabled={working || !l.clarifyAnswer.trim()}
                        className="rounded-lg bg-accent-brand px-3 py-1.5 text-[12px] font-semibold disabled:opacity-40 text-on-brand"
                      >
                        {t(lang, "meal_clarify_update")}
                      </button>
                      <button
                        onClick={() => patchLocal(d.id, { clarifySkipped: true })}
                        disabled={working}
                        className="rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-ink/75 disabled:opacity-40"
                      >
                        {t(lang, "meal_clarify_skip")}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="flex gap-2 pt-0.5">
              <button
                onClick={() => discard(d)}
                disabled={working}
                className="rounded-full border border-border bg-bg-elev px-4 py-2 text-[12px] text-ink/75 disabled:opacity-40"
              >
                {t(lang, "meal_inbox_discard")}
              </button>
              <button
                onClick={() => confirm(d)}
                disabled={working || d.status !== "ready" || !l}
                className="flex-1 rounded-full bg-accent-brand py-2 text-[13px] font-semibold disabled:opacity-40 text-on-brand"
              >
                {busy[d.id] ? t(lang, "meal_saving_short") : t(lang, "meal_inbox_confirm")}
              </button>
            </div>
          </div>
        );
      })}

      {err && <div className="text-sm text-bad">{err}</div>}
    </section>
  );
}
