"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { compressImageFile, compressImageThumb } from "@/lib/compress-image";
import {
  MACRO_KEYS,
  crossModelSpread,
  aggregateAccuracy,
  type MacroKey,
  type RunAttempt,
  type CellSummary,
  type CellAccuracy,
} from "@/lib/analyzer-variance";

// ---- types ----

type FixtureListItem = {
  id: string;
  label: string;
  mode: "photo" | "text";
  photo_thumb_base64: string | null;
  input_text: string | null;
  notes: string | null;
  source: string | null;
  source_url: string | null;
  has_ground_truth: boolean;
  expected_calories: number;
  expected_protein_g: number;
  expected_fat_g: number;
  expected_carbs_g: number;
  expected_mass_g: number | null;
  created_at: string;
};

type Config = {
  defaultModel: string;
  visionPrompt: string;
  textPrompt: string;
  perceivePrompt: string;
  quantifyPrompt: string;
  models: { id: string; label: string }[];
};

type Pipeline = "single" | "two-stage";
const PIPELINES: { id: Pipeline; label: string; hint: string }[] = [
  {
    id: "single",
    label: "single call",
    hint: "One call sees the food and computes macros together (production today).",
  },
  {
    id: "two-stage",
    label: "two-stage",
    hint: "Stage 1 identifies items and portions; stage 2 turns that reading into macros.",
  },
];

type CellResult = {
  fixtureId: string;
  model: string;
  /** false = photo only; true = photo + its description. */
  includeText: boolean;
  pipeline: Pipeline;
  /** Stage-1 reading from the first repeat (two-stage runs only). */
  perception: { raw: string; parsed: any; latencyMs: number } | null;
  label: string;
  attempts: RunAttempt[];
  summary: CellSummary;
  accuracy: CellAccuracy | null;
  expected: Record<MacroKey, number> | null;
  expectedMass: number | null;
};

/** A persisted report, so results survive a reload and can be compared later. */
type SavedRun = {
  id: string;
  label: string;
  note: string | null;
  config: any;
  rows: ScoreRow[];
  cells?: any[];
  created_at: string;
};

/** One line of the accuracy scorecard: a model x pipeline x input config. */
type ScoreRow = {
  key: string;
  model: string;
  modelLabel: string;
  variant: string;
  pipeline: string;
  agg: ReturnType<typeof aggregateAccuracy>;
  meanLatency: number;
};

/** Which input variants to run — answers "does the description help?". */
type Variant = { includeText: boolean; label: string };
const VARIANTS: Variant[] = [
  { includeText: false, label: "photo only" },
  { includeText: true, label: "photo + text" },
];

const MACRO_LABEL: Record<MacroKey, string> = {
  calories: "kcal",
  protein_g: "P",
  fat_g: "F",
  carbs_g: "C",
};

// Concurrent (fixture, model) cells. Each cell itself fires `runs` calls, so
// keep this low to avoid a burst of model requests.
const CELL_CONCURRENCY = 2;

// The pool can hold hundreds of dishes; rendering every remote thumbnail would
// fire hundreds of image requests for a list nobody needs to scroll.
const LIST_PREVIEW = 40;

const cellKey = (
  fixtureId: string,
  model: string,
  includeText: boolean,
  pipeline: Pipeline,
) => `${fixtureId}::${model}::${includeText ? "txt" : "img"}::${pipeline}`;

/** Always-signed percentage, so over- vs under-estimate is never ambiguous. */
function signedPct(error: number, pctError: number): string {
  const sign = error >= 0 ? "+" : "−";
  return `${sign}${Math.round(pctError)}%`;
}

// Jitter coloring: a coefficient of variation under ~8% is tight, under ~15%
// is tolerable, above that the estimate is unstable.
function cvClass(cv: number) {
  if (cv <= 8) return "text-emerald-400";
  if (cv <= 15) return "text-amber-400";
  return "text-red-400";
}

