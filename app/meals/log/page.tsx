"use client";

import { useEffect, useRef, useState, useCallback } from "react";
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

type ExistingMeal = {
  id: number;
  date: string;
  description: string | null;
  calories: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  photo_path: string | null;
  ai_tip: string | null;
  created_at: string;
};

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function LogMealPage() {
  const router = useRouter();
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const [date, setDate] = useState<string>(todayStr());
  const isToday = date === todayStr();

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

  // Existing meals state
  const [existing, setExisting] = useState<ExistingMeal[]>([]);
  const [existingEditId, setExistingEditId] = useState<number | null>(null);

  // Frequent meals state
  const [frequent, setFrequent] = useState<FrequentMeal[]>([]);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [modifier, setModifier] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);

  const loadExisting = useCallback(async (forDate: string) => {
    try {
      const r = await fetch(`/api/meals?date=${forDate}`, { cache: "no-store" });
      const j = await r.json();
      setExisting(j.meals || []);
    } catch {
      // non-fatal
    }
  }, []);

  // Reload existing meals whenever the date changes.
  useEffect(() => {
    setExistingEditId(null);
    loadExisting(date);
  }, [date, loadExisting]);

  // Frequent meals are global to the user; load once.
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

  function pickedFile(): File | null {
    return (
      cameraRef.current?.files?.[0] || galleryRef.current?.files?.[0] || null
    );
  }

  function clearPhoto() {
    setPhotoPreview(null);
    setPhotoBase64(null);
    if (cameraRef.current) cameraRef.current.value = "";
    if (galleryRef.current) galleryRef.current.value = "";
  }

  function resetNewMealForm() {
    setAnalysis(null);
    setEditing(null);
    setText("");
    clearPhoto();
  }

  async function analyze() {
    const f = pickedFile();
    const hasPhoto = !!f;
    const hasText = !!text.trim();
    if (!hasPhoto && !hasText) {
      setErr("Add a photo or a description");
      return;
    }
    setAnalyzing(true);
    setErr(null);
    try {
      const fd = new FormData();
      if (f) fd.append("photo", f);
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
          date,
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
      // Reload list, clear form. Redirect home only if logging for today.
      await loadExisting(date);
      resetNewMealForm();
      if (isToday) {
        setTimeout(() => {
          router.push("/");
          router.refresh();
        }, 2000);
      }
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
        body: JSON.stringify({ ...toSave, date }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "save failed");
      setTip(j.ai_tip || null);
      await loadExisting(date);
      setExpandedIdx(null);
      setModifier("");
      if (isToday) {
        setTimeout(() => {
          router.push("/");
          router.refresh();
        }, 2000);
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setQuickBusy(false);
    }
  }

  async function deleteMeal(id: number) {
    if (!confirm("Delete this meal?")) return;
    try {
      const r = await fetch(`/api/meals/${id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "delete failed");
      }
      await loadExisting(date);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function patchMeal(
    id: number,
    fields: Partial<
      Pick<ExistingMeal, "description" | "calories" | "protein_g" | "fat_g" | "carbs_g">
    >,
  ) {
    const r = await fetch(`/api/meals/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || "update failed");
    }
    await loadExisting(date);
    setExistingEditId(null);
  }

  return (
    <div className="px-5 pt-6 pb-10 space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Log a meal</h1>
        <p className="text-sm text-white/60 mt-1">
          {isToday
            ? "Snap a photo, describe it in words, or re-log a frequent meal."
            : `Logging for ${prettyDate(date)}.`}
        </p>
      </div>

      {/* --- DATE PICKER --- */}
      <div className="card p-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-white/50">Date</div>
          <div className="text-sm font-medium mt-0.5">{prettyDate(date)}</div>
        </div>
        <div className="flex items-center gap-2">
          {!isToday && (
            <button
              onClick={() => setDate(todayStr())}
              className="text-[11px] text-accent-brand"
            >
              Today
            </button>
          )}
          <input
            type="date"
            value={date}
            max={todayStr()}
            onChange={(e) => setDate(e.target.value || todayStr())}
            className="rounded-lg bg-bg-elev border border-border px-2 py-1.5 text-[13px]"
          />
        </div>
      </div>

      {/* --- EXISTING MEALS FOR THIS DATE --- */}
      {existing.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
            {isToday ? "Today's meals" : "Logged for this day"}
          </h2>
          <div className="space-y-2">
            {existing.map((m) => (
              <ExistingMealRow
                key={m.id}
                meal={m}
                isEditing={existingEditId === m.id}
                onEditToggle={() =>
                  setExistingEditId(existingEditId === m.id ? null : m.id)
                }
                onDelete={() => deleteMeal(m.id)}
                onSave={(fields) => patchMeal(m.id, fields)}
              />
            ))}
          </div>
        </section>
      )}

      {/* --- PHOTO PICKER (NEW MEAL) --- */}
      {!photoPreview && !analysis && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => cameraRef.current?.click()}
              className="rounded-2xl border-2 border-dashed border-border bg-bg-elev py-6 flex flex-col items-center justify-center gap-2"
            >
              <div className="w-12 h-12 rounded-full bg-bg-card flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="h-6 w-6 text-white/80" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </div>
              <div className="text-xs text-white/70">Take photo</div>
            </button>
            <button
              onClick={() => galleryRef.current?.click()}
              className="rounded-2xl border-2 border-dashed border-border bg-bg-elev py-6 flex flex-col items-center justify-center gap-2"
            >
              <div className="w-12 h-12 rounded-full bg-bg-card flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="h-6 w-6 text-white/80" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-5-5L5 21" />
                </svg>
              </div>
              <div className="text-xs text-white/70">From gallery</div>
            </button>
          </div>
          <div className="text-[11px] text-white/40 text-center">…or describe your meal below</div>
        </div>
      )}

      {photoPreview && (
        <div className="space-y-3">
          <div className="relative rounded-2xl overflow-hidden border border-border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photoPreview} alt="meal" className="w-full object-cover max-h-80" />
          </div>
          <div className="flex gap-4 text-sm">
            <button onClick={() => cameraRef.current?.click()} className="text-accent-brand">
              Retake
            </button>
            <button onClick={() => galleryRef.current?.click()} className="text-accent-brand">
              Pick from gallery
            </button>
            <button onClick={clearPhoto} className="text-white/50 ml-auto">
              Remove
            </button>
          </div>
        </div>
      )}

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onPick}
        className="hidden"
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
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

          <div className="flex gap-2">
            <button
              onClick={resetNewMealForm}
              className="flex-1 rounded-xl border border-border bg-bg-elev py-3 text-sm font-medium"
            >
              Discard
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="flex-1 rounded-xl bg-accent-brand py-3 text-sm font-semibold disabled:opacity-40"
            >
              {saving ? "Saving…" : isToday ? "Confirm & save" : `Save to ${prettyDate(date)}`}
            </button>
          </div>
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
                          {quickBusy ? "Saving…" : `Log as-is${isToday ? "" : ` to ${date}`}`}
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

