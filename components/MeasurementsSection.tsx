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

function PencilIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

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
  // When set, the form is editing an existing entry (this date) instead of
  // logging a new one for today — so a mistyped measurement can be fixed.
  const [editDate, setEditDate] = useState<string | null>(null);

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
    // Editing an existing entry: target that date (upsert overwrites it).
    if (editDate) body.date = editDate;
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
      setEditDate(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  function startEdit(e: Entry) {
    setValues({
      waist_cm: e.waist_cm != null ? String(e.waist_cm) : "",
      neck_cm: e.neck_cm != null ? String(e.neck_cm) : "",
      hips_cm: e.hips_cm != null ? String(e.hips_cm) : "",
      chest_cm: e.chest_cm != null ? String(e.chest_cm) : "",
      arm_cm: e.arm_cm != null ? String(e.arm_cm) : "",
      thigh_cm: e.thigh_cm != null ? String(e.thigh_cm) : "",
    });
    setNote(e.note ?? "");
    setEditDate(e.date);
    setErr(null);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit() {
    setEditDate(null);
    setValues({ waist_cm: "", neck_cm: "", hips_cm: "", chest_cm: "", arm_cm: "", thigh_cm: "" });
    setNote("");
    setErr(null);
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
      {editDate && (
        <div className="flex items-center justify-between rounded-lg bg-accent-brand/10 border border-accent-brand/30 px-3 py-2 text-xs">
          <span className="text-accent-brand">{t(lang, "measure_editing")} {editDate}</span>
          <button onClick={cancelEdit} className="text-white/50 hover:text-white/80">
            {t(lang, "measure_cancel")}
          </button>
        </div>
      )}
      <button
        onClick={save}
        disabled={busy}
        className="w-full rounded-full bg-accent-brand py-3 text-sm font-semibold text-white disabled:opacity-40"
      >
        {busy ? "…" : editDate ? t(lang, "measure_save_edit") : t(lang, "measure_log_btn")}
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
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => startEdit(e)}
                  className="text-white/35 hover:text-accent-brand p-1"
                  aria-label={t(lang, "measure_edit")}
                >
                  <PencilIcon className="h-4 w-4" />
                </button>
                <button
                  onClick={() => remove(e.date)}
                  className="text-white/30 hover:text-red-400 text-base leading-none px-1"
                  aria-label="Delete"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