export default function AnalyzerLabClient() {
  const [config, setConfig] = useState<Config | null>(null);
  const [fixtures, setFixtures] = useState<FixtureListItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // --- add-fixture form (collapsed by default; imports are the main path) ---
  const [addOpen, setAddOpen] = useState(false);
  const [mode, setMode] = useState<"photo" | "text">("photo");
  const [label, setLabel] = useState("");
  const [inputText, setInputText] = useState("");
  const [notes, setNotes] = useState("");
  const [photo, setPhoto] = useState<{ base64: string; thumb: string; dataUri: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // --- Nutrition5k import ---
  const [importCount, setImportCount] = useState("20");
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  // --- run config ---
  const [models, setModels] = useState<Set<string>>(new Set());
  // Which input variants to include in the run.
  const [variants, setVariants] = useState<Set<string>>(new Set(["img"]));
  // Which pipelines to run — selecting both A/Bs them head to head.
  const [pipelines, setPipelines] = useState<Set<Pipeline>>(new Set(["single"]));
  const [systemVision, setSystemVision] = useState("");
  const [systemText, setSystemText] = useState("");
  const [systemPerceive, setSystemPerceive] = useState("");
  const [systemQuantify, setSystemQuantify] = useState("");
  const [promptTab, setPromptTab] = useState<
    "vision" | "text" | "perceive" | "quantify"
  >("vision");
  // Fixture list collapsed by default once a set has been imported.
  const [listOpen, setListOpen] = useState(false);
  // How many dishes to sample at random for each run. Hand-picking from a
  // few hundred imported dishes was unusable; a count + random draw is both
  // easier and a less biased sample.
  const [sampleSize, setSampleSize] = useState("10");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<Map<string, CellResult>>(new Map());
  // --- saved run history ---
  const [runsList, setRunsList] = useState<SavedRun[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewingRun, setViewingRun] = useState<SavedRun | null>(null);
  const [savingRun, setSavingRun] = useState(false);

  async function loadRuns() {
    try {
      const r = await fetch("/api/admin/analyzer/runs", { cache: "no-store" });
      if (r.ok) setRunsList((await r.json()).runs);
    } catch {
      /* history is non-critical */
    }
  }

  async function loadFixtures() {
    try {
      const r = await fetch("/api/admin/analyzer/fixtures", { cache: "no-store" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "load failed");
      setFixtures((await r.json()).fixtures);
    } catch (e: any) {
      setErr(e?.message || "load failed");
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/admin/analyzer/config", { cache: "no-store" });
        if (!r.ok) throw new Error("config load failed");
        const c: Config = await r.json();
        setConfig(c);
        setSystemVision(c.visionPrompt);
        setSystemText(c.textPrompt);
        setSystemPerceive(c.perceivePrompt);
        setSystemQuantify(c.quantifyPrompt);
        // Default to comparing the fast model against the production default.
        const fast = c.models[0]?.id;
        setModels(new Set([c.defaultModel, fast].filter(Boolean) as string[]));
      } catch (e: any) {
        setErr(e?.message || "config load failed");
      }
    })();
    loadFixtures();
    loadRuns();
  }, []);

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const [full, thumb] = await Promise.all([
        compressImageFile(file),
        compressImageThumb(file),
      ]);
      setPhoto({ base64: full.base64, thumb: thumb.dataUri, dataUri: full.dataUri });
    } catch {
      setErr("Could not read that image");
    }
  }

  function resetForm() {
    setLabel("");
    setInputText("");
    setNotes("");
    setPhoto(null);
  }

  async function saveFixture() {
    setErr(null);
    if (!label.trim()) return setErr("Give the test meal a label");
    if (mode === "photo" && !photo) return setErr("Add a photo (or switch to text mode)");
    if (mode === "text" && !inputText.trim()) return setErr("Add a description for the text meal");
    setSaving(true);
    try {
      const r = await fetch("/api/admin/analyzer/fixtures", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: label.trim(),
          mode,
          photo_base64: mode === "photo" ? photo?.base64 : undefined,
          photo_thumb_base64: mode === "photo" ? photo?.thumb : undefined,
          photo_mime: mode === "photo" ? "image/jpeg" : undefined,
          input_text: inputText.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "save failed");
      resetForm();
      await loadFixtures();
    } catch (e: any) {
      setErr(e?.message || "save failed");
    } finally {
      setSaving(false);
    }
  }

  async function importN5k(all = false) {
    setErr(null);
    setImportMsg(null);
    setImporting(true);
    try {
      const r = await fetch("/api/admin/analyzer/import-n5k", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          all
            ? { all: true, split: "test" }
            : { count: Number(importCount) || 20, split: "test" },
        ),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "import failed");
      setImportMsg(
        `Imported ${j.imported} dishes${j.remaining ? ` · ${j.remaining} more available` : " · full split loaded"}.`,
      );
      await loadFixtures();
    } catch (e: any) {
      setErr(e?.message || "import failed");
    } finally {
      setImporting(false);
    }
  }

  /** Re-sync ground truth for dishes imported before mass was tracked. */
  async function backfillTruth() {
    setErr(null);
    setImporting(true);
    try {
      const r = await fetch("/api/admin/analyzer/import-n5k", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backfillOnly: true }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "backfill failed");
      setImportMsg(`Ground truth re-synced for ${j.backfilled} dishes.`);
      await loadFixtures();
    } catch (e: any) {
      setErr(e?.message || "backfill failed");
    } finally {
      setImporting(false);
    }
  }

  async function deleteFixture(id: string) {
    if (!confirm("Delete this test meal?")) return;
    try {
      const r = await fetch(`/api/admin/analyzer/fixtures?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error("delete failed");
      await loadFixtures();
    } catch (e: any) {
      setErr(e?.message || "delete failed");
    }
  }

  function toggle(set: Set<string>, id: string, setter: (s: Set<string>) => void) {
    const n = new Set(set);
    n.has(id) ? n.delete(id) : n.add(id);
    setter(n);
  }

  async function run() {
    setErr(null);
    if (!fixtures?.length) return setErr("Add at least one test meal first");
    if (!models.size) return setErr("Pick at least one model");

    // Draw a fresh random sample for this run. Every model/pipeline/variant
    // in the run sees the SAME dishes, so comparisons within a run are fair;
    // across runs the sample differs, which is why the dish ids are saved.
    const n = Math.max(1, Math.min(fixtures.length, Number(sampleSize) || 10));
    const shuffled = [...fixtures];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const targetFixtures = shuffled.slice(0, n);
    const modelList = Array.from(models);

    const variantList = VARIANTS.filter((v) =>
      variants.has(v.includeText ? "txt" : "img"),
    );
    if (variantList.length === 0) return setErr("Pick at least one input variant");

    const pipelineList = PIPELINES.filter((p) => pipelines.has(p.id));
    if (pipelineList.length === 0) return setErr("Pick at least one pipeline");

    // Full grid of (fixture × model × variant × pipeline) cells.
    const cells: {
      fixtureId: string;
      model: string;
      includeText: boolean;
      pipeline: Pipeline;
    }[] = [];
    for (const f of targetFixtures) {
      for (const m of modelList) {
        for (const v of variantList) {
          for (const p of pipelineList) {
            cells.push({
              fixtureId: f.id,
              model: m,
              includeText: v.includeText,
              pipeline: p.id,
            });
          }
        }
      }
    }

    setResults(new Map());
    setRunning(true);
    setProgress({ done: 0, total: cells.length });

    let done = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < cells.length) {
        const cell = cells[cursor++];
        try {
          const r = await fetch("/api/admin/analyzer/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              fixtureId: cell.fixtureId,
              model: cell.model,
              includeText: cell.includeText,
              pipeline: cell.pipeline,
              systemVision:
                config && systemVision !== config.visionPrompt ? systemVision : undefined,
              systemText:
                config && systemText !== config.textPrompt ? systemText : undefined,
              systemPerceive:
                config && systemPerceive !== config.perceivePrompt
                  ? systemPerceive
                  : undefined,
              systemQuantify:
                config && systemQuantify !== config.quantifyPrompt
                  ? systemQuantify
                  : undefined,
            }),
          });
          if (r.ok) {
            const cr: CellResult = await r.json();
            setResults((prev) => {
              const n = new Map(prev);
              n.set(
                cellKey(cell.fixtureId, cell.model, cell.includeText, cell.pipeline),
                cr,
              );
              return n;
            });
          }
        } catch {
          /* leave the cell missing; surfaced as a gap in the grid */
        } finally {
          done++;
          setProgress({ done, total: cells.length });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CELL_CONCURRENCY, cells.length) }, () => worker()),
    );
    setRunning(false);

    // Persist the finished report so it survives a reload and can be compared
    // against later prompt/model changes.
    setResults((finalResults) => {
      void saveRun(finalResults, {
        models: modelList,
        variants: variantList.map((v) => v.label),
        pipelines: pipelineList.map((p) => p.label),
        dishes: targetFixtures.length,
        dishIds: targetFixtures.map((f) => f.id),
        promptEdited,
      });
      return finalResults;
    });
  }

  /** Save a completed run's scorecard + per-dish cells to the history. */
  async function saveRun(finalResults: Map<string, CellResult>, config: any) {
    const rows = buildScoreRows(Array.from(models), finalResults, modelLabel);
    if (rows.length === 0) return;
    setSavingRun(true);
    try {
      // Strip raw model text — only what the report renders is kept.
      const cells = Array.from(finalResults.values()).map((c) => ({
        fixtureId: c.fixtureId,
        label: c.label,
        model: c.model,
        includeText: c.includeText,
        pipeline: c.pipeline,
        accuracy: c.accuracy,
        expected: c.expected,
        expectedMass: c.expectedMass,
        meanLatencyMs: c.summary.meanLatencyMs,
      }));
      const stamp = new Date().toLocaleString();
      await fetch("/api/admin/analyzer/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: `${config.dishes} dishes · ${stamp}`,
          config,
          rows,
          cells,
        }),
      });
      await loadRuns();
    } catch {
      /* saving history must never break the run */
    } finally {
      setSavingRun(false);
    }
  }

  async function deleteRun(id: string) {
    if (!confirm("Delete this saved report?")) return;
    await fetch(`/api/admin/analyzer/runs?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).catch(() => {});
    if (viewingRun?.id === id) setViewingRun(null);
    await loadRuns();
  }

  const promptEdited = useMemo(
    () =>
      !!config &&
      (systemVision !== config.visionPrompt ||
        systemText !== config.textPrompt ||
        systemPerceive !== config.perceivePrompt ||
        systemQuantify !== config.quantifyPrompt),
    [config, systemVision, systemText, systemPerceive, systemQuantify],
  );

  const PROMPT_TABS = [
    { id: "vision" as const, label: "Vision (single)", value: systemVision, set: setSystemVision },
    { id: "text" as const, label: "Text", value: systemText, set: setSystemText },
    { id: "perceive" as const, label: "① Perceive", value: systemPerceive, set: setSystemPerceive },
    { id: "quantify" as const, label: "② Quantify", value: systemQuantify, set: setSystemQuantify },
  ];
  const activeTab = PROMPT_TABS.find((t) => t.id === promptTab) ?? PROMPT_TABS[0];

  const modelLabel = (id: string) => config?.models.find((m) => m.id === id)?.label || id;

  const scoreRows = useMemo(
    () => buildScoreRows(Array.from(models), results, modelLabel),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [models, results, config],
  );

  // Fixtures that have at least one result, in list order.
  const resultFixtures = useMemo(() => {
    if (!fixtures) return [];
    const ids = new Set(Array.from(results.values()).map((c) => c.fixtureId));
    return fixtures.filter((f) => ids.has(f.id));
  }, [fixtures, results]);

  return (
    <div className="p-4 space-y-6 max-w-5xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Analyzer Lab</h1>
          <p className="text-xs text-white/50">
            Consistency checker — run the same meal repeatedly and see how much the estimate jitters.
          </p>
        </div>
        <Link href="/admin" className="text-sm text-accent-brand">
          ← Admin
        </Link>
      </header>

      {err && (
        <div className="rounded-lg bg-red-500/15 text-red-300 text-sm px-3 py-2">{err}</div>
      )}

      {/* ---------- IMPORT GROUND TRUTH ---------- */}
      <section className="card p-4 space-y-3">
        <h2 className="font-semibold">Import from Nutrition5k</h2>
        <p className="text-[11px] text-white/45 -mt-1">
          Google Research’s public dataset of real plated dishes weighed on a scale —
          so we know the true macros. Imports from the held-out <strong>test</strong> split
          (507 dishes with overhead photos). Photos stay in the public bucket and are
          fetched at run time, so importing costs no storage.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="block text-[11px] text-white/50 mb-1">Dishes</span>
            <input
              type="number"
              min={1}
              max={100}
              value={importCount}
              onChange={(e) => setImportCount(e.target.value)}
              className="w-24 rounded-lg bg-bg-elev border border-border px-3 py-2 text-sm"
            />
          </label>
          <button
            onClick={() => importN5k(false)}
            disabled={importing}
            className="rounded-full bg-accent-brand px-5 py-2 text-sm font-semibold disabled:opacity-40"
          >
            {importing ? "Importing…" : "Import dishes"}
          </button>
          <button
            onClick={() => importN5k(true)}
            disabled={importing}
            title="Load every eligible dish from the held-out test split into the pool"
            className="rounded-full border border-accent-brand/50 px-5 py-2 text-sm font-semibold text-accent-primary disabled:opacity-40"
          >
            Import all
          </button>
          <button
            onClick={backfillTruth}
            disabled={importing}
            title="Fill in ground-truth mass for dishes imported before mass was tracked"
            className="rounded-full border border-border px-4 py-2 text-xs text-white/70 disabled:opacity-40"
          >
            Re-sync truth
          </button>
          {importMsg && <span className="text-[11px] text-emerald-400">{importMsg}</span>}
        </div>
      </section>

      {/* ---------- ADD TEST MEAL (collapsible) ---------- */}
      <section className="card p-4 space-y-3">
        <button
          onClick={() => setAddOpen((v) => !v)}
          className="w-full flex items-center justify-between text-left"
        >
          <span className="font-semibold">Add a test meal manually</span>
          <span className="text-white/40 text-sm">{addOpen ? "▲" : "▼"}</span>
        </button>
        {addOpen && (
        <>
        <p className="text-[11px] text-white/45 -mt-1">
          No macros to enter — just a photo or description. Manual meals have no ground
          truth, so they’re measured for consistency only.
        </p>
        <div className="flex gap-2 text-sm">
          {(["photo", "text"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-3 py-1.5 rounded-full ${
                mode === m ? "bg-accent-brand text-white" : "bg-bg-elev text-white/60"
              }`}
            >
              {m === "photo" ? "Photo" : "Text"}
            </button>
          ))}
        </div>

        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Chicken & rice bowl)"
          className="w-full rounded-lg bg-bg-elev border border-border px-3 py-2 text-sm"
        />

        {mode === "photo" && (
          <div className="flex items-center gap-3">
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photo.dataUri} alt="test meal" className="w-20 h-20 rounded-xl object-cover border border-border" />
            ) : (
              <div className="w-20 h-20 rounded-xl bg-bg-elev border border-dashed border-border" />
            )}
            <label className="text-sm text-accent-brand cursor-pointer">
              {photo ? "Replace photo" : "Upload photo"}
              <input type="file" accept="image/*" onChange={onPickPhoto} className="hidden" />
            </label>
          </div>
        )}

        <textarea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={
            mode === "photo"
              ? "Optional note/context sent with the photo"
              : "Meal description (this is what gets analyzed)"
          }
          rows={2}
          className="w-full rounded-lg bg-bg-elev border border-border px-3 py-2 text-sm resize-none"
        />

        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          className="w-full rounded-lg bg-bg-elev border border-border px-3 py-2 text-sm"
        />

        <button
          onClick={saveFixture}
          disabled={saving}
          className="rounded-full bg-accent-brand px-5 py-2 text-sm font-semibold disabled:opacity-40"
        >
          {saving ? "Saving…" : "Add test meal"}
        </button>
        </>
        )}
      </section>

      {/* ---------- FIXTURE LIST ---------- */}
      <section className="card p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={() => setListOpen((v) => !v)}
            className="flex-1 flex items-center gap-2 text-left"
          >
            <span className="font-semibold">
              Test meals {fixtures ? `(${fixtures.length})` : ""}
            </span>
            <span className="text-white/40 text-sm ml-auto">{listOpen ? "▲" : "▼"}</span>
          </button>
        </div>
        {listOpen && (
        <>
        <p className="text-[11px] text-white/40 -mt-1">
          The full pool a run samples from. Each run draws its dishes at random —
          nothing to pick here.
        </p>
        {!fixtures ? (
          <p className="text-sm text-white/40">Loading…</p>
        ) : fixtures.length === 0 ? (
          <p className="text-sm text-white/40">No test meals yet. Add one above.</p>
        ) : (
          <ul className="space-y-2">
            {fixtures.slice(0, LIST_PREVIEW).map((f) => (
              <li key={f.id} className="flex items-center gap-3 rounded-lg bg-bg-elev p-2">
                {f.photo_thumb_base64 || f.source_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={f.photo_thumb_base64 || f.source_url!}
                    alt=""
                    loading="lazy"
                    className="w-12 h-12 rounded-lg object-cover shrink-0 bg-white/5"
                  />
                ) : (
                  <div className="w-12 h-12 rounded-lg bg-white/5 shrink-0 flex items-center justify-center text-[10px] text-white/40">
                    TEXT
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{f.label}</div>
                  {f.has_ground_truth ? (
                    <div className="text-[11px] text-emerald-400/80">
                      truth: {f.expected_calories} kcal · P{f.expected_protein_g} · F
                      {f.expected_fat_g} · C{f.expected_carbs_g}
                    </div>
                  ) : f.input_text ? (
                    <div className="text-[11px] text-white/45 truncate">{f.input_text}</div>
                  ) : (
                    <div className="text-[11px] text-white/35">no ground truth</div>
                  )}
                </div>
                <button onClick={() => deleteFixture(f.id)} className="text-xs text-red-400/80 shrink-0">
                  Delete
                </button>
              </li>
            ))}
            {fixtures.length > LIST_PREVIEW && (
              <li className="text-[11px] text-white/40 px-2 pt-1">
                …and {fixtures.length - LIST_PREVIEW} more in the pool.
              </li>
            )}
          </ul>
        )}
        </>
        )}
      </section>

      {/* ---------- RUN CONFIG ---------- */}
      <section className="card p-4 space-y-3">
        <h2 className="font-semibold">Run</h2>
        <div className="flex flex-wrap gap-4 items-end">
          <div>
            <span className="block text-[11px] text-white/50 mb-1">Models to compare</span>
            <div className="flex flex-wrap gap-2">
              {config?.models.map((m) => (
                <button
                  key={m.id}
                  onClick={() => toggle(models, m.id, setModels)}
                  className={`px-3 py-1.5 rounded-full text-xs ${
                    models.has(m.id) ? "bg-accent-brand text-white" : "bg-bg-elev text-white/55"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="block text-[11px] text-white/50 mb-1">Pipeline</span>
            <div className="flex flex-wrap gap-2">
              {PIPELINES.map((p) => (
                <button
                  key={p.id}
                  onClick={() =>
                    setPipelines((s) => {
                      const n = new Set(s);
                      n.has(p.id) ? n.delete(p.id) : n.add(p.id);
                      return n;
                    })
                  }
                  title={p.hint}
                  className={`px-3 py-1.5 rounded-full text-xs ${
                    pipelines.has(p.id)
                      ? "bg-accent-brand text-white"
                      : "bg-bg-elev text-white/55"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="block text-[11px] text-white/50 mb-1">Input variant</span>
            <div className="flex flex-wrap gap-2">
              {VARIANTS.map((v) => {
                const key = v.includeText ? "txt" : "img";
                return (
                  <button
                    key={key}
                    onClick={() => toggle(variants, key, setVariants)}
                    className={`px-3 py-1.5 rounded-full text-xs ${
                      variants.has(key) ? "bg-accent-brand text-white" : "bg-bg-elev text-white/55"
                    }`}
                    title={
                      v.includeText
                        ? "Send the photo together with its description"
                        : "Send the photo alone, no text context"
                    }
                  >
                    {v.label}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="block">
            <span className="block text-[11px] text-white/50 mb-1">Dishes (random)</span>
            <input
              type="number"
              min={1}
              max={fixtures?.length || 500}
              value={sampleSize}
              onChange={(e) => setSampleSize(e.target.value)}
              className="w-24 rounded-lg bg-bg-elev border border-border px-3 py-2 text-sm"
            />
          </label>
          <button
            onClick={run}
            disabled={running}
            className="rounded-full bg-accent-brand px-6 py-2.5 text-sm font-semibold disabled:opacity-40"
          >
            {running && progress
              ? `Running… ${progress.done}/${progress.total}`
              : `Run on ${Math.min(Number(sampleSize) || 10, fixtures?.length || 0)} random dishes`}
          </button>
        </div>

        {/* Editable system prompts */}
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            {PROMPT_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setPromptTab(tab.id)}
                className={`text-xs px-2.5 py-1 rounded-full ${
                  promptTab === tab.id ? "bg-white/15 text-white" : "text-white/45"
                }`}
              >
                {tab.label}
              </button>
            ))}
            {promptEdited && <span className="text-[10px] text-amber-400">edited</span>}
            {promptEdited && config && (
              <button
                onClick={() => {
                  setSystemVision(config.visionPrompt);
                  setSystemText(config.textPrompt);
                  setSystemPerceive(config.perceivePrompt);
                  setSystemQuantify(config.quantifyPrompt);
                }}
                className="text-[10px] text-accent-brand ml-auto"
              >
                Reset all to production
              </button>
            )}
          </div>
          <p className="text-[10px] text-white/40 mb-1">
            {promptTab === "perceive"
              ? "Stage 1 of the two-stage pipeline — identifies items and portions, no macros."
              : promptTab === "quantify"
                ? "Stage 2 of the two-stage pipeline — turns stage 1's reading into macros."
                : promptTab === "vision"
                  ? "Used by the single-call pipeline for photos."
                  : "Used for text-only meals."}
          </p>
          <textarea
            value={activeTab.value}
            onChange={(e) => activeTab.set(e.target.value)}
            rows={10}
            spellCheck={false}
            className="w-full rounded-lg bg-bg-elev border border-border px-3 py-2 text-[11px] font-mono resize-y"
          />
        </div>
      </section>

      {/* ---------- SAVED REPORTS ---------- */}
      <section className="card p-4 space-y-3">
        <button
          onClick={() => setHistoryOpen((v) => !v)}
          className="w-full flex items-center gap-2 text-left"
        >
          <span className="font-semibold">
            Saved reports {runsList ? `(${runsList.length})` : ""}
          </span>
          {savingRun && <span className="text-[10px] text-accent-primary">saving…</span>}
          {viewingRun && (
            <span className="text-[10px] text-amber-400">viewing a saved report</span>
          )}
          <span className="text-white/40 text-sm ml-auto">{historyOpen ? "▲" : "▼"}</span>
        </button>
        {historyOpen && (
          <>
            <p className="text-[11px] text-white/40 -mt-1">
              Every run is saved automatically, so reports are never lost and prompt
              changes can be compared over time.
            </p>
            {viewingRun && (
              <button
                onClick={() => setViewingRun(null)}
                className="text-xs text-accent-brand"
              >
                ← Back to the latest run
              </button>
            )}
            {!runsList?.length ? (
              <p className="text-sm text-white/40">No saved reports yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {runsList.map((r) => {
                  const best = r.rows?.length
                    ? r.rows.reduce((a, b) => (b.agg.mape < a.agg.mape ? b : a))
                    : null;
                  return (
                    <li
                      key={r.id}
                      className="flex items-center gap-3 rounded-lg bg-bg-elev p-2 text-[12px]"
                    >
                      <button
                        onClick={() => setViewingRun(r)}
                        className="flex-1 min-w-0 text-left"
                      >
                        <div className="truncate font-medium">{r.label}</div>
                        <div className="text-[10px] text-white/45">
                          {best
                            ? `best ${Math.round(best.agg.mape)}% · ${best.modelLabel} · ${best.pipeline} · ${best.variant}`
                            : "no scored dishes"}
                        </div>
                      </button>
                      <button
                        onClick={() => deleteRun(r.id)}
                        className="text-[11px] text-red-400/80 shrink-0"
                      >
                        Delete
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>

      {/* ---------- HEADLINE SUMMARY (updates live during a run) ---------- */}
      {viewingRun ? (
        <AccuracyScorecard
          rows={viewingRun.rows}
          title={`Saved · ${viewingRun.label}`}
        />
      ) : (
        <AccuracyScorecard rows={scoreRows} running={running} />
      )}

      {/* ---------- PER-DISH RESULTS ---------- */}
      {resultFixtures.length > 0 && (
        <section className="card p-4 space-y-5">
          <h2 className="font-semibold">Per-dish detail</h2>
          <p className="text-[11px] text-white/45 -mt-2">
            <strong className="text-white/70">mean</strong> is the average estimate ·{" "}
            <strong className="text-white/70">±n%</strong> is jitter (how much the answer
            wobbles across repeats) ·{" "}
            <strong className="text-white/70">+/−n% vs truth</strong> is the error against
            the known value, signed (+ = over-estimate).
          </p>

          {resultFixtures.map((f) => {
            const cells = Array.from(models)
              .flatMap((m) =>
                VARIANTS.flatMap((v) =>
                  PIPELINES.map((p) =>
                    results.get(cellKey(f.id, m, v.includeText, p.id)),
                  ),
                ),
              )
              .filter((c): c is CellResult => !!c);
            const spread = crossModelSpread(cells.map((c) => c.summary.perMacro.calories.mean));
            return (
              <div key={f.id} className="space-y-2">
                <div className="flex items-center gap-2">
                  {(f.photo_thumb_base64 || f.source_url) && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={f.photo_thumb_base64 || f.source_url!}
                      alt=""
                      loading="lazy"
                      className="w-8 h-8 rounded object-cover bg-white/5"
                    />
                  )}
                  <span className="text-sm font-medium">{f.label}</span>
                  {cells[0]?.expected && (
                    <span className="text-[10px] text-emerald-400/80 shrink-0">
                      truth {Math.round(cells[0].expected.calories)} kcal
                    </span>
                  )}
                  {cells.length > 1 && (
                    <span
                      className={`text-[10px] ml-auto ${
                        spread.spreadPct <= 15 ? "text-emerald-400" : "text-amber-400"
                      }`}
                    >
                      model agreement: {Math.round(spread.spreadPct)}% spread on kcal
                    </span>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead className="text-white/40">
                      <tr className="text-left">
                        <th className="py-1 pr-2">Model</th>
                        <th className="py-1 px-2">Pipeline</th>
                        <th className="py-1 px-2">Input</th>
                        {MACRO_KEYS.map((k) => (
                          <th key={k} className="py-1 px-2 text-center">{MACRO_LABEL[k]}</th>
                        ))}
                        <th className="py-1 px-2 text-center">mass</th>
                        <th className="py-1 px-2 text-center">ms</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Ground truth as its own row, so every estimate below can
                          be compared against it directly instead of by tooltip. */}
                      {cells[0]?.expected && (
                        <tr className="border-t border-border/50 text-emerald-400/90">
                          <td className="py-1.5 pr-2 font-medium">truth</td>
                          <td className="py-1.5 px-2 text-white/30">—</td>
                          <td className="py-1.5 px-2 text-white/30">—</td>
                          {MACRO_KEYS.map((k) => (
                            <td key={k} className="py-1.5 px-2 text-center nums">
                              {Math.round(cells[0].expected![k])}
                            </td>
                          ))}
                          <td className="py-1.5 px-2 text-center nums">
                            {cells[0].expectedMass ? `${Math.round(cells[0].expectedMass)} g` : "—"}
                          </td>
                          <td className="py-1.5 px-2 text-center text-white/30">—</td>
                        </tr>
                      )}
                      {cells.map((c) => (
                        <tr
                          key={`${c.model}-${c.includeText}-${c.pipeline}`}
                          className="border-t border-border/50"
                        >
                          <td className="py-1.5 pr-2 font-medium">
                            {modelLabel(c.model)}
                            {c.summary.failedRuns > 0 && (
                              <span className="text-red-400 text-[9px]"> · {c.summary.failedRuns} failed</span>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-[10px]">
                            <span
                              className={
                                c.pipeline === "two-stage"
                                  ? "text-accent-primary"
                                  : "text-white/45"
                              }
                            >
                              {c.pipeline === "two-stage" ? "two-stage" : "single"}
                            </span>
                            {c.perception?.parsed?.items && (
                              // Surface stage 1's mass estimate — per the
                              // Nutrition5k paper, portion size is where nearly
                              // all the error lives, so it's the number to watch.
                              <span
                                className="block text-[9px] text-white/35 max-w-[9rem] truncate"
                                title={c.perception.parsed.items
                                  .map(
                                    (i: any) =>
                                      `${i.name} — ${i.mass_g ?? "?"}g (${i.dimensions_cm ?? "?"})`,
                                  )
                                  .join("\n")}
                              >
                                {c.perception.parsed.items.length} items
                                {c.perception.parsed.total_mass_g
                                  ? ` · ${Math.round(c.perception.parsed.total_mass_g)}g`
                                  : ""}
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-[10px] text-white/45">
                            {c.includeText ? "photo + text" : "photo only"}
                          </td>
                          {MACRO_KEYS.map((k) => {
                            const s = c.summary.perMacro[k];
                            const acc = c.accuracy?.perMacro[k];
                            return (
                              <td key={k} className="py-1.5 px-2 text-center">
                                <div className="nums">{Math.round(s.mean)}</div>
                                <div className={`text-[9px] ${cvClass(s.cv)}`}>±{Math.round(s.cv)}%</div>
                                {acc && (
                                  <div
                                    className={`text-[9px] font-medium ${
                                      acc.within ? "text-emerald-400" : "text-red-400"
                                    }`}
                                    title={`predicted ${acc.predicted.toFixed(1)} vs truth ${acc.expected.toFixed(1)}`}
                                  >
                                    {signedPct(acc.error, acc.pctError)}
                                  </div>
                                )}
                              </td>
                            );
                          })}
                          <td className="py-1.5 px-2 text-center">
                            {c.accuracy?.mass ? (
                              <>
                                <div className="nums">
                                  {Math.round(c.accuracy.mass.predicted)} g
                                </div>
                                <div
                                  className={`text-[9px] font-medium ${
                                    c.accuracy.mass.within ? "text-emerald-400" : "text-red-400"
                                  }`}
                                >
                                  {signedPct(c.accuracy.mass.error, c.accuracy.mass.pctError)}
                                </div>
                              </>
                            ) : (
                              <span className="text-white/25">—</span>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-center text-white/40">
                            {Math.round(c.summary.meanLatencyMs)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

/**
 * Headline accuracy, per model × input variant, across every dish with known
 * macros. This is the number that answers "can I trust the analyzer, does the
 * description help, and can I drop to the faster model?" It renders live while
 * a run is in flight so the picture fills in as cells land.
 */
/** Build scorecard rows from live cells. Shared by the live view and the
 *  persisted run history so both render identically. */
function buildScoreRows(
  models: string[],
  results: Map<string, CellResult>,
  modelLabel: (id: string) => string,
): ScoreRow[] {
  return models
    .flatMap((m) =>
      VARIANTS.flatMap((v) =>
        PIPELINES.map((p) => {
          const cells = Array.from(results.values()).filter(
            (c) =>
              c.model === m &&
              c.includeText === v.includeText &&
              c.pipeline === p.id &&
              c.accuracy,
          );
          if (cells.length === 0) return null;
          return {
            key: `${m}-${v.includeText}-${p.id}`,
            model: m,
            modelLabel: modelLabel(m),
            variant: v.label,
            pipeline: p.label,
            agg: aggregateAccuracy(cells.map((c) => c.accuracy!)),
            meanLatency:
              cells.reduce((a, c) => a + c.summary.meanLatencyMs, 0) / cells.length,
          };
        }),
      ),
    )
    .filter(Boolean) as ScoreRow[];
}

function AccuracyScorecard({
  rows,
  running,
  title,
}: {
  rows: ScoreRow[];
  running?: boolean;
  title?: string;
}) {
  if (rows.length === 0) return null;

  // Best = lowest average error. Highlighted so the winner is obvious at a glance.
  const best = rows.reduce((a, b) => (b.agg.mape < a.agg.mape ? b : a));

  return (
    <section className="rounded-2xl border border-accent-brand/40 bg-accent-brand/10 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold">
          {title ?? "Accuracy vs truth"}
          <span className="ml-2 text-[11px] font-normal text-white/55">
            {rows[0].agg.n} dish{rows[0].agg.n === 1 ? "" : "es"} scored
          </span>
        </h2>
        {running && (
          <span className="text-[11px] text-accent-primary animate-pulse">updating…</span>
        )}
      </div>

      {/* Big headline tiles for the leading configuration. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="rounded-xl bg-black/30 p-3 text-center">
          <div className="text-2xl font-extrabold tabular-nums">
            {Math.round(best.agg.mape)}%
          </div>
          <div className="text-[10px] text-white/55 mt-0.5">avg error (best)</div>
        </div>
        <div className="rounded-xl bg-black/30 p-3 text-center">
          <div className="text-2xl font-extrabold tabular-nums">
            {Math.round(best.agg.perMacro.calories.withinRate * 100)}%
          </div>
          <div className="text-[10px] text-white/55 mt-0.5">kcal within 15%</div>
        </div>
        <div className="rounded-xl bg-black/30 p-3 text-center">
          <div className="text-2xl font-extrabold tabular-nums">
            {best.agg.perMacro.calories.bias >= 0 ? "+" : "−"}
            {Math.abs(Math.round(best.agg.perMacro.calories.bias))}
          </div>
          <div className="text-[10px] text-white/55 mt-0.5">kcal bias</div>
        </div>
        <div className="rounded-xl bg-black/30 p-3 text-center">
          <div className="text-sm font-bold leading-tight mt-1">
            {best.modelLabel}
          </div>
          <div className="text-[10px] text-white/55 mt-0.5">
            {best.pipeline} · {best.variant}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="text-white/50">
            <tr className="text-left">
              <th className="py-1 pr-2">Model</th>
              <th className="py-1 px-2">Pipeline</th>
              <th className="py-1 px-2">Input</th>
              <th className="py-1 px-2 text-center">avg error</th>
              <th className="py-1 px-2 text-center">all-macro pass</th>
              {MACRO_KEYS.map((k) => (
                <th key={k} className="py-1 px-2 text-center">{MACRO_LABEL[k]}</th>
              ))}
              <th className="py-1 px-2 text-center">mass</th>
              <th className="py-1 px-2 text-center">ms</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className={`border-t border-white/10 ${
                  r.key === best.key ? "bg-white/10 font-medium" : ""
                }`}
              >
                <td className="py-2 pr-2">{r.modelLabel}</td>
                <td
                  className={`py-2 px-2 ${
                    r.pipeline === "two-stage" ? "text-accent-primary" : "text-white/60"
                  }`}
                >
                  {r.pipeline}
                </td>
                <td className="py-2 px-2 text-white/60">{r.variant}</td>
                <td className={`py-2 px-2 text-center font-bold ${cvClass(r.agg.mape)}`}>
                  {Math.round(r.agg.mape)}%
                </td>
                <td className="py-2 px-2 text-center">
                  {Math.round(r.agg.passRate * 100)}%
                </td>
                {MACRO_KEYS.map((k) => (
                  <td key={k} className="py-2 px-2 text-center">
                    <div>{Math.round(r.agg.perMacro[k].withinRate * 100)}%</div>
                    {/* Mean signed error — a consistent sign means the model
                        systematically over- or under-estimates that macro. */}
                    <div className="text-[9px] text-white/40">
                      {r.agg.perMacro[k].bias >= 0 ? "+" : "−"}
                      {Math.abs(Math.round(r.agg.perMacro[k].bias))} bias
                    </div>
                  </td>
                ))}
                <td className="py-2 px-2 text-center">
                  {r.agg.mass ? (
                    <>
                      <div className={cvClass(r.agg.mass.mape)}>
                        {Math.round(r.agg.mass.mape)}%
                      </div>
                      <div className="text-[9px] text-white/40">
                        {r.agg.mass.bias >= 0 ? "+" : "−"}
                        {Math.abs(Math.round(r.agg.mass.bias))} g bias
                      </div>
                    </>
                  ) : (
                    <span className="text-white/25">—</span>
                  )}
                </td>
                <td className="py-2 px-2 text-center text-white/45">
                  {Math.round(r.meanLatency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-white/45">
        avg error = mean absolute % off across the scored macros (macros too small
        for a percentage to be meaningful are skipped) · bias = mean signed error
        (+ over-estimates, − under-estimates) · mass = portion-size error, the
        Nutrition5k paper's key diagnostic.
      </p>
    </section>
  );
}
