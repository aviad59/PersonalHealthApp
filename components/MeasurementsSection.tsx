"use client";

import { useEffect, useState } from "react";
import { useLang } from "@/components/LangProvider";
import { t, TKey } from "@/lib/i18n";

type Entry = {
  date: string;
  waist_cm: number | null;
  neck_cm: number | null;
  hips_cm: number | null;
  chest_cm: number | null;
  arm_cm: number | null;
  thigh_cm: number | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

const FIELDS = [
  { key: "waist_cm", labelKey: "measure_waist" },
  { key: "neck_cm", labelKey: "measure_neck" },
  { key: "hips_cm", labelKey: "measure_hips" },
  { key: "chest_cm", labelKey: "measure_chest" },
  { key: "arm_cm", labelKey: "measure_arm" },
  { key: "thigh_cm", labelKey: "measure_thigh" },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];

export default function MeasurementsSection() {
  const lang = useLang();
  const [log, setLog] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<Record<FieldKey, string>>({
    waist_cm: "",
    neck_cm: "",
    hips_cm: "",
    chest_cm: "",
    arm_cm: "",
    thigh_cm: "",
  });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/measurements", { cache: "no-store" });
      const j = await r.json();
      if (r.ok) setLog(j.log || []);
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    const body: Record<string, number | string> = {};
    for (const f of FIELDS) {
      const v = Number(values[f.key]);
      if (values[f.key] && Number.isFinite(v) && v > 0) body[f.key] = v;
    }
    if (Object.keys(body).length === 0) {
      setErr(t(lang, "measure_empty"));
      return;
    }
    if (note.trim()) body.note = note.trim();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/measurements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "save failed");
      setLog(j.log || []);
      setValues({ waist_cm: "", neck_cm: "", hips_cm: "", chest_cm: "", arm_cm: "", thigh_cm: "" });
      setNote("");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(date: string) {
    if (!confirm(t(lang, "measure_delete_confirm"))) return;
    try {
      await fetch(`/api/measurements?date=${date}`, { method: "DELETE" });
      await load();
    } catch {
      // non-fatal
    }
  }

  return (
    <section className="card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
          {t(lang, "measure_title")}
        </h2>
        {log.length > 0 && (
          <span className="text-[11px] text-white/40">
            {log.length} {t(lang, "measure_entries")}
          </span>
        )}
      </div>
      <p className="text-xs text-white/55 leading-snug">{t(lang, "measure_hint")}</p>

      {/* Entry grid */}
      <div className="grid grid-cols-3 gap-2">
        {FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">
              {t(lang, f.labelKey as TKey)}
            </span>
            <input
              inputMode="decimal"
              value={values[f.key]}
              onChange={(e) =>
                setValues((v) => ({ ...v, [f.key]: e.target.value.replace(/[^\d.]/g, "") }))
              }
              placeholder="cm"
              className="w-full rounded-xl bg-bg-elev border border-border px-3 py-2.5 text-[15px] nums focus:outline-none focus:border-accent-brand"
            />
          </label>
        ))}
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        dir={/[֐-׿]/.test(note) ? "rtl" : "ltr"}
        placeholder={t(lang, "measure_note_placeholder")}
        className="w-full rounded-xl bg-bg-elev border border-border px-3 py-2.5 text-[14px] focus:outline-none focus:border-accent-brand"
      />
      <button
        onClick={save}
        disabled={busy}
        className="w-full rounded-full bg-accent-brand py-3 text-sm font-semibold text-white disabled:opacity-40"
      >
        {busy ? "…" : t(lang, "measure_log_btn")}
      </button>
      {err && <div className="text-sm text-red-400">{err}</div>}

      {/* History */}
      {loading ? null : log.length === 0 ? (
        <div className="text-[11px] text-white/40">{t(lang, "measure_empty")}</div>
      ) : (
        <div className="divide-y divide-border">
          {[...log].reverse().map((e) => (
            <div key={e.date} className="flex items-start justify-between py-2.5 gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{e.date}</div>
                <div className="text-[11px] text-white/55 mt-0.5">
                  {FIELDS.filter((f) => e[f.key] != null)
                    .map((f) => `${t(lang, f.labelKey as TKey)} ${e[f.key]}`)
                    .join(" · ")}
                </div>
                {e.note && <div className="text-[11px] text-white/40 mt-0.5 truncate">{e.note}</div>}
              </div>
              <button
                onClick={() => remove(e.date)}
                className="shrink-0 text-white/30 hover:text-red-400 text-sm leading-none px-1"
                aria-label="Delete"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
