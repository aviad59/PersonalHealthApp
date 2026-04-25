"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Analysis = {
  description: string;
  items: {
    name: string;
    portion: string;
    calories: number;
    protein_g: number;
    fat_g: number;
    carbs_g: number;
  }[];
  total: { calories: number; protein_g: number; fat_g: number; carbs_g: number };
  confidence: "low" | "medium" | "high";
  notes?: string;
};

type FrequentMeal = {
  description: string;
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  count: number;
  last_date: string;
};

export default function LogMealPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [photoExt, setPhotoExt] = useState<string>("jpg");
  const [text, setText] = useState(""); // description/hint/context

  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [editing, setEditing] = useState<{
    calories: number;
    protein_g: number;
    fat_g: number;
    carbs_g: number;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tip, setTip] = useState<string | null>(null);

  // Frequent meals state
  const [frequent, setFrequent] = useState<FrequentMeal[]>([]);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [modifier, setModifier] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/meals/frequent", { cache: "no-store" });
        const j = await r.json();
        setFrequent(j.meals || []);
      } catch {
        // non-fatal
      }
    })();
  }, []);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr(null);
    setAnalysis(null);
    setEditing(null);
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      setPhotoPreview(url);
      const match = url.match(/^data:(.+);base64,(.*)$/);
      if (match) {
        setPhotoBase64(match[2]);
        const mt = match[1];
        setPhotoExt(mt.includes("png") ? "png" : mt.includes("webp") ? "webp" : "jpg");
      }
    };
    reader.readAsDataURL(f);
  }

  function clearPhoto() {
    setPhotoPreview(null);
    setPhotoBase64(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function analyze() {
    const hasPhoto = !!fileRef.current?.files?.[0];
    const hasText = !!text.trim();
    if (!hasPhoto && !hasText) {
      setErr("Add a photo or a description");
      return;
    }
    setAnalyzing(true);
    setErr(null);
    try {
      const fd = new FormData();
      if (hasPhoto) fd.append("photo", fileRef.current!.files![0]);
      if (hasText) {
        // When a photo is present, text is context; otherwise text is the description.
        fd.append(hasPhoto ? "hint" : "text", text.trim());
      }
      const res = await fetch("/api/meals/analyze", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "analyze failed");
      setAnalysis(j.analysis as Analysis);
      setEditing({
        calories: j.analysis.total.calories,
        protein_g: j.analysis.total.protein_g,
        fat_g: j.analysis.total.fat_g,
        carbs_g: j.analysis.total.carbs_g,
      });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setAnalyzing(false);
    }
  }

  async function save() {
    if (!analysis || !editing) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/meals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: analysis.description,
          calories: editing.calories,
          protein_g: editing.protein_g,
          fat_g: editing.fat_g,
          carbs_g: editing.carbs_g,
          items: analysis.items,
          confidence: analysis.confidence,
          photo_base64: photoBase64 ?? undefined,
          photo_ext: photoExt,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "save failed");
      setTip(j.ai_tip || null);
      setTimeout(() => {
        router.push("/");
        router.refresh();
      }, 2000);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  /** Frequent meal quick-log. If modifier is blank, saves directly with remembered macros.
   *  Otherwise calls Claude to adjust the base meal by the modifier, then saves. */
  async function quickLog(meal: FrequentMeal, modifierText: string) {
    setQuickBusy(true);
    setErr(null);
    try {
      let toSave = {
        description: meal.description,
        calories: meal.calories,
        protein_g: meal.protein_g,
        fat_g: meal.fat_g,
        carbs_g: meal.carbs_g,
        items: undefined as any,
        confidence: "medium" as string,
      };

      const mod = modifierText.trim();
      if (mod) {
        const fd = new FormData();
        fd.append(
          "base",
          JSON.stringify({
            description: meal.description,
            calories: meal.calories,
            protein_g: meal.protein_g,
            fat_g: meal.fat_g,
            carbs_g: meal.carbs_g,
          }),
        );
        fd.append("text", mod);
        const a = await fetch("/api/meals/analyze", { method: "POST", body: fd });
        const aj = await a.json();
        if (!a.ok) throw new Error(aj.error || "analyze failed");
        toSave = {
          description: aj.analysis.description,
          calories: aj.analysis.total.calories,
          protein_g: aj.analysis.total.protein_g,
          fat_g: aj.analysis.total.fat_g,
          carbs_g: aj.analysis.total.carbs_g,
          items: aj.analysis.items,
          confidence: aj.analysis.confidence,
        };
      }

      const res = await fetch("/api/meals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toSave),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "save failed");
      setTip(j.ai_tip || null);
      setTimeout(() => {
        router.push("/");
        router.refresh();
      }, 2000);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setQuickBusy(false);
    }
  }

  return (
    <div className="px-5 pt-6 pb-10 space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Log a meal</h1>
        <p className="text-sm text-white/60 mt-1">
          Snap a photo, describe it in words, or re-log a frequent meal.
        </p>
      </div>

      {/* --- PHOTO PICKER --- */}
      {!photoPreview && (
        <button
          onClick={() => fileRef.current?.click()}
          className="w-full aspect-square rounded-2xl border-2 border-dashed border-border bg-bg-elev flex flex-col items-center justify-center gap-3"
        >
          <div className="w-16 h-16 rounded-full bg-bg-card flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="h-8 w-8 text-white/80" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </div>
          <div className="text-sm text-white/70">Tap to take/choose a photo</div>
          <div className="text-[11px] text-white/40">…or describe your meal below</div>
        </button>
      )}

      {photoPreview && (
        <div className="space-y-3">
          <div className="relative rounded-2xl overflow-hidden border border-border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photoPreview} alt="meal" className="w-full object-cover max-h-80" />
          </div>
          <div className="flex gap-4 text-sm">
            <button onClick={() => fileRef.current?.click()} className="text-accent-brand">
              Change photo
            </button>
            <button onClick={clearPhoto} className="text-white/50">
              Remove photo
            </button>
          </div>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onPick}
        className="hidden"
      />

      {/* --- TEXT INPUT (always visible until an analysis exists) --- */}
      {!analysis && (
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-white/60 mb-1.5">
              {photoPreview ? "Notes for the photo (optional)" : "Describe your meal"}
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                photoPreview
                  ? "e.g. grilled chicken breast, half the rice"
                  : "e.g. two scrambled eggs, toast with butter, black coffee"
              }
              rows={3}
              className="w-full rounded-xl bg-bg-elev border border-border px-4 py-3 text-[15px] resize-none"
            />
          </div>
          <button
            onClick={analyze}
            disabled={analyzing}
            className="w-full rounded-xl bg-accent-brand py-3 text-sm font-semibold disabled:opacity-40"
          >
            {analyzing
              ? "Analyzing…"
              : photoPreview
                ? "Analyze with Claude"
                : text.trim()
                  ? "Analyze from description"
                  : "Analyze (add photo or text)"}
          </button>
        </div>
      )}

      {/* --- ANALYSIS REVIEW --- */}
      {analysis && editing && (
        <div className="space-y-4">
          <div className="card p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">{analysis.description}</h3>
              <span className="text-[10px] uppercase tracking-wider text-white/50 bg-bg-elev border border-border rounded-full px-2 py-0.5">
                {analysis.confidence} confidence
              </span>
            </div>
            {analysis.items?.length > 0 && (
              <ul className="text-[13px] text-white/70 space-y-1 mt-2">
                {analysis.items.map((it, i) => (
                  <li key={i} className="flex justify-between">
                    <span>
                      {it.name} <span className="text-white/40">({it.portion})</span>
                    </span>
                    <span>{Math.round(it.calories)} kcal</span>
                  </li>
                ))}
              </ul>
            )}
            {analysis.notes && (
              <p className="text-[11px] text-white/40 mt-2 italic">{analysis.notes}</p>
            )}
          </div>

          <div className="card p-4 space-y-3">
            <h3 className="text-sm font-semibold">Totals (editable)</h3>
            <MacroEdit
              label="Calories"
              unit="kcal"
              value={editing.calories}
              onChange={(v) => setEditing({ ...editing, calories: v })}
            />
            <MacroEdit
              label="Protein"
              unit="g"
              value={editing.protein_g}
              onChange={(v) => setEditing({ ...editing, protein_g: v })}
            />
            <MacroEdit
              label="Fat"
              unit="g"
              value={editing.fat_g}
              onChange={(v) => setEditing({ ...editing, fat_g: v })}
            />
            <MacroEdit
              label="Carbs"
              unit="g"
              value={editing.carbs_g}
              onChange={(v) => setEditing({ ...editing, carbs_g: v })}
            />
          </div>

          <button
            onClick={save}
            disabled={saving}
            className="w-full rounded-xl bg-accent-brand py-3 text-sm font-semibold disabled:opacity-40"
          >
            {saving ? "Saving…" : "Confirm & save"}
          </button>
        </div>
      )}

      {tip && (
        <div className="card p-4 border-accent-cal/40">
          <div className="text-xs uppercase tracking-wider text-accent-cal font-semibold mb-1">
            Next meal tip
          </div>
          <p className="text-sm text-white/80">{tip}</p>
        </div>
      )}

      {err && <div className="text-sm text-red-400">{err}</div>}

      {/* --- FREQUENT MEALS --- */}
      {!analysis && frequent.length > 0 && (
        <section className="space-y-3 pt-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              Log again
            </h2>
            <span className="text-[11px] text-white/40">recurring meals</span>
          </div>
          <div className="space-y-2">
            {frequent.map((m, i) => {
              const open = expandedIdx === i;
              return (
                <div key={i} className="card p-4">
                  <button
                    onClick={() => {
                      setExpandedIdx(open ? null : i);
                      setModifier("");
                    }}
                    className="w-full text-left"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{m.description}</div>
                        <div className="text-[11px] text-white/50 mt-0.5">
                          {Math.round(m.calories)} kcal · {Math.round(m.protein_g)}P
                          · {Math.round(m.fat_g)}F · {Math.round(m.carbs_g)}C
                        </div>
                      </div>
                      <div className="flex flex-col items-end shrink-0">
                        <span className="text-[11px] text-white/60 bg-bg-elev border border-border rounded-full px-2 py-0.5">
                          ×{m.count}
                        </span>
                        <span className="text-[10px] text-white/30 mt-1">{m.last_date}</span>
                      </div>
                    </div>
                  </button>

                  {open && (
                    <div className="mt-3 space-y-2">
                      <input
                        value={modifier}
                        onChange={(e) => setModifier(e.target.value)}
                        placeholder="Same as last time, or e.g. 'a bit smaller'"
                        className="w-full rounded-lg bg-bg-elev border border-border px-3 py-2 text-[13px]"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => quickLog(m, "")}
                          disabled={quickBusy}
                          className="flex-1 rounded-lg border border-border bg-bg-elev py-2 text-xs font-medium disabled:opacity-40"
                        >
                          {quickBusy ? "Saving…" : "Log as-is"}
                        </button>
                        <button
                          onClick={() => quickLog(m, modifier)}
                          disabled={quickBusy || !modifier.trim()}
                          className="flex-1 rounded-lg bg-accent-brand py-2 text-xs font-semibold disabled:opacity-40"
                        >
                          {quickBusy ? "Saving…" : "Log with change"}
                        </button>
                      </div>
                      <p className="text-[10px] text-white/40">
                        &quot;Log with change&quot; asks Claude to adjust macros based on your note.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function MacroEdit({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-white/70 w-20">{label}</span>
      <input
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(Number(e.target.value.replace(/[^\d.]/g, "")) || 0)}
        className="flex-1 rounded-lg bg-bg-elev border border-border px-3 py-2 text-right text-[15px]"
      />
      <span className="text-xs text-white/40 w-10">{unit}</span>
    </div>
  );
}
