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
  created_at: string;
};

type Config = {
  defaultModel: string;
  visionPrompt: string;
  textPrompt: string;
  models: { id: string; label: string }[];
};

type CellResult = {
  fixtureId: string;
  model: string;
  label: string;
  attempts: RunAttempt[];
  summary: CellSummary;
  accuracy: CellAccuracy | null;
  expected: Record<MacroKey, number> | null;
};

const MACRO_LABEL: Record<MacroKey, string> = {
  calories: "kcal",
  protein_g: "P",
  fat_g: "F",
  carbs_g: "C",
};

// Concurrent (fixture, model) cells. Each cell itself fires `runs` calls, so
// keep this low to avoid a burst of model requests.
const CELL_CONCURRENCY = 2;

const cellKey = (fixtureId: string, model: string) => `${fixtureId}::${model}`;

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

  // --- add-fixture form ---
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
  const [runs, setRuns] = useState("5");
  const [systemVision, setSystemVision] = useState("");
  const [systemText, setSystemText] = useState("");
  const [promptTab, setPromptTab] = useState<"vision" | "text">("vision");
  const [selectedFixtures, setSelectedFixtures] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<Map<string, CellResult>>(new Map());

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
        // Default to comparing the fast model against the production default.
        const fast = c.models[0]?.id;
        setModels(new Set([c.defaultModel, fast].filter(Boolean) as string[]));
      } catch (e: any) {
        setErr(e?.message || "config load failed");
      }
    })();
    loadFixtures();
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

  async function importN5k() {
    setErr(null);
    setImportMsg(null);
    setImporting(true);
    try {
      const r = await fetch("/api/admin/analyzer/import-n5k", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: Number(importCount) || 20, split: "test" }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "import failed");
      setImportMsg(`Imported ${j.imported} dishes · ${j.remaining} more available.`);
      await loadFixtures();
    } catch (e: any) {
      setErr(e?.message || "import failed");
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
      setSelectedFixtures((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
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

    const targetFixtures = selectedFixtures.size
      ? fixtures.filter((f) => selectedFixtures.has(f.id))
      : fixtures;
    const modelList = Array.from(models);
    const nRuns = Math.max(1, Math.min(8, Number(runs) || 5));

    // Build the full grid of (fixture, model) cells.
    const cells: { fixtureId: string; model: string }[] = [];
    for (const f of targetFixtures) {
      for (const m of modelList) cells.push({ fixtureId: f.id, model: m });
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
              runs: nRuns,
              systemVision:
                config && systemVision !== config.visionPrompt ? systemVision : undefined,
              systemText:
                config && systemText !== config.textPrompt ? systemText : undefined,
            }),
          });
          if (r.ok) {
            const cr: CellResult = await r.json();
            setResults((prev) => {
              const n = new Map(prev);
              n.set(cellKey(cell.fixtureId, cell.model), cr);
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
  }

  const promptEdited = useMemo(
    () => !!config && (systemVision !== config.visionPrompt || systemText !== config.textPrompt),
    [config, systemVision, systemText],
  );

  const modelLabel = (id: string) => config?.models.find((m) => m.id === id)?.label || id;

  // Fixtures that have at least one result, in list order.
  const resultFixtures = useMemo(() => {
    if (!fixtures) return [];
    return fixtures.filter((f) =>
      Array.from(models).some((m) => results.has(cellKey(f.id, m))),
    );
  }, [fixtures, models, results]);

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
            onClick={importN5k}
            disabled={importing}
            className="rounded-full bg-accent-brand px-5 py-2 text-sm font-semibold disabled:opacity-40"
          >
            {importing ? "Importing…" : "Import dishes"}
          </button>
          {importMsg && <span className="text-[11px] text-emerald-400">{importMsg}</span>}
        </div>
      </section>

      {/* ---------- ADD TEST MEAL ---------- */}
      <section className="card p-4 space-y-3">
        <h2 className="font-semibold">Add a test meal</h2>
        <p className="text-[11px] text-white/45 -mt-1">
          No macros to enter — just a photo or description. We measure how stable the AI’s answers are.
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
      </section>

      {/* ---------- FIXTURE LIST ---------- */}
      <section className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Test meals {fixtures ? `(${fixtures.length})` : ""}</h2>
          {fixtures && fixtures.length > 0 && (
            <button
              onClick={() =>
                setSelectedFixtures((s) =>
                  s.size === fixtures.length ? new Set() : new Set(fixtures.map((f) => f.id)),
                )
              }
              className="text-xs text-accent-brand"
            >
              {selectedFixtures.size === fixtures.length ? "Clear selection" : "Select all"}
            </button>
          )}
        </div>
        <p className="text-[11px] text-white/40 -mt-1">
          Leave all unchecked to run every meal, or check specific ones.
        </p>
        {!fixtures ? (
          <p className="text-sm text-white/40">Loading…</p>
        ) : fixtures.length === 0 ? (
          <p className="text-sm text-white/40">No test meals yet. Add one above.</p>
        ) : (
          <ul className="space-y-2">
            {fixtures.map((f) => (
              <li key={f.id} className="flex items-center gap-3 rounded-lg bg-bg-elev p-2">
                <input
                  type="checkbox"
                  checked={selectedFixtures.has(f.id)}
                  onChange={() => toggle(selectedFixtures, f.id, setSelectedFixtures)}
                  className="shrink-0"
                />
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
          </ul>
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
          <label className="block">
            <span className="block text-[11px] text-white/50 mb-1">Repeats each</span>
            <input
              type="number"
              min={1}
              max={8}
              value={runs}
              onChange={(e) => setRuns(e.target.value)}
              className="w-20 rounded-lg bg-bg-elev border border-border px-3 py-2 text-sm"
            />
          </label>
          <button
            onClick={run}
            disabled={running}
            className="rounded-full bg-accent-brand px-6 py-2.5 text-sm font-semibold disabled:opacity-40"
          >
            {running && progress
              ? `Running… ${progress.done}/${progress.total}`
              : "Run consistency check"}
          </button>
        </div>

        {/* Editable system prompts */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            {(["vision", "text"] as const).map((tabKey) => (
              <button
                key={tabKey}
                onClick={() => setPromptTab(tabKey)}
                className={`text-xs px-2.5 py-1 rounded-full ${
                  promptTab === tabKey ? "bg-white/15 text-white" : "text-white/45"
                }`}
              >
                {tabKey === "vision" ? "Vision prompt" : "Text prompt"}
              </button>
            ))}
            {promptEdited && <span className="text-[10px] text-amber-400">edited</span>}
            {promptEdited && config && (
              <button
                onClick={() => {
                  setSystemVision(config.visionPrompt);
                  setSystemText(config.textPrompt);
                }}
                className="text-[10px] text-accent-brand ml-auto"
              >
                Reset to production
              </button>
            )}
          </div>
          <textarea
            value={promptTab === "vision" ? systemVision : systemText}
            onChange={(e) =>
              promptTab === "vision" ? setSystemVision(e.target.value) : setSystemText(e.target.value)
            }
            rows={8}
            spellCheck={false}
            className="w-full rounded-lg bg-bg-elev border border-border px-3 py-2 text-[11px] font-mono resize-y"
          />
        </div>
      </section>

      {/* ---------- RESULTS ---------- */}
      {resultFixtures.length > 0 && (
        <section className="card p-4 space-y-5">
          <h2 className="font-semibold">Report</h2>
          <p className="text-[11px] text-white/45 -mt-2">
            Each cell shows the mean estimate and its jitter (CV%). Green ≤8% (tight),
            amber ≤15%, red above. Where a dish has known macros, accuracy vs that
            truth is scored too.
          </p>

          <AccuracyScorecard
            models={Array.from(models)}
            results={results}
            modelLabel={modelLabel}
          />

          {resultFixtures.map((f) => {
            const cells = Array.from(models)
              .map((m) => results.get(cellKey(f.id, m)))
              .filter((c): c is CellResult => !!c);
            const spread = crossModelSpread(cells.map((c) => c.summary.perMacro.calories.mean));
            return (
              <div key={f.id} className="space-y-2">
                <div className="flex items-center gap-2">
                  {f.photo_thumb_base64 && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={f.photo_thumb_base64} alt="" className="w-8 h-8 rounded object-cover" />
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
                        {MACRO_KEYS.map((k) => (
                          <th key={k} className="py-1 px-2 text-center">{MACRO_LABEL[k]}</th>
                        ))}
                        <th className="py-1 px-2 text-center">jitter</th>
                        <th className="py-1 px-2 text-center">ms</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cells.map((c) => (
                        <tr key={c.model} className="border-t border-border/50">
                          <td className="py-1.5 pr-2 font-medium">
                            {modelLabel(c.model)}
                            {c.summary.failedRuns > 0 && (
                              <span className="text-red-400 text-[9px]"> · {c.summary.failedRuns} failed</span>
                            )}
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
                                    className={`text-[9px] ${
                                      acc.within ? "text-emerald-400" : "text-red-400"
                                    }`}
                                    title={`truth ${Math.round(acc.expected)}`}
                                  >
                                    {acc.error >= 0 ? "+" : ""}
                                    {Math.round(acc.pctError)}% off
                                  </div>
                                )}
                              </td>
                            );
                          })}
                          <td className={`py-1.5 px-2 text-center font-semibold ${cvClass(c.summary.avgCv)}`}>
                            {Math.round(c.summary.avgCv)}%
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
 * Headline accuracy per model, across every dish that has known macros.
 * This is the number that answers "can I trust the analyzer, and can I switch
 * to the cheaper/faster model?" — hidden entirely when nothing scored.
 */
function AccuracyScorecard({
  models,
  results,
  modelLabel,
}: {
  models: string[];
  results: Map<string, CellResult>;
  modelLabel: (id: string) => string;
}) {
  const perModel = models
    .map((m) => {
      const cells = Array.from(results.values()).filter(
        (c) => c.model === m && c.accuracy,
      );
      if (cells.length === 0) return null;
      const agg = aggregateAccuracy(cells.map((c) => c.accuracy!));
      const meanLatency =
        cells.reduce((a, c) => a + c.summary.meanLatencyMs, 0) / cells.length;
      return { model: m, agg, meanLatency };
    })
    .filter(Boolean) as {
    model: string;
    agg: ReturnType<typeof aggregateAccuracy>;
    meanLatency: number;
  }[];

  if (perModel.length === 0) return null;

  return (
    <div className="rounded-xl border border-border p-3 space-y-2">
      <div className="text-[11px] uppercase tracking-wider text-white/50">
        Accuracy vs ground truth · {perModel[0].agg.n} dishes
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="text-white/40">
            <tr className="text-left">
              <th className="py-1 pr-2">Model</th>
              <th className="py-1 px-2 text-center">all-macro pass</th>
              <th className="py-1 px-2 text-center">avg error</th>
              {MACRO_KEYS.map((k) => (
                <th key={k} className="py-1 px-2 text-center">{MACRO_LABEL[k]} within</th>
              ))}
              <th className="py-1 px-2 text-center">ms</th>
            </tr>
          </thead>
          <tbody>
            {perModel.map(({ model, agg, meanLatency }) => (
              <tr key={model} className="border-t border-border/50">
                <td className="py-1.5 pr-2 font-medium">{modelLabel(model)}</td>
                <td className="py-1.5 px-2 text-center font-semibold">
                  {Math.round(agg.passRate * 100)}%
                </td>
                <td className={`py-1.5 px-2 text-center ${cvClass(agg.mape)}`}>
                  {Math.round(agg.mape)}%
                </td>
                {MACRO_KEYS.map((k) => (
                  <td key={k} className="py-1.5 px-2 text-center">
                    <div>{Math.round(agg.perMacro[k].withinRate * 100)}%</div>
                    {/* Mean signed error — a consistent sign means the model
                        systematically over- or under-estimates that macro. */}
                    <div className="text-[9px] text-white/35">
                      {agg.perMacro[k].bias >= 0 ? "+" : ""}
                      {Math.round(agg.perMacro[k].bias)} bias
                    </div>
                  </td>
                ))}
                <td className="py-1.5 px-2 text-center text-white/40">
                  {Math.round(meanLatency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
