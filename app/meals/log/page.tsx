"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";
import { safeFetchJson } from "@/lib/fetch-json";
import { compressImageFile, compressImageThumb } from "@/lib/compress-image";
import { useLang } from "@/components/LangProvider";
import { t, Lang } from "@/lib/i18n";

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
  clarifying_question?: string;
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
  photo_thumb: string | null;
  items_json: string | null;
  ai_tip: string | null;
  created_at: string;
};

type MealReview = {
  meal_id: number;
  description: string;
  photo_thumb: string | null;
  current: { calories: number; protein_g: number; fat_g: number; carbs_g: number };
  suggested: { calories: number; protein_g: number; fat_g: number; carbs_g: number };
  explanation: string;
  confidence: "low" | "medium" | "high";
  changed: boolean;
};

type ReviewResult = {
  reviews: MealReview[];
  summary: string;
};

const ALLIN_WHEY = { cal: 127, protein: 23, fat: 1.2, carbs: 3.6 };
const PROTEIN_BASES = ["מים", "חלב", "חלב שקדים", "חלב שיבולת שועל", "מיץ תפוזים", "קפה"];

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Refresh the cached "log again" list after a save. Fire-and-forget —
 *  the save itself doesn't wait on this. */
function refreshFrequentMeals() {
  fetch("/api/meals/frequent/refresh", { method: "POST" }).catch(() => {});
}

