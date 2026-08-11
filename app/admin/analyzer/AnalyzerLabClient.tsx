"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { compressImageFile, compressImageThumb } from "@/lib/compress-image";
import {
  MACRO_KEYS,
  type MacroKey,
  type FixtureScore,
  type Aggregate,
} from "@/lib/analyzer-score";

// ---- types mirroring the API responses ----

type FixtureListItem = {
  id: string;
  label: string;
  mode: "photo" | "text";
  photo_thumb_base64: string | null;
  photo_mime: string | null;
  input_text: string | null;
  expected_calories: number;
  expected_protein_g: number;
  expected_fat_g: number;
  expected_carbs_g: number;
  notes: string | null;
  created_at: string;
};

type Config = {
  defaultModel: string;
  visionPrompt: string;
  textPrompt: string;
  models: { id: string; label: string }[];
};

type RunResponse = {
  scores: FixtureScore[];
  summary: Aggregate;
  ran: { model: string; withinPct: number; count: number; customPrompt: boolean };
};

const MACRO_LABEL: Record<MacroKey, string> = {
  calories: "kcal",
  protein_g: "P",
  fat_g: "F",
  carbs_g: "C",
};

const emptyExpected = { calories: "", protein_g: "", fat_g: "", carbs_g: "" };

export default function AnalyzerLabClient() {
  const [config, setConfig] = useState<Config | null>(null);
  const [fixtures, setFixtures] = useState<FixtureListItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // --- add-fixture form ---
  const [mode, setMode] = useState<"photo" | "text">("photo");
  const [label, setLabel] = useState("");
  const [inputText, setInputText] = useState("");
  const [expected, setExpected] = useState<Record<MacroKey, string>>({
    ...emptyExpected,
  });
  const [notes, setNotes] = useState("");
  const [photo, setPhoto] = useState<{
    base64: string;
    thumb: string;
    dataUri: string;
    mime: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  // --- run config ---
  const [model, setModel] = useState<string>("");
  const [systemVision, setSystemVision] = useState("");
  const [systemText, setSystemText] = useState("");
  const [promptTab, setPromptTab] = useState<"vision" | "text">("vision");
  const [withinPct, setWithinPct] = useState("15");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResponse | null>(null);

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
        setModel(c.defaultModel);
        setSystemVision(c.visionPrompt);
        setSystemText(c.textPrompt);
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
      setPhoto({
        base64: full.base64,
        thumb: thumb.dataUri,
        dataUri: full.dataUri,
        mime: "image/jpeg",
      });
    } catch {
      setErr("Could not read that image");
    }
  }

  function resetForm() {
    setLabel("");
    setInputText("");
    setExpected({ ...emptyExpected });
    setNotes("");
    setPhoto(null);
  }

  async function saveFixture() {
    setErr(null);
    if (!label.trim()) return setErr("Give the fixture a label");
    if (mode === "photo" && !photo) return setErr("Add a photo (or switch to text mode)");
    if (mode === "text" && !inputText.trim()) return setErr("Add a description for the text fixture");
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
          photo_mime: mode === "photo" ? photo?.mime : undefined,
          input_text: inputText.trim() || undefined,
          expected_calories: Number(expected.calories) || 0,
          expected_protein_g: Number(expected.protein_g) || 0,
          expected_fat_g: Number(expected.fat_g) || 0,
          expected_carbs_g: Number(expected.carbs_g) || 0,
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

  async function deleteFixture(id: string) {
    if (!confirm("Delete this fixture?")) return;
    try {
      const r = await fetch(`/api/admin/analyzer/fixtures?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error("delete failed");
      setSelected((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      await loadFixtures();
    } catch (e: any) {
      setErr(e?.message || "delete failed");
    }
  }

  function toggleSelected(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  async function run() {
    setErr(null);
    setResult(null);
    if (!fixtures?.length) return setErr("Add at least one fixture first");
    setRunning(true);
    try {
      const ids = selected.size ? Array.from(selected) : undefined;
      const r = await fetch("/api/admin/analyzer/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          systemVision: config && systemVision !== config.visionPrompt ? systemVision : undefined,
          systemText: config && systemText !== config.textPrompt ? systemText : undefined,
          fixtureIds: ids,
          withinPct: Number(withinPct) || 15,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "run failed");
      setResult(await r.json());
    } catch (e: any) {
      setErr(e?.message || "run failed");
    } finally {
      setRunning(false);
    }
  }

  const promptEdited = useMemo(
    () =>
      !!config &&
      (systemVision !== config.visionPrompt || systemText !== config.textPrompt),
    [config, systemVision, systemText],
  );

  return (
    <div className="p-4 space-y-6 max-w-5xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Analyzer Lab</h1>
          <p className="text-xs text-white/50">
            Admin-only eval harness for the meal analyzer.
          </p>
        </div>
        <Link href="/admin" className="text-sm text-accent-brand">
          ← Admin
        </Link>
      </header>

      {err && (
        <div className="rounded-lg bg-red-500/15 text-red-300 text-sm px-3 py-2">
          {err}
        </div>
      )}

      {/* ---------- ADD FIXTURE ---------- */}
      <section className="card p-4 space-y-3">
        <h2 className="font-semibold">Add test meal (ground truth)</h2>
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

        {mode === "photo" ? (
          <div className="flex items-center gap-3">
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photo.dataUri} alt="fixture" className="w-20 h-20 rounded-xl object-cover border border-border" />
            ) : (
              <div className="w-20 h-20 rounded-xl bg-bg-elev border border-dashed border-border" />
            )}
            <label className="text-sm text-accent-brand cursor-pointer">
              {photo ? "Replace photo" : "Upload photo"}
              <input type="file" accept="image/*" onChange={onPickPhoto} className="hidden" />
            </label>
          </div>
        ) : null}

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

        <div className="grid grid-cols-4 gap-2">
          {MACRO_KEYS.map((k) => (
            <label key={k} className="block">
              <span className="block text-[10px] uppercase tracking-wide text-white/40 mb-0.5">
                {MACRO_LABEL[k]}
              </span>
              <input
                type="number"
                value={expected[k]}
                onChange={(e) => setExpected((x) => ({ ...x, [k]: e.target.value }))}
                placeholder="0"
                className="w-full rounded-lg bg-bg-elev border border-border px-2 py-1.5 text-sm text-center"
              />
            </label>
          ))}
        </div>

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
          {saving ? "Saving…" : "Add fixture"}
        </button>
      </section>

      {/* ---------- FIXTURE LIST ---------- */}
      <section className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">
            Fixtures {fixtures ? `(${fixtures.length})` : ""}
          </h2>
          {fixtures && fixtures.length > 0 && (
            <button
              onClick={() =>
                setSelected((s) =>
                  s.size === fixtures.length ? new Set() : new Set(fixtures.map((f) => f.id)),
                )
              }
              className="text-xs text-accent-brand"
            >
              {selected.size === fixtures.length ? "Clear selection" : "Select all"}
            </button>
          )}
        </div>
        {!fixtures ? (
          <p className="text-sm text-white/40">Loading…</p>
        ) : fixtures.length === 0 ? (
          <p className="text-sm text-white/40">No fixtures yet. Add one above.</p>
        ) : (
          <ul className="space-y-2">
            {fixtures.map((f) => (
              <li key={f.id} className="flex items-center gap-3 rounded-lg bg-bg-elev p-2">
                <input
                  type="checkbox"
                  checked={selected.has(f.id)}
                  onChange={() => toggleSelected(f.id)}
                  className="shrink-0"
                />
                {f.photo_thumb_base64 ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={f.photo_thumb_base64}
                    alt=""
                    className="w-12 h-12 rounded-lg object-cover shrink-0"
                  />
                ) : (
                  <div className="w-12 h-12 rounded-lg bg-white/5 shrink-0 flex items-center justify-center text-[10px] text-white/40">
                    TEXT
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{f.label}</div>
                  <div className="text-[11px] text-white/45">
                    {f.expected_calories} kcal · P{f.expected_protein_g} · F{f.expected_fat_g} · C{f.expected_carbs_g}
                  </div>
                </div>
                <button
                  onClick={() => deleteFixture(f.id)}
                  className="text-xs text-red-400/80 shrink-0"
                >
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
        <div className="flex flex-wrap gap-3 items-end">
          <label className="block">
            <span className="block text-[11px] text-white/50 mb-1">Model</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-lg bg-bg-elev border border-border px-3 py-2 text-sm"
            >
              {config?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[11px] text-white/50 mb-1">Within %</span>
            <input
              type="number"
              value={withinPct}
              onChange={(e) => setWithinPct(e.target.value)}
              className="w-24 rounded-lg bg-bg-elev border border-border px-3 py-2 text-sm"
            />
          </label>
          <button
            onClick={run}
            disabled={running}
            className="rounded-full bg-accent-brand px-6 py-2.5 text-sm font-semibold disabled:opacity-40"
          >
            {running
              ? "Running…"
              : selected.size
                ? `Run ${selected.size} selected`
                : "Run all"}
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
            {promptEdited && (
              <span className="text-[10px] text-amber-400">edited</span>
            )}
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
              promptTab === "vision"
                ? setSystemVision(e.target.value)
                : setSystemText(e.target.value)
            }
            rows={8}
            spellCheck={false}
            className="w-full rounded-lg bg-bg-elev border border-border px-3 py-2 text-[11px] font-mono resize-y"
          />
        </div>
      </section>

      {/* ---------- RESULTS ---------- */}
      {result && <Results result={result} />}
    </div>
  );
}

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

function Results({ result }: { result: RunResponse }) {
  const { scores, summary, ran } = result;
  return (
    <section className="card p-4 space-y-4">
      <h2 className="font-semibold">
        Results · {ran.model}
        {ran.customPrompt && (
          <span className="text-amber-400 text-xs font-normal"> · custom prompt</span>
        )}
      </h2>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
        <div className="rounded-lg bg-bg-elev p-2">
          <div className="text-lg font-bold">{pct(summary.passRate)}</div>
          <div className="text-[10px] text-white/45">all-macros pass</div>
        </div>
        {MACRO_KEYS.map((k) => (
          <div key={k} className="rounded-lg bg-bg-elev p-2">
            <div className="text-lg font-bold">{pct(summary.perMacro[k].withinRate)}</div>
            <div className="text-[10px] text-white/45">
              {MACRO_LABEL[k]} within · {Math.round(summary.perMacro[k].mape)}% err
            </div>
          </div>
        ))}
      </div>
      {summary.errored > 0 && (
        <p className="text-xs text-amber-400">
          {summary.errored} fixture(s) failed to analyze.
        </p>
      )}

      {/* Per-fixture table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="text-white/40">
            <tr className="text-left">
              <th className="py-1 pr-2">Fixture</th>
              {MACRO_KEYS.map((k) => (
                <th key={k} className="py-1 px-2 text-center">
                  {MACRO_LABEL[k]}
                </th>
              ))}
              <th className="py-1 px-2 text-center">conf</th>
              <th className="py-1 px-2 text-center">ms</th>
            </tr>
          </thead>
          <tbody>
            {scores.map((s) => (
              <tr key={s.fixtureId} className="border-t border-border/50">
                <td className="py-1.5 pr-2 max-w-[10rem]">
                  <div className="truncate font-medium">{s.label}</div>
                  {s.error && <div className="text-red-400 text-[10px]">{s.error}</div>}
                </td>
                {MACRO_KEYS.map((k) => {
                  const cell = s.macros.find((m) => m.key === k);
                  if (!cell) return <td key={k} className="text-center text-white/25">—</td>;
                  return (
                    <td
                      key={k}
                      className={`py-1.5 px-2 text-center ${
                        cell.within ? "text-emerald-400" : "text-red-400"
                      }`}
                    >
                      <div className="nums">{Math.round(cell.predicted)}</div>
                      <div className="text-white/35 text-[9px]">
                        /{Math.round(cell.expected)} · {Math.round(cell.pctError)}%
                      </div>
                    </td>
                  );
                })}
                <td className="py-1.5 px-2 text-center text-white/50">{s.confidence ?? "—"}</td>
                <td className="py-1.5 px-2 text-center text-white/40">
                  {s.latencyMs ? Math.round(s.latencyMs) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