function ExistingMealRow({
  meal,
  isEditing,
  onEditToggle,
  onDelete,
  onSave,
}: {
  meal: ExistingMeal;
  isEditing: boolean;
  onEditToggle: () => void;
  onDelete: () => void;
  onSave: (fields: Partial<ExistingMeal>) => Promise<void>;
}) {
  const [desc, setDesc] = useState(meal.description ?? "");
  const [cal, setCal] = useState<number>(Math.round(meal.calories ?? 0));
  const [p, setP] = useState<number>(Math.round(meal.protein_g ?? 0));
  const [f, setF] = useState<number>(Math.round(meal.fat_g ?? 0));
  const [c, setC] = useState<number>(Math.round(meal.carbs_g ?? 0));
  const [busy, setBusy] = useState(false);

  // Keep local state in sync if the meal changes underneath (e.g. after a save).
  useEffect(() => {
    setDesc(meal.description ?? "");
    setCal(Math.round(meal.calories ?? 0));
    setP(Math.round(meal.protein_g ?? 0));
    setF(Math.round(meal.fat_g ?? 0));
    setC(Math.round(meal.carbs_g ?? 0));
  }, [meal.id, meal.description, meal.calories, meal.protein_g, meal.fat_g, meal.carbs_g]);

  async function handleSave() {
    setBusy(true);
    try {
      await onSave({
        description: desc.trim() || null,
        calories: cal,
        protein_g: p,
        fat_g: f,
        carbs_g: c,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-3">
      <div className="flex items-center gap-3">
        {meal.photo_path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={meal.photo_path}
            alt=""
            width={48}
            height={48}
            loading="lazy"
            decoding="async"
            className="w-12 h-12 rounded-lg object-cover bg-bg-elev shrink-0"
          />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-bg-elev shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            {meal.description || "Meal"}
          </div>
          <div className="text-[11px] text-white/50 mt-0.5">
            {Math.round(meal.calories ?? 0)} kcal · P{Math.round(meal.protein_g ?? 0)}{" "}
            C{Math.round(meal.carbs_g ?? 0)} F{Math.round(meal.fat_g ?? 0)}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onEditToggle}
            className="text-[11px] text-accent-brand px-2 py-1"
          >
            {isEditing ? "Cancel" : "Edit"}
          </button>
          <button
            onClick={onDelete}
            className="text-[11px] text-red-400/80 px-2 py-1"
          >
            Delete
          </button>
        </div>
      </div>

      {isEditing && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="Description"
            className="w-full rounded-lg bg-bg-elev border border-border px-3 py-2 text-[13px]"
          />
          <div className="grid grid-cols-2 gap-2">
            <NumField label="Calories" unit="kcal" value={cal} onChange={setCal} />
            <NumField label="Protein" unit="g" value={p} onChange={setP} />
            <NumField label="Fat" unit="g" value={f} onChange={setF} />
            <NumField label="Carbs" unit="g" value={c} onChange={setC} />
          </div>
          <button
            onClick={handleSave}
            disabled={busy}
            className="w-full rounded-lg bg-accent-brand py-2 text-xs font-semibold disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </div>
  );
}

function NumField({
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
    <label className="rounded-lg bg-bg-elev border border-border px-2 py-1.5 flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider text-white/50 w-12">{label}</span>
      <input
        inputMode="numeric"
        value={value || ""}
        onChange={(e) => onChange(Number(e.target.value.replace(/[^\d.]/g, "")) || 0)}
        className="flex-1 bg-transparent border-0 text-right text-[13px] focus:outline-none"
      />
      <span className="text-[10px] text-white/40 w-8">{unit}</span>
    </label>
  );
}

function prettyDate(s: string): string {
  if (s === todayStr()) return "היום";
  const d = new Date(s + "T00:00:00");
  return d.toLocaleDateString("he-IL", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
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
        value={value || ""}
        onChange={(e) => onChange(Number(e.target.value.replace(/[^\d.]/g, "")) || 0)}
        className="flex-1 rounded-lg bg-bg-elev border border-border px-3 py-2 text-right text-[15px]"
      />
      <span className="text-xs text-white/40 w-10">{unit}</span>
    </div>
  );
}