export default function LogMealPage() {
  const lang = useLang();
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const [date, setDate] = useState<string>(todayStr());
  const isToday = date === todayStr();

  // SSR runs `todayStr()` in UTC, so the initial value can be off-by-one
  // from the user's local "today". On mount, force the picker to the
  // device's actual current day. (Safe to clobber here because mount runs
  // before the user can have picked anything else.)
  useEffect(() => {
    setDate(todayStr());
    // Intentionally only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [photoExt, setPhotoExt] = useState<string>("jpg");
  // The compressed photo as a JPEG File ready to upload to /api/meals/analyze.
  // We compress on pick so the multi-MB original never leaves the device.
  const [compressedFile, setCompressedFile] = useState<File | null>(null);
  // Tiny ~5–10 KB thumbnail data URI saved alongside the meal so list views
  // can render it inline without going through the image optimizer.
  const [photoThumbBase64, setPhotoThumbBase64] = useState<string | null>(null);
  const [text, setText] = useState(""); // description/hint/context

  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  // Granular step label, surfaced in the action button so the user knows
  // which stage is taking time. Cleared back to null when idle.
  const [progress, setProgress] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [editing, setEditing] = useState<{
    calories: number;
    protein_g: number;
    fat_g: number;
    carbs_g: number;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const [clarifyAnswer, setClarifyAnswer] = useState("");
  const [clarifying, setClarifying] = useState(false);

  // Existing meals state
  const [existing, setExisting] = useState<ExistingMeal[]>([]);
  const [existingLoading, setExistingLoading] = useState(true);
  const [existingEditId, setExistingEditId] = useState<number | null>(null);

  // Frequent meals state
  const [frequent, setFrequent] = useState<FrequentMeal[]>([]);
  const [frequentLoading, setFrequentLoading] = useState(true);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [modifier, setModifier] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);

  // Manual entry state
  const [manualMode, setManualMode] = useState(false);
  const [manualDesc, setManualDesc] = useState("");
  const [manualMacros, setManualMacros] = useState({ calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 });
  const [manualSaving, setManualSaving] = useState(false);

  // Protein powder state
  const [proteinMode, setProteinMode] = useState(false);
  const [proteinBase, setProteinBase] = useState<string>(PROTEIN_BASES[0]);
  const [proteinSaving, setProteinSaving] = useState(false);

  // Coach review state
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewData, setReviewData] = useState<ReviewResult | null>(null);

  // Tap-to-zoom for the photo preview
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const loadExisting = useCallback(async (forDate: string) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    try {
      const r = await fetch(`/api/meals?date=${forDate}`, { cache: "no-store", signal: ac.signal });
      const j = await r.json();
      setExisting(j.meals || []);
    } catch {
      // non-fatal
    } finally {
      clearTimeout(timer);
      setExistingLoading(false);
    }
  }, []);

  // Reload existing meals whenever the date changes.
  useEffect(() => {
    setExistingEditId(null);
    setExistingLoading(true);
    loadExisting(date);
  }, [date, loadExisting]);

  // Frequent meals are global; load once in parallel with existing.
  useEffect(() => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    (async () => {
      try {
        const r = await fetch("/api/meals/frequent", { cache: "no-store", signal: ac.signal });
        const j = await r.json();
        setFrequent(j.meals || []);
      } catch {
        // non-fatal
      } finally {
        clearTimeout(timer);
        setFrequentLoading(false);
      }
    })();
    return () => { ac.abort(); clearTimeout(timer); };
  }, []);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr(null);
    setAnalysis(null);
    setEditing(null);
    setProgress(t(lang, "meal_compress"));
    try {
      // Generate the full-size compressed JPEG and the inline thumbnail
      // in parallel — both pull pixels from the same decoded source.
      const [compressed, thumb] = await Promise.all([
        compressImageFile(f),
        compressImageThumb(f),
      ]);
      const blob = await (await fetch(compressed.dataUri)).blob();
      const compFile = new File([blob], "meal.jpg", { type: "image/jpeg" });
      setCompressedFile(compFile);
      setPhotoPreview(compressed.dataUri);
      setPhotoBase64(compressed.base64);
      setPhotoThumbBase64(thumb.base64);
      setPhotoExt("jpg");
    } catch (err: any) {
      setErr(err?.message || "Could not read that photo");
    } finally {
      setProgress(null);
    }
  }

  function pickedFile(): File | null {
    // Prefer the compressed JPEG; fall back to the raw input if compression
    // somehow didn't happen (shouldn't, but better safe than uploading 5 MB).
    if (compressedFile) return compressedFile;
    return (
      cameraRef.current?.files?.[0] || galleryRef.current?.files?.[0] || null
    );
  }

  function clearPhoto() {
    setPhotoPreview(null);
    setPhotoBase64(null);
    setPhotoThumbBase64(null);
    setCompressedFile(null);
    if (cameraRef.current) cameraRef.current.value = "";
    if (galleryRef.current) galleryRef.current.value = "";
  }

  function resetNewMealForm() {
    setAnalysis(null);
    setEditing(null);
    setText("");
    setClarifyAnswer("");
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
      // Step labels surface in the button so the user knows which slow part
      // we're in. Claude's vision call is the bulk of the wait when a photo
      // is attached; text-only calls are noticeably faster.
      setProgress(hasPhoto ? t(lang, "meal_asking_photo") : t(lang, "meal_asking_text"));
      const j = await safeFetchJson<{ analysis: Analysis }>(
        "/api/meals/analyze",
        { method: "POST", body: fd },
      );
      setProgress(t(lang, "meal_reading"));
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
      setProgress(null);
    }
  }

  /** Re-runs the analysis with the user's answer folded into the context
   *  (same photo/text, plus the question+answer), instead of a fresh modifier
   *  flow — this lets the model reconcile the answer against the image. */
  async function answerClarifyingQuestion() {
    if (!analysis?.clarifying_question || !clarifyAnswer.trim()) return;
    const f = pickedFile();
    const qa = `${analysis.clarifying_question} Answer: ${clarifyAnswer.trim()}`;
    setClarifying(true);
    setErr(null);
    setProgress(t(lang, "meal_clarify_updating"));
    try {
      const fd = new FormData();
      if (f) {
        fd.append("photo", f);
        fd.append("hint", [text.trim(), qa].filter(Boolean).join(". "));
      } else {
        fd.append("text", [text.trim(), qa].filter(Boolean).join(". "));
      }
      const j = await safeFetchJson<{ analysis: Analysis }>(
        "/api/meals/analyze",
        { method: "POST", body: fd },
      );
      setAnalysis(j.analysis as Analysis);
      setEditing({
        calories: j.analysis.total.calories,
        protein_g: j.analysis.total.protein_g,
        fat_g: j.analysis.total.fat_g,
        carbs_g: j.analysis.total.carbs_g,
      });
      setClarifyAnswer("");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setClarifying(false);
      setProgress(null);
    }
  }

  function skipClarifyingQuestion() {
    setAnalysis((prev) => (prev ? { ...prev, clarifying_question: "" } : prev));
    setClarifyAnswer("");
  }

  async function save() {
    if (!analysis || !editing) return;
    setSaving(true);
    setErr(null);
    setProgress(t(lang, "meal_saving"));
    try {
      // 1) Fast DB insert. /api/meals no longer waits on Claude.
      const j = await safeFetchJson<{ ok: true; id: number; ai_tip: string | null }>(
        "/api/meals",
        {
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
            photo_thumb_base64: photoThumbBase64 ?? undefined,
            photo_ext: photoExt,
          }),
        },
      );
      setTip(j.ai_tip || null);
      // Reload list, clear form. Redirect home only if logging for today.
      await loadExisting(date);
      resetNewMealForm();
      refreshFrequentMeals();

      // 2) Background: kick off the tip endpoint and surface it when ready.
      // Doesn't block the redirect — fire-and-forget. We surface a spinner
      // string ("Generating next-meal tip…") on the tip card itself so the
      // user knows something is still happening.
      if (j.id) {
        setTip("__pending__");
        (async () => {
          const guard = setTimeout(() => setTip(null), 20000);
          try {
            const t = await safeFetchJson<{ ai_tip: string | null }>(
              `/api/meals/${j.id}/tip`,
              { method: "POST" },
            );
            setTip(t.ai_tip || null);
          } catch {
            setTip(null);
          } finally {
            clearTimeout(guard);
          }
        })();
      }

    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
      setProgress(null);
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
        setProgress(t(lang, "meal_adjusting"));
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
        const aj = await safeFetchJson<{ analysis: Analysis }>(
          "/api/meals/analyze",
          { method: "POST", body: fd },
        );
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

      setProgress(t(lang, "meal_saving"));
      const j = await safeFetchJson<{ ok: true; id: number; ai_tip: string | null }>(
        "/api/meals",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...toSave, date }),
        },
      );
      setTip(j.ai_tip || null);
      await loadExisting(date);
      setExpandedIdx(null);
      setModifier("");
      refreshFrequentMeals();

      // Background tip — same pattern as the photo/text save flow.
      if (j.id) {
        setTip("__pending__");
        (async () => {
          const guard = setTimeout(() => setTip(null), 20000);
          try {
            const t = await safeFetchJson<{ ai_tip: string | null }>(
              `/api/meals/${j.id}/tip`,
              { method: "POST" },
            );
            setTip(t.ai_tip || null);
          } catch {
            setTip(null);
          } finally {
            clearTimeout(guard);
          }
        })();
      }

    } catch (e: any) {
      setErr(e.message);
    } finally {
      setQuickBusy(false);
      setProgress(null);
    }
  }

  async function saveManual() {
    if (!manualDesc.trim() && !manualMacros.calories) {
      setErr(t(lang, "meal_err_no_data"));
      return;
    }
    setManualSaving(true);
    setErr(null);
    setProgress("Saving meal…");
    try {
      const j = await safeFetchJson<{ ok: true; id: number; ai_tip: string | null }>(
        "/api/meals",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            date,
            description: manualDesc.trim() || "Meal",
            calories: manualMacros.calories,
            protein_g: manualMacros.protein_g,
            fat_g: manualMacros.fat_g,
            carbs_g: manualMacros.carbs_g,
            confidence: "high",
          }),
        },
      );
      await loadExisting(date);
      setManualDesc("");
      setManualMacros({ calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 });
      setManualMode(false);
      setTip(j.ai_tip || null);
      refreshFrequentMeals();

      if (j.id) {
        setTip("__pending__");
        (async () => {
          const guard = setTimeout(() => setTip(null), 20000);
          try {
            const t = await safeFetchJson<{ ai_tip: string | null }>(
              `/api/meals/${j.id}/tip`,
              { method: "POST" },
            );
            setTip(t.ai_tip || null);
          } catch {
            setTip(null);
          } finally {
            clearTimeout(guard);
          }
        })();
      }

    } catch (e: any) {
      setErr(e.message);
    } finally {
      setManualSaving(false);
      setProgress(null);
    }
  }

  async function saveProtein() {
    const calc = {
      calories: ALLIN_WHEY.cal,
      protein_g: ALLIN_WHEY.protein,
      fat_g: ALLIN_WHEY.fat,
      carbs_g: ALLIN_WHEY.carbs,
    };
    const description = `Allin Whey וניל עם ${proteinBase}`;

    setProteinSaving(true);
    setErr(null);
    try {
      await safeFetchJson("/api/meals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date,
          description,
          ...calc,
          confidence: "high",
          items: [{
            type: "protein_powder",
            brand_id: "allin_whey",
            name: "Allin Whey וניל",
            portion: "33g (סקופ אחד)",
            ...calc,
          }],
        }),
      });
      await loadExisting(date);
      refreshFrequentMeals();
      setProteinMode(false);
      setProteinBase(PROTEIN_BASES[0]);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setProteinSaving(false);
    }
  }

  async function deleteMeal(id: number) {
    if (!confirm(t(lang, "meal_delete_confirm"))) return;
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
    fields: Partial<Pick<ExistingMeal, "description" | "calories" | "protein_g" | "fat_g" | "carbs_g"> & { date: string }>,
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

  async function startReview() {
    setReviewOpen(true);
    setReviewing(true);
    setReviewData(null);
    try {
      const j = await safeFetchJson<ReviewResult>("/api/meals/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date }),
      });
      setReviewData(j);
    } catch (e: any) {
      setErr(e.message);
      setReviewOpen(false);
    } finally {
      setReviewing(false);
    }
  }

  async function acceptOneMeal(review: MealReview) {
    await patchMeal(review.meal_id, {
      calories: review.suggested.calories,
      protein_g: review.suggested.protein_g,
      fat_g: review.suggested.fat_g,
      carbs_g: review.suggested.carbs_g,
    });
  }

  async function askAboutMeal(mealId: number, question: string) {
    const j = await safeFetchJson<ReviewResult>("/api/meals/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date, meal_id: mealId, question }),
    });
    const updated = j.reviews[0];
    if (!updated) return;
    setReviewData((prev: ReviewResult | null) => {
      if (!prev) return j;
      return {
        ...prev,
        reviews: prev.reviews.map((r: MealReview) =>
          r.meal_id === mealId ? { ...updated, photo_thumb: r.photo_thumb } : r,
        ),
      };
    });
  }

  return (
    <div className="px-5 pt-6 pb-10 space-y-5 md:max-w-3xl md:mx-auto">
      <div>
        <h1 className="text-2xl font-bold">{t(lang, "meal_title")}</h1>
        <p className="text-sm text-white/60 mt-1">
          {isToday
            ? t(lang, "meal_subtitle_today")
            : `${t(lang, "meal_subtitle_past")} ${prettyDate(date, lang)}.`}
        </p>
      </div>

      {/* --- DATE PICKER --- */}
      <div className="card p-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-white/50">{t(lang, "meal_date")}</div>
          <div className="text-sm font-medium mt-0.5">{prettyDate(date, lang)}</div>
        </div>
        <div className="flex items-center gap-2">
          {!isToday && (
            <button
              onClick={() => setDate(todayStr())}
              className="text-[11px] text-accent-brand"
            >
              {t(lang, "meal_today_btn")}
            </button>
          )}
          <input
            type="date"
            value={date}
            // Note: no `max` cap. On Android Chrome, capping `max` mid-month
            // disables the "next month" arrow, which trapped users in the
            // wrong month. The "Today" button above is the safety net.
            onChange={(e) => setDate(e.target.value || todayStr())}
            className="rounded-lg bg-bg-elev border border-border px-2 py-1.5 text-[13px]"
          />
        </div>
      </div>

      {/* --- PHOTO PICKER (NEW MEAL) --- */}
      {!photoPreview && !analysis && !manualMode && !proteinMode && (
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
              <div className="text-xs text-white/70">{t(lang, "meal_take_photo")}</div>
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
              <div className="text-xs text-white/70">{t(lang, "meal_from_gallery")}</div>
            </button>
          </div>
          <div className="text-[11px] text-white/40 text-center">{t(lang, "meal_or_describe")}</div>
          <button
            onClick={() => { setProteinMode(true); setErr(null); }}
            className="w-full rounded-2xl border border-border bg-bg-elev py-3 flex items-center justify-center gap-2.5 text-sm text-white/70 font-medium"
          >
            <ShakerIcon className="h-5 w-5 text-white/50" />
            אבקת חלבון
          </button>
        </div>
      )}

      {/* --- PROTEIN POWDER QUICK-LOG --- */}
      {proteinMode && !analysis && (
        <div className="card p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShakerIcon className="h-5 w-5 text-white/60" />
              <h3 className="text-sm font-semibold">Allin Whey וניל — סקופ אחד (33g)</h3>
            </div>
            <button onClick={() => { setProteinMode(false); setErr(null); }} className="text-xs text-white/40">
              {t(lang, "meal_cancel")}
            </button>
          </div>

          <div className="space-y-3">
            {/* Fixed macros display */}
            <div className="rounded-xl bg-bg-elev border border-border px-4 py-3 grid grid-cols-4 gap-2 text-center">
              <div>
                <div className="text-[11px] text-accent-cal font-semibold">{ALLIN_WHEY.cal}</div>
                <div className="text-[10px] text-white/40">קק״ל</div>
              </div>
              <div>
                <div className="text-[11px] text-accent-protein font-semibold">{ALLIN_WHEY.protein}g</div>
                <div className="text-[10px] text-white/40">חלבון</div>
              </div>
              <div>
                <div className="text-[11px] text-accent-fat font-semibold">{ALLIN_WHEY.fat}g</div>
                <div className="text-[10px] text-white/40">שומן</div>
              </div>
              <div>
                <div className="text-[11px] text-accent-carbs font-semibold">{ALLIN_WHEY.carbs}g</div>
                <div className="text-[10px] text-white/40">פחמימות</div>
              </div>
            </div>

            {/* Liquid base */}
            <div>
              <label className="block text-xs font-medium text-white/60 mb-1.5">עם מה?</label>
              <select
                value={proteinBase}
                onChange={(e) => setProteinBase(e.target.value)}
                className="w-full rounded-xl bg-bg-elev border border-border px-4 py-3 text-[15px] text-white"
              >
                {PROTEIN_BASES.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
          </div>

          <button
            onClick={saveProtein}
            disabled={proteinSaving}
            className="w-full rounded-xl bg-accent-brand py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            {proteinSaving ? "שומר…" : isToday ? "שמור" : `שמור ל-${prettyDate(date, lang)}`}
          </button>
        </div>
      )}

      {photoPreview && !manualMode && !proteinMode && (
        <div className="space-y-3">
          <div className="relative rounded-2xl overflow-hidden border border-border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photoPreview}
              alt="meal"
              onClick={() => setLightboxSrc(photoPreview)}
              className="w-full object-cover max-h-80 cursor-zoom-in"
            />
          </div>
          <div className="flex gap-4 text-sm">
            <button onClick={() => cameraRef.current?.click()} className="text-accent-brand">
              {t(lang, "meal_retake")}
            </button>
            <button onClick={() => galleryRef.current?.click()} className="text-accent-brand">
              {t(lang, "meal_pick_gallery")}
            </button>
            <button onClick={clearPhoto} className="text-white/50 ml-auto">
              {t(lang, "meal_remove_photo")}
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
      {!analysis && !manualMode && !proteinMode && (
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-white/60 mb-1.5">
              {photoPreview ? t(lang, "meal_notes_hint") : t(lang, "meal_describe_label")}
            </label>
            <textarea
              value={text}
              dir={/[֐-׿]/.test(text) ? "rtl" : "ltr"}
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
            disabled={analyzing || !!progress}
            className="w-full rounded-xl bg-accent-brand py-3 text-sm font-semibold disabled:opacity-40"
          >
            {analyzing
              ? progress || t(lang, "meal_analyzing")
              : progress
                ? progress
                : photoPreview
                  ? t(lang, "meal_analyze_photo")
                  : text.trim()
                    ? t(lang, "meal_analyze_text")
                    : t(lang, "meal_analyze_empty")}
          </button>
          <button
            onClick={() => { setManualMode(true); clearPhoto(); setText(""); setErr(null); }}
            className="w-full text-center text-[12px] text-white/40 py-1"
          >
            {t(lang, "meal_manual_link")}
          </button>
        </div>
      )}

      {/* --- MANUAL ENTRY FORM --- */}
      {manualMode && !analysis && !proteinMode && (
        <div className="card p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t(lang, "meal_manual_title")}</h3>
            <button
              onClick={() => { setManualMode(false); setErr(null); }}
              className="text-xs text-white/40"
            >
              {t(lang, "meal_cancel")}
            </button>
          </div>
          <div>
            <label className="block text-xs font-medium text-white/60 mb-1.5">
              {t(lang, "meal_manual_desc_label")}
            </label>
            <input
              value={manualDesc}
              onChange={(e) => setManualDesc(e.target.value)}
              placeholder={t(lang, "meal_manual_desc_placeholder")}
              className="w-full rounded-xl bg-bg-elev border border-border px-4 py-3 text-[15px]"
            />
          </div>
          <div className="space-y-3">
            <div className="text-xs font-medium text-white/60">{t(lang, "meal_macros_label")}</div>
            <MacroEdit
              label={t(lang, "macro_calories")}
              unit={t(lang, "macro_kcal")}
              value={manualMacros.calories}
              onChange={(v) => setManualMacros({ ...manualMacros, calories: v })}
            />
            <MacroEdit
              label={t(lang, "macro_protein")}
              unit="g"
              value={manualMacros.protein_g}
              onChange={(v) => setManualMacros({ ...manualMacros, protein_g: v })}
            />
            <MacroEdit
              label={t(lang, "macro_fat")}
              unit="g"
              value={manualMacros.fat_g}
              onChange={(v) => setManualMacros({ ...manualMacros, fat_g: v })}
            />
            <MacroEdit
              label={t(lang, "macro_carbs")}
              unit="g"
              value={manualMacros.carbs_g}
              onChange={(v) => setManualMacros({ ...manualMacros, carbs_g: v })}
            />
          </div>
          <button
            onClick={saveManual}
            disabled={manualSaving}
            className="w-full rounded-xl bg-accent-brand py-3 text-sm font-semibold disabled:opacity-40"
          >
            {manualSaving
              ? progress || t(lang, "meal_saving_short")
              : isToday
                ? t(lang, "meal_save")
                : `${t(lang, "meal_save_to")} ${prettyDate(date, lang)}`}
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
                {analysis.confidence} {t(lang, "meal_confidence")}
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

          {analysis.clarifying_question && (
            <div className="card p-4 space-y-2 border-accent-brand/30">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wider text-accent-brand font-semibold">
                  {t(lang, "meal_clarify_label")}
                </div>
                <button onClick={skipClarifyingQuestion} className="text-[11px] text-white/40">
                  {t(lang, "meal_clarify_skip")}
                </button>
              </div>
              <p className="text-sm text-white/80">{analysis.clarifying_question}</p>
              <div className="flex gap-2">
                <input
                  value={clarifyAnswer}
                  onChange={(e) => setClarifyAnswer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) answerClarifyingQuestion();
                  }}
                  placeholder={t(lang, "meal_clarify_placeholder")}
                  className="flex-1 rounded-lg bg-bg-elev border border-border px-3 py-2 text-[13px] focus:outline-none focus:border-white/30"
                />
                <button
                  onClick={answerClarifyingQuestion}
                  disabled={clarifying || !clarifyAnswer.trim()}
                  className="rounded-lg bg-accent-brand px-3 py-2 text-[12px] font-semibold disabled:opacity-40"
                >
                  {clarifying ? "…" : t(lang, "meal_clarify_update")}
                </button>
              </div>
            </div>
          )}

          <div className="card p-4 space-y-3">
            <h3 className="text-sm font-semibold">{t(lang, "meal_totals")}</h3>
            <MacroEdit
              label={t(lang, "macro_calories")}
              unit={t(lang, "macro_kcal")}
              value={editing.calories}
              onChange={(v) => setEditing({ ...editing, calories: v })}
            />
            <MacroEdit
              label={t(lang, "macro_protein")}
              unit="g"
              value={editing.protein_g}
              onChange={(v) => setEditing({ ...editing, protein_g: v })}
            />
            <MacroEdit
              label={t(lang, "macro_fat")}
              unit="g"
              value={editing.fat_g}
              onChange={(v) => setEditing({ ...editing, fat_g: v })}
            />
            <MacroEdit
              label={t(lang, "macro_carbs")}
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
              {t(lang, "meal_discard")}
            </button>
            <button
              onClick={save}
              disabled={saving || clarifying}
              className="flex-1 rounded-xl bg-accent-brand py-3 text-sm font-semibold disabled:opacity-40"
            >
              {saving
                ? progress || t(lang, "meal_saving_short")
                : isToday
                  ? t(lang, "meal_confirm_save")
                  : `${t(lang, "meal_save_to")} ${prettyDate(date, lang)}`}
            </button>
          </div>
        </div>
      )}

      {tip && (
        <div className="card p-4 border-accent-cal/40">
          <div className="text-xs uppercase tracking-wider text-accent-cal font-semibold mb-1">
            {t(lang, "meal_next_tip")}
          </div>
          {tip === "__pending__" ? (
            <p className="text-sm text-white/50 animate-pulse">
              {t(lang, "meal_generating_tip")}
            </p>
          ) : (
            <p className="text-sm text-white/80">{tip}</p>
          )}
        </div>
      )}

      {err && <div className="text-sm text-red-400">{err}</div>}

      {/* --- EXISTING MEALS FOR THIS DATE --- */}
      {(existingLoading || existing.length > 0) && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              {isToday ? t(lang, "meal_todays_meals") : t(lang, "meal_logged_for_day")}
            </h2>
            {!existingLoading && existing.length > 0 && (
              <button
                onClick={startReview}
                disabled={reviewing}
                className="text-[11px] text-accent-brand disabled:opacity-40 flex items-center gap-1"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 12l2 2 4-4" />
                  <circle cx="12" cy="12" r="10" />
                </svg>
                {reviewing ? "Checking…" : "Coach Check"}
              </button>
            )}
          </div>
          {existingLoading ? (
            <div className="space-y-2">
              {[0, 1].map((i) => (
                <div key={i} className="card p-3 flex items-center gap-3">
                  <div className="w-12 h-12 rounded-lg bg-bg-elev animate-pulse shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-3/4 rounded bg-bg-elev animate-pulse" />
                    <div className="h-3 w-1/2 rounded bg-bg-elev animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
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
          )}
        </section>
      )}

      {/* --- COACH REVIEW MODAL --- */}
      {reviewOpen && (
        <CoachReviewModal
          reviewData={reviewData}
          reviewing={reviewing}
          onClose={() => setReviewOpen(false)}
          onAcceptOne={acceptOneMeal}
          onAskAbout={askAboutMeal}
        />
      )}

      {/* --- FREQUENT MEALS --- */}
      {!analysis && (frequentLoading || frequent.length > 0) && (
        <section className="space-y-3 pt-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              {t(lang, "meal_log_again")}
            </h2>
            <span className="text-[11px] text-white/40">{t(lang, "meal_recurring")}</span>
          </div>
          {frequentLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="card p-4 space-y-2">
                  <div className="h-3 w-2/3 rounded bg-bg-elev animate-pulse" />
                  <div className="h-3 w-1/3 rounded bg-bg-elev animate-pulse" />
                </div>
              ))}
            </div>
          ) : (
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
                        placeholder={t(lang, "meal_modifier_placeholder")}
                        className="w-full rounded-lg bg-bg-elev border border-border px-3 py-2 text-[13px]"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => quickLog(m, "")}
                          disabled={quickBusy}
                          className="flex-1 rounded-lg border border-border bg-bg-elev py-2 text-xs font-medium disabled:opacity-40"
                        >
                          {quickBusy
                            ? progress || t(lang, "meal_saving_short")
                            : `${t(lang, "meal_log_asis")}${isToday ? "" : ` to ${date}`}`}
                        </button>
                        <button
                          onClick={() => quickLog(m, modifier)}
                          disabled={quickBusy || !modifier.trim()}
                          className="flex-1 rounded-lg bg-accent-brand py-2 text-xs font-semibold disabled:opacity-40"
                        >
                          {quickBusy ? progress || t(lang, "meal_saving_short") : t(lang, "meal_log_with_change")}
                        </button>
                      </div>
                      <p className="text-[10px] text-white/40">
                        {t(lang, "meal_log_with_change_hint")}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          )}
        </section>
      )}

      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
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
  onSave: (fields: Partial<ExistingMeal & { date: string }>) => Promise<void>;
}) {
  const lang = useLang();
  const [desc, setDesc] = useState(meal.description ?? "");
  const [cal, setCal] = useState<number>(Math.round(meal.calories ?? 0));
  const [p, setP] = useState<number>(Math.round(meal.protein_g ?? 0));
  const [f, setF] = useState<number>(Math.round(meal.fat_g ?? 0));
  const [c, setC] = useState<number>(Math.round(meal.carbs_g ?? 0));
  const [moveDate, setMoveDate] = useState<string>(meal.date);
  const [busy, setBusy] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Keep local state in sync if the meal changes underneath (e.g. after a save).
  useEffect(() => {
    setDesc(meal.description ?? "");
    setCal(Math.round(meal.calories ?? 0));
    setP(Math.round(meal.protein_g ?? 0));
    setF(Math.round(meal.fat_g ?? 0));
    setC(Math.round(meal.carbs_g ?? 0));
    setMoveDate(meal.date);
  }, [meal.id, meal.description, meal.calories, meal.protein_g, meal.fat_g, meal.carbs_g, meal.date]);

  const isMoving = moveDate !== meal.date;

  async function handleSave() {
    setBusy(true);
    try {
      await onSave({
        description: desc.trim() || null,
        calories: cal,
        protein_g: p,
        fat_g: f,
        carbs_g: c,
        ...(isMoving && { date: moveDate }),
      });
    } finally {
      setBusy(false);
    }
  }

  const isProteinPowder = (() => {
    if (!meal.items_json) return false;
    try { return JSON.parse(meal.items_json)?.[0]?.type === "protein_powder"; }
    catch { return false; }
  })();

  return (
    <div className="card p-3">
      <div className="flex items-center gap-3">
        {isProteinPowder ? (
          <div className="w-12 h-12 rounded-lg bg-bg-elev border border-border flex items-center justify-center shrink-0">
            <ShakerIcon className="h-6 w-6 text-white/50" />
          </div>
        ) : meal.photo_thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={meal.photo_thumb}
            alt=""
            width={48}
            height={48}
            decoding="async"
            onClick={() => setLightboxOpen(true)}
            className="w-12 h-12 rounded-lg object-cover bg-bg-elev shrink-0 cursor-zoom-in"
          />
        ) : meal.photo_path ? (
          <Image
            src={meal.photo_path}
            alt=""
            width={48}
            height={48}
            quality={55}
            sizes="48px"
            loading="lazy"
            className="w-12 h-12 rounded-lg object-cover bg-bg-elev shrink-0"
          />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-bg-elev shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            {meal.description || t(lang, "meal_unnamed")}
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
            {isEditing ? t(lang, "meal_cancel") : t(lang, "meal_edit")}
          </button>
          <button
            onClick={onDelete}
            className="text-[11px] text-red-400/80 px-2 py-1"
          >
            {t(lang, "meal_delete")}
          </button>
        </div>
      </div>

      {isEditing && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder={t(lang, "meal_description_label")}
            className="w-full rounded-lg bg-bg-elev border border-border px-3 py-2 text-[13px]"
          />
          <div className="space-y-2">
            <NumField label={t(lang, "macro_calories")} unit={t(lang, "macro_kcal")} value={cal} onChange={setCal} />
            <NumField label={t(lang, "macro_protein")} unit="g" value={p} onChange={setP} />
            <NumField label={t(lang, "macro_fat")} unit="g" value={f} onChange={setF} />
            <NumField label={t(lang, "macro_carbs")} unit="g" value={c} onChange={setC} />
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-bg-elev border border-border px-3 py-2">
            <span className="text-[11px] text-white/50 flex-1">Move to date</span>
            <input
              type="date"
              value={moveDate}
              onChange={(e) => setMoveDate(e.target.value || meal.date)}
              className="bg-transparent text-[12px] text-white border-none outline-none"
            />
          </div>
          <button
            onClick={handleSave}
            disabled={busy}
            className={`w-full rounded-lg py-2 text-xs font-semibold disabled:opacity-40 ${
              isMoving ? "bg-white/10 border border-white/20 text-white" : "bg-accent-brand"
            }`}
          >
            {busy
              ? t(lang, "meal_saving_short")
              : isMoving
                ? `Move to ${moveDate}`
                : t(lang, "meal_save_changes")}
          </button>
        </div>
      )}

      {lightboxOpen && meal.photo_thumb && (
        <ImageLightbox src={meal.photo_thumb} onClose={() => setLightboxOpen(false)} />
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
    <label className="rounded-lg bg-bg-elev border border-border px-3 py-2 flex items-center gap-2">
      <span className="text-[11px] text-white/50 flex-1">{label}</span>
      <input
        inputMode="numeric"
        value={value || ""}
        onChange={(e) => onChange(Number(e.target.value.replace(/[^\d.]/g, "")) || 0)}
        className="w-20 bg-transparent border-0 text-right text-[13px] focus:outline-none"
      />
      <span className="text-[10px] text-white/40 w-6 text-right">{unit}</span>
    </label>
  );
}

function prettyDate(s: string, lang: Lang): string {
  if (s === todayStr()) return t(lang, "meal_today_btn");
  const d = new Date(s + "T00:00:00");
  return d.toLocaleDateString(lang === "he" ? "he-IL" : undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function ShakerIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8 2h8l1 3H7L8 2Z" />
      <path d="M7 5l-1 15.5A1 1 0 0 0 7 22h10a1 1 0 0 0 1-1.5L17 5H7Z" />
      <line x1="9" y1="10" x2="15" y2="10" />
      <line x1="9" y1="13.5" x2="13" y2="13.5" />
    </svg>
  );
}

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center rounded-full bg-white/10 text-white text-2xl leading-none"
      >
        ×
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        className="max-w-full max-h-full object-contain rounded-lg"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

function CoachReviewModal({
  reviewData,
  reviewing,
  onClose,
  onAcceptOne,
  onAskAbout,
}: {
  reviewData: ReviewResult | null;
  reviewing: boolean;
  onClose: () => void;
  onAcceptOne: (r: MealReview) => Promise<void>;
  onAskAbout: (mealId: number, question: string) => Promise<void>;
}) {
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [askingId, setAskingId] = useState<number | null>(null);
  const [askText, setAskText] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [acceptBusy, setAcceptBusy] = useState<number | null>(null);
  const [acceptAllBusy, setAcceptAllBusy] = useState(false);

  const changedCount =
    reviewData?.reviews.filter((r) => r.changed && !accepted.has(r.meal_id)).length ?? 0;

  async function handleAcceptOne(review: MealReview) {
    setAcceptBusy(review.meal_id);
    try {
      await onAcceptOne(review);
      setAccepted((prev: Set<number>) => new Set([...prev, review.meal_id]));
    } finally {
      setAcceptBusy(null);
    }
  }

  async function handleAcceptAll() {
    if (!reviewData) return;
    setAcceptAllBusy(true);
    const toAccept = reviewData.reviews.filter((r) => r.changed && !accepted.has(r.meal_id));
    const newAccepted = new Set(accepted);
    for (const r of toAccept) {
      try {
        await onAcceptOne(r);
        newAccepted.add(r.meal_id);
      } catch {}
    }
    setAccepted(newAccepted);
    setAcceptAllBusy(false);
  }

  async function handleAsk(mealId: number) {
    if (!askText.trim()) return;
    setAskBusy(true);
    try {
      await onAskAbout(mealId, askText.trim());
      setAskingId(null);
      setAskText("");
    } finally {
      setAskBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg">
      {/* Header */}
      <div className="px-5 pt-6 pb-4 flex items-center justify-between border-b border-border shrink-0">
        <div>
          <div className="text-[10px] text-white/40 uppercase tracking-wider">AI Coach</div>
          <h2 className="text-xl font-bold mt-0.5">Meal Review</h2>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-bg-elev border border-border text-white/50 hover:text-white/90 text-lg leading-none"
        >
          ×
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 pb-32">
        {reviewing ? (
          /* Loading skeletons */
          <div className="space-y-4 pt-2">
            <p className="text-sm text-white/40 text-center animate-pulse">
              Coach is reviewing your meals…
            </p>
            {[0, 1, 2].map((i) => (
              <div key={i} className="card p-4 space-y-3">
                <div className="flex gap-3">
                  <div className="w-14 h-14 rounded-lg bg-bg-elev animate-pulse shrink-0" />
                  <div className="flex-1 space-y-2 pt-1">
                    <div className="h-3 w-3/4 rounded bg-bg-elev animate-pulse" />
                    <div className="h-3 w-1/2 rounded bg-bg-elev animate-pulse" />
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {[0, 1, 2, 3].map((j) => (
                    <div key={j} className="h-16 rounded-lg bg-bg-elev animate-pulse" />
                  ))}
                </div>
                <div className="h-3 w-full rounded bg-bg-elev animate-pulse" />
              </div>
            ))}
          </div>
        ) : reviewData ? (
          <>
            {/* Summary */}
            <div className="card p-4 border-accent-brand/25">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-accent-brand mb-1.5">
                Summary
              </div>
              <p className="text-sm text-white/80 leading-snug">{reviewData.summary}</p>
            </div>

            {/* Per-meal cards */}
            {reviewData.reviews.map((r) => {
              const isAccepted = accepted.has(r.meal_id);
              return (
                <div
                  key={r.meal_id}
                  className={`card p-4 space-y-3 transition-opacity ${isAccepted ? "opacity-50" : ""}`}
                >
                  {/* Meal header */}
                  <div className="flex gap-3 items-start">
                    {r.photo_thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={r.photo_thumb}
                        alt=""
                        className="w-14 h-14 rounded-lg object-cover shrink-0"
                      />
                    ) : (
                      <div className="w-14 h-14 rounded-lg bg-bg-elev shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold truncate">
                        {r.description || "(unnamed)"}
                      </div>
                      <div
                        className={`text-[11px] mt-0.5 ${
                          r.confidence === "high"
                            ? "text-green-400/70"
                            : r.confidence === "medium"
                              ? "text-yellow-400/70"
                              : "text-white/40"
                        }`}
                      >
                        {r.confidence} confidence ·{" "}
                        {r.changed ? "corrections suggested" : "looks accurate"}
                      </div>
                    </div>
                    {isAccepted && (
                      <span className="text-green-400 text-base shrink-0 mt-1">✓</span>
                    )}
                  </div>

                  {/* Macro comparison: 4 cells, show old→new when changed */}
                  <div className="grid grid-cols-4 gap-1.5">
                    {(
                      [
                        { label: "Cal", cur: r.current.calories, sug: r.suggested.calories },
                        { label: "Pro", cur: r.current.protein_g, sug: r.suggested.protein_g },
                        { label: "Fat", cur: r.current.fat_g, sug: r.suggested.fat_g },
                        { label: "Carbs", cur: r.current.carbs_g, sug: r.suggested.carbs_g },
                      ] as const
                    ).map(({ label, cur, sug }) => {
                      const diff = sug - cur;
                      const significant = Math.abs(diff) >= 5;
                      return (
                        <div
                          key={label}
                          className="rounded-lg bg-bg-elev border border-border px-1.5 py-2 text-center"
                        >
                          <div className="text-[9px] text-white/40 uppercase mb-1">{label}</div>
                          {significant ? (
                            <>
                              <div className="text-[10px] text-white/25 line-through leading-tight">
                                {Math.round(cur)}
                              </div>
                              <div
                                className={`text-[13px] font-semibold leading-tight ${
                                  diff > 0 ? "text-yellow-400" : "text-sky-400"
                                }`}
                              >
                                {Math.round(sug)}
                              </div>
                              <div
                                className={`text-[9px] leading-tight ${
                                  diff > 0 ? "text-yellow-400/60" : "text-sky-400/60"
                                }`}
                              >
                                {diff > 0 ? "+" : ""}
                                {Math.round(diff)}
                              </div>
                            </>
                          ) : (
                            <div className="text-[13px] font-semibold text-white/70">
                              {Math.round(cur)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Explanation */}
                  <p className="text-[13px] text-white/65 leading-snug">{r.explanation}</p>

                  {/* Actions */}
                  {!isAccepted && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setAskingId(askingId === r.meal_id ? null : r.meal_id);
                          setAskText("");
                        }}
                        className="flex-1 rounded-lg border border-border bg-bg-elev py-2 text-[12px] text-white/60"
                      >
                        Ask about this
                      </button>
                      {r.changed && (
                        <button
                          onClick={() => handleAcceptOne(r)}
                          disabled={acceptBusy === r.meal_id}
                          className="flex-1 rounded-lg bg-accent-brand py-2 text-[12px] font-semibold disabled:opacity-40"
                        >
                          {acceptBusy === r.meal_id ? "Saving…" : "Accept"}
                        </button>
                      )}
                    </div>
                  )}

                  {/* Per-meal question input */}
                  {askingId === r.meal_id && (
                    <div className="flex gap-2">
                      <input
                        value={askText}
                        onChange={(e) => setAskText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) handleAsk(r.meal_id);
                        }}
                        placeholder="Ask about this meal…"
                        className="flex-1 rounded-lg bg-bg-elev border border-border px-3 py-2 text-[13px] focus:outline-none focus:border-white/30"
                        autoFocus
                      />
                      <button
                        onClick={() => handleAsk(r.meal_id)}
                        disabled={askBusy || !askText.trim()}
                        className="rounded-lg bg-accent-brand px-3 py-2 text-[12px] font-semibold disabled:opacity-40"
                      >
                        {askBusy ? "…" : "Send"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        ) : null}
      </div>

      {/* Footer */}
      {reviewData && (
        <div className="shrink-0 px-4 py-4 border-t border-border bg-bg-card/80 backdrop-blur">
          {changedCount > 0 ? (
            <button
              onClick={handleAcceptAll}
              disabled={acceptAllBusy}
              className="w-full rounded-xl bg-accent-brand py-3 text-sm font-semibold disabled:opacity-40"
            >
              {acceptAllBusy
                ? "Applying…"
                : `Accept All ${changedCount} Change${changedCount !== 1 ? "s" : ""}`}
            </button>
          ) : (
            <div className="text-center text-sm text-green-400/80 py-1">
              All macros look accurate ✓
            </div>
          )}
        </div>
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
        value={value || ""}
        onChange={(e) => onChange(Number(e.target.value.replace(/[^\d.]/g, "")) || 0)}
        className="flex-1 rounded-lg bg-bg-elev border border-border px-3 py-2 text-right text-[15px]"
      />
      <span className="text-xs text-white/40 w-10">{unit}</span>
    </div>
  );
}
