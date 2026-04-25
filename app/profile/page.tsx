"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ACTIVITY_LABELS } from "@/lib/calc";

type ActivityKey = keyof typeof ACTIVITY_LABELS;
type Resolution = "keep" | "replace" | "merge";

type Conflict = {
  date: string;
  existingCount: number;
  existingTotal: {
    calories: number;
    protein_g: number;
    fat_g: number;
    carbs_g: number;
  };
  incomingCount: number;
  incomingTotal: {
    calories: number;
    protein_g: number;
    fat_g: number;
    carbs_g: number;
  };
};

export default function ProfilePage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profile, setProfile] = useState<any | null>(null);
  const [preview, setPreview] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // --- CSV backfill state ---
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [useAi, setUseAi] = useState(true);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillErr, setBackfillErr] = useState<string | null>(null);
  const [backfillPreview, setBackfillPreview] = useState<any | null>(null);
  const [backfillResult, setBackfillResult] = useState<any | null>(null);

  // Per-date and global conflict resolution
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [applyToAll, setApplyToAll] = useState<Resolution | null>(null);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/profile", { cache: "no-store" });
      const j = await r.json();
      setProfile(j.profile);
      setLoading(false);
    })();
  }, []);

  function update<K extends string>(k: K, v: any) {
    setProfile((p: any) => ({ ...p, [k]: v }));
  }

  async function recalculate() {
    if (!profile) return;
    setErr(null);
    try {
      const res = await fetch("/api/goals/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toPayload(profile)),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "preview failed");
      setPreview(j);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function save() {
    if (!profile) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toPayload(profile)),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "save failed");
      setProfile(j.profile);
      setPreview(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function runBackfillDryRun() {
    const f = fileRef.current?.files?.[0];
    if (!f) {
      setBackfillErr("Pick a CSV file first.");
      return;
    }
    setBackfillErr(null);
    setBackfillLoading(true);
    setBackfillResult(null);
    setResolutions({});
    setApplyToAll(null);
    try {
      const form = new FormData();
      form.append("file", f);
      form.append("dryRun", "true");
      form.append("useAi", useAi ? "true" : "false");
      const res = await fetch("/api/meals/import", {
        method: "POST",
        body: form,
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "import failed");
      setBackfillPreview(j);
    } catch (e: any) {
      setBackfillErr(e.message);
    } finally {
      setBackfillLoading(false);
    }
  }

  async function runBackfillCommit() {
    const f = fileRef.current?.files?.[0];
    if (!f || !backfillPreview) return;

    // If there are conflicts, make sure every one has a resolution (unless
    // applyToAll is set).
    const conflicts: Conflict[] = backfillPreview.conflicts ?? [];
    if (conflicts.length > 0 && !applyToAll) {
      const missing = conflicts.find((c) => !resolutions[c.date]);
      if (missing) {
        setBackfillErr(
          `Pick an action for ${missing.date} (or use "apply to all").`,
        );
        return;
      }
    }

    setBackfillErr(null);
    setBackfillLoading(true);
    try {
      const form = new FormData();
      form.append("file", f);
      form.append("dryRun", "false");
      form.append("useAi", useAi ? "true" : "false");
      if (applyToAll) {
        form.append("defaultPolicy", applyToAll);
      } else {
        form.append("resolutions", JSON.stringify(resolutions));
      }
      const res = await fetch("/api/meals/import", {
        method: "POST",
        body: form,
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "import failed");
      setBackfillResult(j);
      // Clear preview + resolutions after a successful commit so the UI resets.
      setBackfillPreview(null);
      setResolutions({});
      setApplyToAll(null);
    } catch (e: any) {
      setBackfillErr(e.message);
    } finally {
      setBackfillLoading(false);
    }
  }

  function setAll(res: Resolution) {
    setApplyToAll(res);
    // prefill per-row with the same value so the UI visually matches
    if (backfillPreview?.conflicts) {
      const next: Record<string, Resolution> = {};
      for (const c of backfillPreview.conflicts as Conflict[]) next[c.date] = res;
      setResolutions(next);
    }
  }

  function setOne(date: string, res: Resolution) {
    setResolutions((prev) => ({ ...prev, [date]: res }));
    setApplyToAll(null); // user diverged from the blanket policy
  }

  if (loading) return <div className="p-6 text-white/60">Loading…</div>;

  if (!profile) {
    return (
      <div className="px-5 pt-10">
        <h1 className="text-2xl font-bold mb-2">Profile</h1>
        <p className="text-sm text-white/60 mb-6">You haven&apos;t set up your profile yet.</p>
        <Link href="/onboarding" className="inline-block rounded-xl bg-accent-brand px-4 py-2 text-sm font-semibold">
          Run onboarding
        </Link>
      </div>
    );
  }

  const conflicts: Conflict[] = backfillPreview?.conflicts ?? [];
  const conflictsResolved =
    conflicts.length === 0 ||
    !!applyToAll ||
    conflicts.every((c) => !!resolutions[c.date]);

  return (
    <div className="px-5 pt-6 pb-6 space-y-6">
      <h1 className="text-2xl font-bold">Profile</h1>

      <section className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">Body metrics</h2>
        <NumField label="Age" value={profile.age} onChange={(v) => update("age", v)} />
        <div>
          <label className="block text-xs font-medium text-white/60 mb-1.5">Sex</label>
          <div className="grid grid-cols-2 gap-2">
            <SexBtn active={profile.sex === "male"} onClick={() => update("sex", "male")}>Male</SexBtn>
            <SexBtn active={profile.sex === "female"} onClick={() => update("sex", "female")}>Female</SexBtn>
          </div>
        </div>
        <NumField label="Height (cm)" value={profile.height_cm} onChange={(v) => update("height_cm", v)} />
        <NumField label="Weight (kg)" value={profile.weight_kg} onChange={(v) => update("weight_kg", v)} />
        <NumField label="Neck (cm)" value={profile.neck_cm} onChange={(v) => update("neck_cm", v)} />
        <NumField label="Waist (cm)" value={profile.waist_cm} onChange={(v) => update("waist_cm", v)} />
        {profile.sex === "female" && (
          <NumField label="Hips (cm)" value={profile.hips_cm ?? ""} onChange={(v) => update("hips_cm", v)} />
        )}
        <div>
          <label className="block text-xs font-medium text-white/60 mb-1.5">Activity</label>
          <select
            value={profile.activity_level}
            onChange={(e) => update("activity_level", e.target.value as ActivityKey)}
            className="w-full rounded-xl bg-bg-elev border border-border px-4 py-3 text-sm"
          >
            {(Object.keys(ACTIVITY_LABELS) as ActivityKey[]).map((k) => (
              <option key={k} value={k}>{ACTIVITY_LABELS[k]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-white/60 mb-1.5">Goal mode</label>
          <select
            value={profile.goal_mode ?? "recomp"}
            onChange={(e) => update("goal_mode", e.target.value)}
            className="w-full rounded-xl bg-bg-elev border border-border px-4 py-3 text-sm"
          >
            <option value="recomp">Recomp</option>
            <option value="cut">Cut</option>
            <option value="bulk">Bulk</option>
            <option value="maintain">Maintain</option>
          </select>
        </div>
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">Current goals</h2>
        <Row k="Body fat" v={profile.body_fat_pct ? `${profile.body_fat_pct}%` : "—"} />
        <Row k="Lean mass" v={profile.lean_mass_kg ? `${profile.lean_mass_kg} kg` : "—"} />
        <Row k="BMR" v={profile.bmr ? `${profile.bmr} kcal` : "—"} />
        <Row k="TDEE" v={profile.tdee ? `${profile.tdee} kcal` : "—"} />
        <div className="h-px bg-border my-1" />
        <Row k="Calories" v={`${profile.goal_calories} kcal`} emphasize />
        <Row k="Protein" v={`${profile.goal_protein_g} g`} emphasize />
        <Row k="Fat" v={`${profile.goal_fat_g} g`} emphasize />
        <Row k="Carbs" v={`${profile.goal_carbs_g} g`} emphasize />
        <Row k="Workouts / wk" v={`${profile.weekly_workout_target}`} />
      </section>

      {preview && (
        <section className="card p-5 space-y-3 border-accent-brand/40">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-accent-brand">New targets (preview)</h2>
          <Row k="Body fat" v={`${preview.body_fat_pct}%`} />
          <Row k="Lean mass" v={`${preview.lean_mass_kg} kg`} />
          <Row k="TDEE" v={`${preview.tdee} kcal`} />
          <Row k="Calories" v={`${preview.goal_calories} kcal`} emphasize />
          <Row k="Protein" v={`${preview.goal_protein_g} g`} emphasize />
          <Row k="Fat" v={`${preview.goal_fat_g} g`} emphasize />
          <Row k="Carbs" v={`${preview.goal_carbs_g} g`} emphasize />
        </section>
      )}

      {err && <div className="text-sm text-red-400">{err}</div>}

      <div className="flex gap-3">
        <button
          onClick={recalculate}
          className="flex-1 rounded-xl border border-border bg-bg-elev py-3 text-sm font-medium"
        >
          Preview recalc
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="flex-1 rounded-xl bg-accent-brand py-3 text-sm font-semibold disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save & recalculate"}
        </button>
      </div>

      {/* --- CSV BACKFILL --- */}
      <section className="card p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">Backfill nutrition from CSV</h2>
          <p className="text-xs text-white/50 mt-1.5 leading-relaxed">
            Upload a CSV with columns <span className="font-mono">date, calories, protein, carbs, fat, description</span>.
            Daily summary rows (סה״כ / סיכום) are skipped. Missing carbs are derived from the kcal balance when possible;
            anything still missing is filled in by Claude from the description if AI fill is enabled.
            If a date already has meals, you&apos;ll be asked what to do.
          </p>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="block w-full text-xs text-white/70 file:mr-3 file:rounded-lg file:border-0 file:bg-bg-elev file:px-3 file:py-2 file:text-xs file:text-white/80 file:font-medium"
        />

        <label className="flex items-center gap-2 text-xs text-white/70">
          <input
            type="checkbox"
            checked={useAi}
            onChange={(e) => setUseAi(e.target.checked)}
            className="accent-accent-brand"
          />
          Use Claude to fill rows where macros can&apos;t be derived
        </label>

        <div className="flex gap-3">
          <button
            onClick={runBackfillDryRun}
            disabled={backfillLoading}
            className="flex-1 rounded-xl border border-border bg-bg-elev py-3 text-sm font-medium disabled:opacity-40"
          >
            {backfillLoading && !backfillPreview ? "Analyzing…" : "Preview (dry run)"}
          </button>
          <button
            onClick={runBackfillCommit}
            disabled={backfillLoading || !backfillPreview || !conflictsResolved}
            className="flex-1 rounded-xl bg-accent-brand py-3 text-sm font-semibold disabled:opacity-40"
          >
            {backfillLoading && backfillPreview ? "Importing…" : "Import"}
          </button>
        </div>

        {backfillErr && <div className="text-sm text-red-400">{backfillErr}</div>}

        {backfillPreview && !backfillResult && (
          <div className="rounded-xl bg-bg-elev border border-border p-4 space-y-1.5 text-xs">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-accent-brand">Preview</div>
            <Row k="Total rows in file" v={String(backfillPreview.summary.totalRows)} />
            <Row k="Summary rows skipped" v={String(backfillPreview.summary.summaryRowsSkipped)} />
            <Row k="Importable rows" v={String(backfillPreview.summary.importableRows)} emphasize />
            <Row k="Dates in file" v={String(backfillPreview.summary.datesCount)} />
            <Row k="Dates already logged" v={String(backfillPreview.summary.conflictsCount)} />
            <Row k="Carbs derived from kcal" v={String(backfillPreview.summary.derivedCarbsCount)} />
            <Row k="Rows filled by Claude" v={String(backfillPreview.summary.aiFilledCount)} />
            <Row k="Still incomplete" v={String(backfillPreview.summary.incompleteRows)} />
            {backfillPreview.summary.errors?.length > 0 && (
              <div className="pt-2 text-[11px] text-red-300">
                {backfillPreview.summary.errors.length} parse error(s). First: {backfillPreview.summary.errors[0]?.message}
              </div>
            )}
          </div>
        )}

        {/* Conflict resolution dialog */}
        {backfillPreview && !backfillResult && conflicts.length > 0 && (
          <div className="rounded-xl bg-bg-elev border border-amber-500/40 p-4 space-y-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-300">
                {conflicts.length} date{conflicts.length === 1 ? "" : "s"} already have meals
              </div>
              <p className="text-[11px] text-white/60 mt-1 leading-relaxed">
                Decide what to do per date, or pick one option for all of them.
                <span className="block mt-1 text-white/40">
                  <b>Keep</b>: leave the existing meals alone, skip the CSV rows for that day.
                  <b> Replace</b>: delete the existing meals and insert the CSV rows.
                  <b> Merge</b>: add the CSV rows on top of the existing meals.
                </span>
              </p>
            </div>

            <div>
              <div className="text-[11px] text-white/50 mb-1.5">Apply to all conflicts:</div>
              <div className="grid grid-cols-3 gap-2">
                <PolicyBtn active={applyToAll === "keep"} onClick={() => setAll("keep")}>
                  Keep existing
                </PolicyBtn>
                <PolicyBtn active={applyToAll === "replace"} onClick={() => setAll("replace")}>
                  Replace
                </PolicyBtn>
                <PolicyBtn active={applyToAll === "merge"} onClick={() => setAll("merge")}>
                  Merge
                </PolicyBtn>
              </div>
              {applyToAll && (
                <button
                  onClick={() => {
                    setApplyToAll(null);
                    setResolutions({});
                  }}
                  className="mt-2 text-[10px] text-white/40 underline"
                >
                  Clear &amp; decide per date instead
                </button>
              )}
            </div>

            {!applyToAll && (
              <div className="space-y-2">
                {conflicts.map((c) => (
                  <div
                    key={c.date}
                    className="rounded-lg bg-bg-card border border-border p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-white/80">{c.date}</span>
                      <span className="text-[10px] text-white/40">
                        {c.existingCount} existing → {c.incomingCount} incoming
                      </span>
                    </div>
                    <div className="text-[10px] text-white/50 grid grid-cols-2 gap-2">
                      <div className="rounded-md bg-bg-elev p-1.5">
                        <div className="text-white/40">On file</div>
                        <div className="text-white/80">
                          {c.existingTotal.calories} kcal · {c.existingTotal.protein_g}P
                        </div>
                      </div>
                      <div className="rounded-md bg-bg-elev p-1.5">
                        <div className="text-white/40">Incoming</div>
                        <div className="text-white/80">
                          {c.incomingTotal.calories} kcal · {c.incomingTotal.protein_g}P
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <PolicyBtn small active={resolutions[c.date] === "keep"} onClick={() => setOne(c.date, "keep")}>
                        Keep
                      </PolicyBtn>
                      <PolicyBtn small active={resolutions[c.date] === "replace"} onClick={() => setOne(c.date, "replace")}>
                        Replace
                      </PolicyBtn>
                      <PolicyBtn small active={resolutions[c.date] === "merge"} onClick={() => setOne(c.date, "merge")}>
                        Merge
                      </PolicyBtn>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!conflictsResolved && (
              <div className="text-[11px] text-amber-300">
                Pick an action for every conflicting date, or use &quot;apply to all&quot;.
              </div>
            )}
          </div>
        )}

        {backfillResult && (
          <div className="rounded-xl bg-bg-elev border border-accent-brand/40 p-4 space-y-1.5 text-xs">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-accent-brand">Imported</div>
            <Row k="Rows inserted" v={String(backfillResult.summary.insertedCount ?? 0)} emphasize />
            <Row k="Existing rows replaced" v={String(backfillResult.summary.deletedRowsCount ?? 0)} />
            <Row k="Dates kept (skipped)" v={String(backfillResult.summary.keptDates ?? 0)} />
            <Row k="Dates replaced" v={String(backfillResult.summary.replacedDates ?? 0)} />
            <Row k="Dates merged" v={String(backfillResult.summary.mergedDates ?? 0)} />
            <Row k="Summary rows skipped" v={String(backfillResult.summary.summaryRowsSkipped)} />
            <Row k="Carbs derived" v={String(backfillResult.summary.derivedCarbsCount)} />
            <Row k="AI-filled" v={String(backfillResult.summary.aiFilledCount)} />
          </div>
        )}
      </section>
    </div>
  );
}

function toPayload(p: any) {
  return {
    age: Number(p.age),
    sex: p.sex,
    height_cm: Number(p.height_cm),
    weight_kg: Number(p.weight_kg),
    neck_cm: Number(p.neck_cm),
    waist_cm: Number(p.waist_cm),
    hips_cm: p.sex === "female" ? Number(p.hips_cm) : null,
    activity_level: p.activity_level,
    goal_mode: p.goal_mode ?? "recomp",
  };
}

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-white/60 mb-1.5">{label}</label>
      <input
        inputMode="decimal"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
        className="w-full rounded-xl bg-bg-elev border border-border px-4 py-3 text-[15px]"
      />
    </div>
  );
}
function SexBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl py-3 text-sm font-medium ${
        active ? "bg-accent-brand text-white" : "bg-bg-elev border border-border text-white/70"
      }`}
    >
      {children}
    </button>
  );
}
function PolicyBtn({
  active,
  onClick,
  children,
  small,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  small?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg ${small ? "py-1.5 text-[11px]" : "py-2 text-xs"} font-medium ${
        active
          ? "bg-accent-brand text-white"
          : "bg-bg-elev border border-border text-white/70"
      }`}
    >
      {children}
    </button>
  );
}
function Row({ k, v, emphasize }: { k: string; v: string; emphasize?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-sm text-white/60">{k}</span>
      <span className={emphasize ? "text-base font-semibold" : "text-sm"}>{v}</span>
    </div>
  );
}
