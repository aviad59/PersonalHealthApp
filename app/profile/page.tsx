"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import { ACTIVITY_LABELS } from "@/lib/calc";
import WeightLogSection from "@/components/WeightLogSection";
import { useLang } from "@/components/LangProvider";
import { t, TKey, type TextSize, readTextSizeCookie, setTextSizeCookie, applyTextSize } from "@/lib/i18n";

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
  const lang = useLang();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [langSaving, setLangSaving] = useState(false);
  const [textSize, setTextSize] = useState<TextSize>("md");
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
    setTextSize(readTextSizeCookie());
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
      // Catch the common "female without hips" case up-front so we can
      // show a clear message instead of a server-side Zod "validation" error.
      if (profile.sex === "female" && !Number.isFinite(Number(profile.hips_cm))) {
        throw new Error(
          "Hips (cm) is required when sex is female — please fill it in.",
        );
      }
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toPayload(profile)),
      });
      const j = await res.json();
      if (!res.ok) {
        // Surface the offending field(s) from the server's Zod issues so
        // the user knows WHAT went wrong, not just "validation".
        if (j.error === "validation" && Array.isArray(j.issues) && j.issues.length) {
          const lines = j.issues
            .map((iss: any) => {
              const path = Array.isArray(iss.path) ? iss.path.join(".") : "";
              return `${path}: ${iss.message}`;
            })
            .join(" · ");
          throw new Error(lines || "validation");
        }
        throw new Error(j.error || "save failed");
      }
      setProfile(j.profile);
      setPreview(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  function changeTextSize(size: TextSize) {
    setTextSize(size);
    setTextSizeCookie(size);
    applyTextSize(size);
    window.dispatchEvent(new CustomEvent("textsizechange", { detail: size }));
  }

  async function setLanguage(newLang: "en" | "he") {
    setLangSaving(true);
    try {
      await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: newLang }),
      });
      window.dispatchEvent(new CustomEvent("langchange", { detail: newLang }));
    } finally {
      setLangSaving(false);
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

  if (loading) return <div className="p-6 text-white/60">{t(lang, "profile_saving")}</div>;

  if (!profile) {
    return (
      <div className="px-5 pt-10 md:max-w-3xl md:mx-auto">
        <h1 className="text-2xl font-bold mb-2">{t(lang, "profile_title")}</h1>
        <p className="text-sm text-white/60 mb-6">{t(lang, "profile_no_profile")}</p>
        <Link href="/onboarding" className="inline-block rounded-xl bg-accent-brand px-4 py-2 text-sm font-semibold">
          {t(lang, "profile_run_onboarding")}
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
    <div className="px-5 pt-6 pb-6 space-y-6 md:max-w-3xl md:mx-auto">
      <h1 className="text-2xl font-bold">{t(lang, "profile_title")}</h1>

      <CurrentUserCard />

      {/* Language toggle */}
      <section className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">{t(lang, "profile_language")}</h2>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setLanguage("en")}
            disabled={langSaving}
            className={`rounded-xl py-3 text-sm font-medium disabled:opacity-40 ${
              lang === "en" ? "bg-accent-brand text-white" : "bg-bg-elev border border-border text-white/70"
            }`}
          >
            English
          </button>
          <button
            onClick={() => setLanguage("he")}
            disabled={langSaving}
            className={`rounded-xl py-3 text-sm font-medium disabled:opacity-40 ${
              lang === "he" ? "bg-accent-brand text-white" : "bg-bg-elev border border-border text-white/70"
            }`}
          >
            עברית
          </button>
        </div>
        {langSaving && <p className="text-xs text-white/40">{t(lang, "profile_lang_saving")}</p>}
      </section>

      {/* Daily-insight push notifications */}
      <PushToggle lang={lang} />

      {/* Data export */}
      <section className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
          {t(lang, "profile_export_title")}
        </h2>
        <p className="text-xs text-white/55">{t(lang, "profile_export_desc")}</p>
        <div className="grid grid-cols-2 gap-2">
          <a
            href="/api/export?type=meals"
            download
            className="rounded-xl bg-bg-elev border border-border py-3 text-center text-sm font-medium text-white/80 hover:text-white"
          >
            {t(lang, "profile_export_meals")}
          </a>
          <a
            href="/api/export?type=weight"
            download
            className="rounded-xl bg-bg-elev border border-border py-3 text-center text-sm font-medium text-white/80 hover:text-white"
          >
            {t(lang, "profile_export_weight")}
          </a>
        </div>
      </section>

      {/* Text size picker */}
      <section className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">{t(lang, "profile_text_size")}</h2>
        <div className="grid grid-cols-3 gap-2">
          {(["sm", "md", "lg"] as const).map((size) => (
            <button
              key={size}
              onClick={() => changeTextSize(size)}
              className={`rounded-xl py-3 font-medium transition-colors ${
                textSize === size ? "bg-accent-brand text-white" : "bg-bg-elev border border-border text-white/70"
              } ${size === "sm" ? "text-sm" : size === "lg" ? "text-lg" : "text-base"}`}
            >
              {t(lang, `profile_text_${size}` as TKey)}
            </button>
          ))}
        </div>
      </section>

      <section className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">{t(lang, "profile_body_metrics")}</h2>
        <NumField label="Age" value={profile.age} onChange={(v) => update("age", v)} />
        <div>
          <label className="block text-xs font-medium text-white/60 mb-1.5">{t(lang, "profile_sex")}</label>
          <div className="grid grid-cols-2 gap-2">
            <SexBtn active={profile.sex === "male"} onClick={() => update("sex", "male")}>{t(lang, "profile_male")}</SexBtn>
            <SexBtn active={profile.sex === "female"} onClick={() => update("sex", "female")}>{t(lang, "profile_female")}</SexBtn>
          </div>
        </div>
        <NumField label={t(lang, "profile_height")} value={profile.height_cm} onChange={(v) => update("height_cm", v)} />
        <NumField label={t(lang, "profile_weight")} value={profile.weight_kg} onChange={(v) => update("weight_kg", v)} />
        <NumField label={t(lang, "profile_neck")} value={profile.neck_cm} onChange={(v) => update("neck_cm", v)} />
        <NumField label={t(lang, "profile_waist")} value={profile.waist_cm} onChange={(v) => update("waist_cm", v)} />
        {profile.sex === "female" && (
          <NumField label={t(lang, "profile_hips")} value={profile.hips_cm ?? ""} onChange={(v) => update("hips_cm", v)} />
        )}
        <div>
          <label className="block text-xs font-medium text-white/60 mb-1.5">{t(lang, "profile_activity")}</label>
          <select
            value={profile.activity_level}
            onChange={(e) => update("activity_level", e.target.value as ActivityKey)}
            className="w-full rounded-xl bg-bg-elev border border-border px-4 py-3 text-sm"
          >
            {(Object.keys(ACTIVITY_LABELS) as ActivityKey[]).map((k) => (
              <option key={k} value={k}>{t(lang, `act_${k}` as TKey)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-white/60 mb-1.5">{t(lang, "profile_goal_mode")}</label>
          <select
            value={profile.goal_mode ?? "recomp"}
            onChange={(e) => update("goal_mode", e.target.value)}
            className="w-full rounded-xl bg-bg-elev border border-border px-4 py-3 text-sm"
          >
            <option value="recomp">{t(lang, "goal_recomp")}</option>
            <option value="cut">{t(lang, "goal_cut")}</option>
            <option value="bulk">{t(lang, "goal_bulk")}</option>
            <option value="maintain">{t(lang, "goal_maintain")}</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-white/60 mb-1.5">
            {t(lang, "profile_workouts_per_week")}
          </label>
          <div className="grid grid-cols-7 gap-1.5">
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <button
                key={n}
                onClick={() => update("weekly_workout_target", n)}
                className={`rounded-lg py-2 text-sm font-medium ${
                  Number(profile.weekly_workout_target) === n
                    ? "bg-accent-brand text-white"
                    : "bg-bg-elev border border-border text-white/70"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-white/40 mt-1.5">
            {t(lang, "profile_workouts_note")}
          </div>
        </div>
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">{t(lang, "profile_current_goals")}</h2>
        <Row k={t(lang, "profile_body_fat")} v={profile.body_fat_pct ? `${profile.body_fat_pct}%` : "—"} />
        <Row k={t(lang, "profile_lean_mass")} v={profile.lean_mass_kg ? `${profile.lean_mass_kg} kg` : "—"} />
        <Row k="BMR" v={profile.bmr ? `${profile.bmr} kcal` : "—"} />
        <Row k="TDEE" v={profile.tdee ? `${profile.tdee} kcal` : "—"} />
        <div className="h-px bg-border my-1" />
        <Row k={t(lang, "macro_calories")} v={`${profile.goal_calories} kcal`} emphasize />
        <Row k={t(lang, "macro_protein")} v={`${profile.goal_protein_g} g`} emphasize />
        <Row k={t(lang, "macro_fat")} v={`${profile.goal_fat_g} g`} emphasize />
        <Row k={t(lang, "macro_carbs")} v={`${profile.goal_carbs_g} g`} emphasize />
        <Row k={t(lang, "profile_workouts_wk")} v={`${profile.weekly_workout_target}`} />
      </section>

      <WeightLogSection
        onProfileMaybeChanged={async () => {
          const r = await fetch("/api/profile", { cache: "no-store" });
          const j = await r.json();
          setProfile(j.profile);
        }}
      />

      {preview && (
        <section className="card p-5 space-y-3 border-accent-brand/40">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-accent-brand">{t(lang, "profile_new_targets")}</h2>
          <Row k={t(lang, "profile_body_fat")} v={`${preview.body_fat_pct}%`} />
          <Row k={t(lang, "profile_lean_mass")} v={`${preview.lean_mass_kg} kg`} />
          <Row k="TDEE" v={`${preview.tdee} kcal`} />
          <Row k={t(lang, "macro_calories")} v={`${preview.goal_calories} kcal`} emphasize />
          <Row k={t(lang, "macro_protein")} v={`${preview.goal_protein_g} g`} emphasize />
          <Row k={t(lang, "macro_fat")} v={`${preview.goal_fat_g} g`} emphasize />
          <Row k={t(lang, "macro_carbs")} v={`${preview.goal_carbs_g} g`} emphasize />
          <Row k={t(lang, "profile_workouts_wk")} v={`${preview.weekly_workout_target}`} />
        </section>
      )}

      {err && <div className="text-sm text-red-400">{err}</div>}

      <div className="flex gap-3">
        <button
          onClick={recalculate}
          className="flex-1 rounded-xl border border-border bg-bg-elev py-3 text-sm font-medium"
        >
          {t(lang, "profile_preview")}
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="flex-1 rounded-xl bg-accent-brand py-3 text-sm font-semibold disabled:opacity-40"
        >
          {saving ? t(lang, "profile_saving") : t(lang, "profile_save")}
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
  const wkt = Number(p.weekly_workout_target);
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
    weekly_workout_target: Number.isFinite(wkt) && wkt > 0 ? wkt : null,
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

/**
 * Shows which Google account is currently signed in and offers sign-out.
 * Reads the NextAuth session client-side (this page is "use client" and
 * consumes /api/profile, which is already user-scoped server-side via
 * the verified session, not anything passed through here).
 */
function CurrentUserCard() {
  const lang = useLang();
  const { data: session } = useSession();
  const name = session?.user?.name || session?.user?.email || "";

  return (
    <section className="card p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-full bg-bg-elev border border-border flex items-center justify-center text-sm font-semibold">
        {name ? name[0].toUpperCase() : "?"}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-white/40">
          {t(lang, "profile_signed_in")}
        </div>
        <div className="text-sm font-semibold truncate">{name || "—"}</div>
      </div>
      <button
        onClick={() => signOut({ callbackUrl: "/signin" })}
        className="text-xs font-medium text-accent-brand"
      >
        {t(lang, "profile_sign_out")}
      </button>
    </section>
  );
}

/**
 * Web Push opt-in. Asks the browser for notification permission, registers
 * the SW push subscription, and stores it server-side keyed to the user.
 * Once subscribed, the morning cron will send today's daily insight here.
 */
function PushToggle({ lang }: { lang: ReturnType<typeof useLang> }) {
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [subscribed, setSubscribed] = useState(false);
  const [deviceCount, setDeviceCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshDeviceCount() {
    try {
      const r = await fetch("/api/push/subscribe");
      const j = await r.json();
      if (typeof j.count === "number") setDeviceCount(j.count);
    } catch {
      // non-fatal
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const ok =
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    setSupported(ok);
    if (!ok) return;
    setPermission(Notification.permission);
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(!!sub))
      .catch(() => {});
    refreshDeviceCount();
  }, []);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      // 1. Ask permission.
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        setError(t(lang, "profile_push_denied"));
        return;
      }
      // 2. Fetch VAPID public key.
      const keyRes = await fetch("/api/push/vapid-public-key").then((r) => r.json());
      if (!keyRes?.key) {
        setError(t(lang, "profile_push_no_server_key"));
        return;
      }
      // 3. Subscribe via SW.
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // Browser docs and web-push docs both pass Uint8Array here, but
        // lib.dom.d.ts narrows the type to BufferSource over plain
        // ArrayBuffer. Cast through any to match real runtime behavior.
        applicationServerKey: urlBase64ToUint8Array(keyRes.key) as unknown as BufferSource,
      });
      // 4. Send to server.
      const json = sub.toJSON();
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
        }),
      });
      setSubscribed(true);
      await refreshDeviceCount();
    } catch (e: any) {
      setError(e?.message ?? "subscribe failed");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setSubscribed(false);
      await refreshDeviceCount();
    } catch (e: any) {
      setError(e?.message ?? "unsubscribe failed");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/push/test", { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.reason || j.error || `test failed (${r.status})`);
      }
    } catch (e: any) {
      setError(e?.message ?? "test failed");
    } finally {
      setBusy(false);
    }
  }

  async function fireMorning() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/insights/morning", { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || `morning failed (${r.status})`);
      }
    } catch (e: any) {
      setError(e?.message ?? "morning failed");
    } finally {
      setBusy(false);
    }
  }

  if (!supported) {
    return (
      <section className="card p-5 space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
          {t(lang, "profile_push_title")}
        </h2>
        <p className="text-xs text-white/50">{t(lang, "profile_push_not_supported")}</p>
      </section>
    );
  }

  return (
    <section className="card p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
            {t(lang, "profile_push_title")}
          </h2>
          <p className="text-xs text-white/55 mt-1.5 leading-snug">
            {t(lang, "profile_push_desc")}
          </p>
        </div>
        <button
          type="button"
          onClick={subscribed ? disable : enable}
          disabled={busy || permission === "denied"}
          className={`shrink-0 rounded-xl px-4 py-2 text-xs font-semibold transition-colors disabled:opacity-50 ${
            subscribed
              ? "bg-bg-elev border border-border text-white/70 hover:text-white"
              : "bg-accent-brand text-white"
          }`}
        >
          {busy
            ? "…"
            : subscribed
            ? t(lang, "profile_push_disable")
            : t(lang, "profile_push_enable")}
        </button>
      </div>
      {/* Per-device status — makes it obvious that each device (e.g. your
          phone) needs enabling separately, which is the usual reason a
          notification only lands on one device. */}
      <div className="flex items-center gap-2 text-[11px]">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            subscribed ? "bg-accent-cal" : "bg-white/25"
          }`}
        />
        <span className="text-white/60">
          {subscribed ? t(lang, "profile_push_this_on") : t(lang, "profile_push_this_off")}
          {deviceCount !== null && (
            <span className="text-white/40">
              {" · "}
              {deviceCount} {t(lang, "profile_push_devices")}
            </span>
          )}
        </span>
      </div>
      <p className="text-[11px] text-white/40 leading-snug">{t(lang, "profile_push_per_device")}</p>
      {permission === "denied" && (
        <p className="text-[11px] text-amber-400">{t(lang, "profile_push_denied")}</p>
      )}
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      {subscribed && (
        <div className="flex gap-2 pt-2 border-t border-border">
          <button
            type="button"
            onClick={sendTest}
            disabled={busy}
            className="flex-1 rounded-lg bg-bg-elev border border-border px-3 py-1.5 text-[11px] font-medium text-white/70 hover:text-white disabled:opacity-50"
          >
            {t(lang, "profile_push_test")}
          </button>
          <button
            type="button"
            onClick={fireMorning}
            disabled={busy}
            className="flex-1 rounded-lg bg-bg-elev border border-border px-3 py-1.5 text-[11px] font-medium text-white/70 hover:text-white disabled:opacity-50"
          >
            {t(lang, "profile_push_morning_now")}
          </button>
        </div>
      )}
    </section>
  );
}

/** Convert the VAPID base64url-encoded public key into the Uint8Array
 *  shape PushManager.subscribe expects. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = typeof window !== "undefined" ? window.atob(base64) : "";
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
