"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import Image from "next/image";
import clsx from "clsx";
import Link from "next/link";
import { safeFetchJson } from "@/lib/fetch-json";
import { compressImageFile, compressImageThumb } from "@/lib/compress-image";
import { useLang } from "@/components/LangProvider";
import { useBackgroundTasks } from "@/components/BackgroundTasks";
import { MealIcon, MEAL_ICON_IDS } from "@/components/MealIcon";
import { t, type Lang, type TKey } from "@/lib/i18n";
import ItemPortions from "@/components/ItemPortions";
import MealInbox from "@/components/MealInbox";
import { applyPortions, itemsWithPortions, fullPortions } from "@/lib/portions";
import { photoTakenAt, localDateKey } from "@/lib/photo-date";
import { saveToDevice } from "@/lib/save-to-device";

const ANALYZE_TASK = "meal-analyze";

type Analysis = {
  /** Round-trip time of the model call, attached by the analyze route. */
  _latencyMs?: number;
  _model?: string;
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
  photo_path_2: string | null;
  photo_thumb_2: string | null;
  items_json: string | null;
  ai_tip: string | null;
  icon: string | null;
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

// Instant-paint cache, same pattern as Home/Stats/Workouts: hydrate from
// the last snapshot immediately, refresh from the API in the background.
function lsGet<T>(key: string): T | null {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : null; } catch { return null; }
}
function lsSet(key: string, val: unknown) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

const ALLIN_WHEY = { cal: 127, protein: 23, fat: 1.2, carbs: 3.6 };
const PROTEIN_BASES = ["מים", "חלב", "חלב שקדים", "חלב שיבולת שועל", "מיץ תפוזים", "קפה"];

/** A picked photo in batch mode, compressed, with its capture time. */
type BatchPhoto = {
  preview: string; // compressed data URI for display
  base64: string;
  thumbBase64: string;
  file: File;
  /** Capture time (EXIF, else file mtime), epoch ms. */
  ts: number | null;
};

/** One entry in batch-logging mode — one meal, from one photo or two taken
 *  moments apart. Carries the compressed images, the day the photos were
 *  taken, the user's optional note, and the full per-item analysis
 *  lifecycle (including a clarifying-question round, same as the
 *  single-meal flow). */
type BatchItem = {
  id: number;
  photos: BatchPhoto[]; // 1–2
  date: string; // YYYY-MM-DD, from the photo; editable
  hint: string;
  status: "ready" | "analyzing" | "done" | "error" | "saved";
  analysis: Analysis | null;
  editing: { calories: number; protein_g: number; fat_g: number; carbs_g: number } | null;
  fractions: number[];
  clarifyAnswer: string;
  clarifying: boolean;
  error: string | null;
};

// Two shots of the same meal (another angle, the label on the back) are
// taken seconds-to-minutes apart; separate meals are much further apart.
const BATCH_GROUP_WINDOW_MS = 5 * 60 * 1000;

// Monotonic id source for batch items. The previous `Date.now() + index`
// scheme could collide (Date.now() was read after per-photo compression,
// whose duration varies), and a duplicated id made typing/analysis updates
// fan out to every item sharing it.
let _batchItemSeq = 0;
function nextBatchItemId(): number {
  _batchItemSeq += 1;
  return _batchItemSeq;
}

function newBatchItem(photos: BatchPhoto[], date: string, hint = ""): BatchItem {
  return {
    id: nextBatchItemId(),
    photos,
    date,
    hint,
    status: "ready",
    analysis: null,
    editing: null,
    fractions: [],
    clarifyAnswer: "",
    clarifying: false,
    error: null,
  };
}

/** Chronological, then one meal per photo — except that a photo taken within
 *  the window of the previous one joins it (max two photos per meal, the
 *  analyzer's limit). Photos with no known time each become their own meal
 *  on the fallback date. */
function groupBatchPhotos(photos: BatchPhoto[], fallbackDate: string): BatchItem[] {
  const sorted = [...photos].sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity));
  const out: BatchItem[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    const prevTs = last?.photos[last.photos.length - 1].ts;
    if (
      last &&
      last.photos.length < 2 &&
      p.ts != null &&
      prevTs != null &&
      p.ts - prevTs <= BATCH_GROUP_WINDOW_MS
    ) {
      last.photos.push(p);
      continue;
    }
    out.push(newBatchItem([p], p.ts != null ? localDateKey(p.ts) : fallbackDate));
  }
  return out;
}

/** By day, then by capture time within the day. */
function sortBatch(items: BatchItem[]): BatchItem[] {
  return [...items].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.photos[0].ts ?? Infinity) - (b.photos[0].ts ?? Infinity),
  );
}

// Must match the cache name public/sw.js writes shared photos into.
const SHARED_PHOTOS_CACHE = "shared-photos";

/** Drain the photos the service worker stashed from a Share → Health. */
async function takeSharedPhotos(): Promise<File[]> {
  if (!("caches" in window)) return [];
  const cache = await caches.open(SHARED_PHOTOS_CACHE);
  const keys = await cache.keys();
  const files: File[] = [];
  for (const req of keys) {
    const res = await cache.match(req);
    if (res) {
      const blob = await res.blob();
      files.push(
        new File([blob], decodeURIComponent(res.headers.get("x-name") || "shared.jpg"), {
          type: blob.type || "image/jpeg",
          lastModified: Number(res.headers.get("x-last-modified")) || Date.now(),
        }),
      );
    }
    await cache.delete(req);
  }
  return files;
}

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

// In-progress new-meal draft, held at MODULE scope so it survives
// client-side navigation (persists across route changes; cleared on a full
// reload). Lets the user pick a photo / kick off an analysis, switch pages,
// and return to the logger with everything intact — mirroring how the coach
// keeps its request going in the background.
type MealDraft = {
  text: string;
  photoPreview: string | null;
  photoBase64: string | null;
  photoThumbBase64: string | null;
  photoExt: string;
  compressedFile: File | null;
  photoPreview2: string | null;
  photoBase64_2: string | null;
  photoThumbBase64_2: string | null;
  photoExt2: string;
  compressedFile2: File | null;
  photoSource: "camera" | "gallery" | null;
  analysis: Analysis | null;
  editing: { calories: number; protein_g: number; fat_g: number; carbs_g: number } | null;
  fractions: number[];
};
let mealDraft: MealDraft | null = null;

export default function LogMealPage() {
  const lang = useLang();
  const bg = useBackgroundTasks();
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  // Second (optional) photo — e.g. the back of a package or another
  // angle of the plate.
  const camera2Ref = useRef<HTMLInputElement>(null);
  const gallery2Ref = useRef<HTMLInputElement>(null);
  // Batch mode: each selected photo becomes its own meal.
  const batchRef = useRef<HTMLInputElement>(null);

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
  // Optional second photo — same shape as the fields above, for the
  // "other side" shot (e.g. nutrition label on the back of a package).
  const [photoPreview2, setPhotoPreview2] = useState<string | null>(null);
  const [photoBase64_2, setPhotoBase64_2] = useState<string | null>(null);
  const [photoExt2, setPhotoExt2] = useState<string>("jpg");
  const [compressedFile2, setCompressedFile2] = useState<File | null>(null);
  const [photoThumbBase64_2, setPhotoThumbBase64_2] = useState<string | null>(null);
  const [text, setText] = useState(""); // description/hint/context
  // How the FIRST photo was added — so the "add second photo" button opens the
  // SAME picker (gallery→gallery, camera→camera) instead of always defaulting
  // to the camera. Mirrors what the user did for photo #1.
  const [photoSource, setPhotoSource] = useState<"camera" | "gallery" | null>(null);

  // Analysis runs in the background provider so it survives navigation;
  // "analyzing" reflects that pending state rather than a local flag.
  const analyzing = bg.isPending(ANALYZE_TASK);
  const [saving, setSaving] = useState(false);
  // Granular step label, surfaced in the action button so the user knows
  // which stage is taking time. Cleared back to null when idle.
  const [progress, setProgress] = useState<string | null>(null);
  // Staged pipeline labels for the analyze call. The request itself is a single
  // (non-streaming) POST, so we advance through the phases on a timer — the
  // early phases (upload / reading) are genuinely accurate, and the later ones
  // describe what the model is doing while we wait. Photo and text modes have
  // slightly different pipelines, so the stage list depends on whether a photo
  // is attached at the moment analysis starts.
  const analyzeStages = useMemo(
    () => (photoPreview ? photoAnalyzeStages(lang) : textAnalyzeStages(lang)),
    [lang, photoPreview],
  );
  const analyzeStageLabel = useStagedLabel(analyzing, analyzeStages);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [editing, setEditing] = useState<{
    calories: number;
    protein_g: number;
    fat_g: number;
    carbs_g: number;
  } | null>(null);
  // Per-item eaten fraction (1 = all of it), parallel to analysis.items.
  const [fractions, setFractions] = useState<number[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // Success line, e.g. "Saved 7 meals across 3 days" after a batch.
  const [notice, setNotice] = useState<string | null>(null);
  // Shown after a successful save: deterministic "day so far" summary
  // computed from the reloaded meal list + profile targets. Replaces the
  // old LLM-written tip, which kept getting the arithmetic wrong (it
  // double-counted the just-saved meal).
  const [showDaySummary, setShowDaySummary] = useState(false);
  const [goals, setGoals] = useState<{ calories: number; protein_g: number } | null>(null);
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
  // Description of the frequent-meal chip currently logging from the
  // quick-add carousel, so just that chip shows a spinner.
  const [chipBusy, setChipBusy] = useState<string | null>(null);

  // Manual entry state
  const [manualMode, setManualMode] = useState(false);
  const [manualDesc, setManualDesc] = useState("");
  const [manualMacros, setManualMacros] = useState({ calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 });
  const [manualSaving, setManualSaving] = useState(false);

  // Protein powder state
  const [proteinMode, setProteinMode] = useState(false);
  const [proteinBase, setProteinBase] = useState<string>(PROTEIN_BASES[0]);
  const [proteinSaving, setProteinSaving] = useState(false);

  // Creatine one-tap log (no parameters — creatine has no macros).
  const [creatineBusy, setCreatineBusy] = useState(false);

  // Batch-logging state — null means not in batch mode.
  const [batch, setBatch] = useState<BatchItem[] | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);

  // Coach review state
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewData, setReviewData] = useState<ReviewResult | null>(null);

  // Tap-to-zoom for the photo preview
  const [lightboxSrc, setLightboxSrc] = useState<string | string[] | null>(null);

  const loadExisting = useCallback(async (forDate: string) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    try {
      const r = await fetch(`/api/meals?date=${forDate}`, { cache: "no-store", signal: ac.signal });
      const j = await r.json();
      setExisting(j.meals || []);
      lsSet(`log-existing-${forDate}`, j.meals || []);
    } catch {
      // non-fatal
    } finally {
      clearTimeout(timer);
      setExistingLoading(false);
    }
  }, []);

  // Reload existing meals whenever the date changes — painting the cached
  // snapshot for that date first so the list doesn't blank out.
  useEffect(() => {
    setExistingEditId(null);
    const cached = lsGet<ExistingMeal[]>(`log-existing-${date}`);
    if (cached) {
      setExisting(cached);
      setExistingLoading(false);
    } else {
      setExistingLoading(true);
    }
    loadExisting(date);
  }, [date, loadExisting]);

  // Frequent meals are global; paint the cached list instantly, then
  // refresh in the background.
  useEffect(() => {
    const cached = lsGet<FrequentMeal[]>("log-frequent-v1");
    if (cached) {
      setFrequent(cached);
      setFrequentLoading(false);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    (async () => {
      try {
        const r = await fetch("/api/meals/frequent", { cache: "no-store", signal: ac.signal });
        const j = await r.json();
        setFrequent(j.meals || []);
        lsSet("log-frequent-v1", j.meals || []);
      } catch {
        // non-fatal
      } finally {
        clearTimeout(timer);
        setFrequentLoading(false);
      }
    })();
    return () => { ac.abort(); clearTimeout(timer); };
  }, []);

  // Targets for the post-save "day so far" summary — hydrate from cache,
  // refresh once per page load.
  useEffect(() => {
    const cached = lsGet<{ calories: number; protein_g: number }>("log-goals-v1");
    if (cached) setGoals(cached);
    (async () => {
      try {
        const r = await fetch("/api/profile", { cache: "no-store" });
        const j = await r.json();
        if (j?.profile?.goal_calories) {
          const g = {
            calories: j.profile.goal_calories,
            protein_g: j.profile.goal_protein_g ?? 0,
          };
          setGoals(g);
          lsSet("log-goals-v1", g);
        }
      } catch {
        // non-fatal — summary just shows totals without targets
      }
    })();
  }, []);

  // A new date means a different day's ledger — stale summary would lie.
  useEffect(() => {
    setShowDaySummary(false);
  }, [date]);

  // --- New-meal draft persistence across navigation ---
  // On mount, restore any in-progress draft (photo/text/analysis) so a photo
  // added before leaving is still here; also pick up an analysis that
  // finished in the background while we were away.
  useEffect(() => {
    if (mealDraft) {
      const d = mealDraft;
      setText(d.text);
      setPhotoPreview(d.photoPreview);
      setPhotoBase64(d.photoBase64);
      setPhotoThumbBase64(d.photoThumbBase64);
      setPhotoExt(d.photoExt);
      setCompressedFile(d.compressedFile);
      setPhotoPreview2(d.photoPreview2);
      setPhotoBase64_2(d.photoBase64_2);
      setPhotoThumbBase64_2(d.photoThumbBase64_2);
      setPhotoExt2(d.photoExt2);
      setCompressedFile2(d.compressedFile2);
      setPhotoSource(d.photoSource);
      if (d.analysis) {
        applyAnalysis(d.analysis);
        if (d.editing) setEditing(d.editing);
        if (d.fractions.length) setFractions(d.fractions);
      }
    }
    const done = bg.consume(ANALYZE_TASK);
    if (done?.status === "done" && done.result?.analysis) {
      applyAnalysis(done.result.analysis as Analysis, done.result as any);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the draft to module scope whenever it changes, so navigating
  // away and back keeps the photo/text/analysis. Cleared once nothing is
  // in progress (i.e. after a save or discard).
  useEffect(() => {
    const hasDraft = !!(photoPreview || photoPreview2 || text.trim() || analysis);
    mealDraft = hasDraft
      ? {
          text,
          photoPreview,
          photoBase64,
          photoThumbBase64,
          photoExt,
          compressedFile,
          photoPreview2,
          photoBase64_2,
          photoThumbBase64_2,
          photoExt2,
          compressedFile2,
          photoSource,
          analysis,
          editing,
          fractions,
        }
      : null;
  }, [
    text, photoPreview, photoBase64, photoThumbBase64, photoExt, compressedFile,
    photoPreview2, photoBase64_2, photoThumbBase64_2, photoExt2, compressedFile2,
    photoSource, analysis, editing, fractions,
  ]);

  // Apply the analysis when the background task finishes while we're on the
  // page (stayed, or returned mid-flight).
  const wasAnalyzing = useRef(false);
  useEffect(() => {
    if (wasAnalyzing.current && !analyzing) {
      const done = bg.consume(ANALYZE_TASK);
      if (done?.status === "done" && done.result?.analysis) {
        applyAnalysis(done.result.analysis as Analysis, done.result as any);
      } else if (done?.status === "error") {
        setErr(done.error ?? "analyze failed");
      }
    }
    wasAnalyzing.current = analyzing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzing]);

  async function loadPhotoIntoSlot1(f: File) {
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
  }

  async function loadPhotoIntoSlot2(f: File) {
    const [compressed, thumb] = await Promise.all([
      compressImageFile(f),
      compressImageThumb(f),
    ]);
    const blob = await (await fetch(compressed.dataUri)).blob();
    const compFile = new File([blob], "meal2.jpg", { type: "image/jpeg" });
    setCompressedFile2(compFile);
    setPhotoPreview2(compressed.dataUri);
    setPhotoBase64_2(compressed.base64);
    setPhotoThumbBase64_2(thumb.base64);
    setPhotoExt2("jpg");
  }

  // Camera capture: same as picking one photo into slot 1, but we also save
  // the original to the phone since a captured photo isn't stored otherwise.
  async function onPickCamera(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    saveToDevice(f);
    setPhotoSource("camera");
    setErr(null);
    setAnalysis(null);
    setEditing(null);
    setProgress(t(lang, "meal_compress"));
    try {
      await loadPhotoIntoSlot1(f);
    } catch (err: any) {
      setErr(err?.message || t(lang, "meal_err_read_photo"));
    } finally {
      setProgress(null);
    }
  }

  // Gallery picks allow selecting 2 photos at once (e.g. the burger and the
  // salad next to it) — the first fills slot 1, and if a second file was
  // selected and slot 2 is still empty, it fills slot 2 too.
  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    const f = files?.[0];
    if (!f) return;
    setPhotoSource("gallery");
    const f2 = !photoPreview2 ? files?.[1] : undefined;
    setErr(null);
    setAnalysis(null);
    setEditing(null);
    setProgress(t(lang, "meal_compress"));
    try {
      await Promise.all([
        loadPhotoIntoSlot1(f),
        f2 ? loadPhotoIntoSlot2(f2) : Promise.resolve(),
      ]);
    } catch (err: any) {
      setErr(err?.message || t(lang, "meal_err_read_photo"));
    } finally {
      setProgress(null);
    }
  }

  async function onPick2(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr(null);
    setProgress(t(lang, "meal_compress"));
    try {
      await loadPhotoIntoSlot2(f);
    } catch (err: any) {
      setErr(err?.message || t(lang, "meal_err_read_photo"));
    } finally {
      setProgress(null);
    }
  }

  // Second photo captured with the camera — like slot 1's camera handler, we
  // also save the original to the device (a capture isn't stored otherwise).
  async function onPickCamera2(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    saveToDevice(f);
    setErr(null);
    setProgress(t(lang, "meal_compress"));
    try {
      await loadPhotoIntoSlot2(f);
    } catch (err: any) {
      setErr(err?.message || t(lang, "meal_err_read_photo"));
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

  function pickedFile2(): File | null {
    if (compressedFile2) return compressedFile2;
    return (
      camera2Ref.current?.files?.[0] || gallery2Ref.current?.files?.[0] || null
    );
  }

  function clearPhoto2() {
    setPhotoPreview2(null);
    setPhotoBase64_2(null);
    setPhotoThumbBase64_2(null);
    setCompressedFile2(null);
    if (camera2Ref.current) camera2Ref.current.value = "";
    if (gallery2Ref.current) gallery2Ref.current.value = "";
  }

  function clearPhoto() {
    setPhotoPreview(null);
    setPhotoBase64(null);
    setPhotoThumbBase64(null);
    setCompressedFile(null);
    setPhotoSource(null);
    if (cameraRef.current) cameraRef.current.value = "";
    if (galleryRef.current) galleryRef.current.value = "";
    clearPhoto2();
  }

  // ---- Batch mode: N photos -> N meals ----
  // Each photo's own capture time decides its day, so a multi-day backlog
  // can be picked in one go. Shots taken minutes apart (another angle, the
  // label on the back) are grouped into one meal.

  async function addBatchFiles(files: File[]) {
    if (files.length === 0) return;
    setErr(null);
    setNotice(null);
    setProgress(t(lang, "meal_compress"));
    try {
      const photos = await Promise.all(
        files.map(async (f, i): Promise<BatchPhoto> => {
          // EXIF must be read from the original — compression drops it.
          const [ts, compressed, thumb] = await Promise.all([
            photoTakenAt(f),
            compressImageFile(f),
            compressImageThumb(f),
          ]);
          const blob = await (await fetch(compressed.dataUri)).blob();
          const compFile = new File([blob], `meal-batch-${i}.jpg`, { type: "image/jpeg" });
          return {
            preview: compressed.dataUri,
            base64: compressed.base64,
            thumbBase64: thumb.base64,
            file: compFile,
            ts,
          };
        }),
      );
      const items = groupBatchPhotos(photos, date);
      setBatch((prev) => [...(prev ?? []), ...items]);
    } catch (err: any) {
      setErr(err?.message || t(lang, "meal_err_read_photos"));
    } finally {
      setProgress(null);
      if (batchRef.current) batchRef.current.value = "";
    }
  }

  function onPickBatch(e: React.ChangeEvent<HTMLInputElement>) {
    addBatchFiles(Array.from(e.target.files ?? []));
  }

  // Photos shared from the Android gallery (Share → Health) are stashed by
  // the service worker; pick them up into batch mode.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("shared")) return;
    window.history.replaceState(null, "", window.location.pathname);
    (async () => {
      try {
        const files = await takeSharedPhotos();
        if (files.length) addBatchFiles(files);
      } catch {
        setErr(t(lang, "meal_err_shared_photos"));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function patchBatchItem(id: number, patch: Partial<BatchItem>) {
    setBatch((prev) =>
      prev ? prev.map((it) => (it.id === id ? { ...it, ...patch } : it)) : prev,
    );
  }

  /** Undo an automatic grouping: the second photo becomes its own meal. */
  function splitBatchItem(id: number) {
    setBatch((prev) => {
      if (!prev) return prev;
      return prev.flatMap((it) => {
        if (it.id !== id || it.photos.length < 2) return [it];
        const [a, b] = it.photos;
        return [
          newBatchItem([a], it.date, it.hint),
          newBatchItem([b], b.ts != null ? localDateKey(b.ts) : it.date),
        ];
      });
    });
  }

  async function analyzeBatchItem(item: BatchItem, extraHint?: string) {
    patchBatchItem(item.id, { status: "analyzing", error: null, clarifying: !!extraHint });
    try {
      const fd = new FormData();
      fd.append("photo", item.photos[0].file);
      if (item.photos[1]) fd.append("photo2", item.photos[1].file);
      const hint = [item.hint.trim(), extraHint].filter(Boolean).join(". ");
      if (hint) fd.append("hint", hint);
      const j = await safeFetchJson<{ analysis: Analysis }>(
        "/api/meals/analyze",
        { method: "POST", body: fd },
      );
      patchBatchItem(item.id, {
        status: "done",
        clarifying: false,
        clarifyAnswer: "",
        analysis: j.analysis,
        fractions: fullPortions(j.analysis.items?.length ?? 0),
        editing: {
          calories: j.analysis.total.calories,
          protein_g: j.analysis.total.protein_g,
          fat_g: j.analysis.total.fat_g,
          carbs_g: j.analysis.total.carbs_g,
        },
      });
    } catch (e: any) {
      patchBatchItem(item.id, {
        status: "error",
        clarifying: false,
        error: e?.message ?? "analyze failed",
      });
    }
  }

  async function analyzeAllBatch() {
    if (!batch) return;
    setBatchBusy(true);
    try {
      // All items in parallel — each is an independent /api/meals/analyze
      // call, so a 6-meal backlog costs roughly one analysis wait, not six.
      await Promise.all(
        batch
          .filter((it) => it.status === "ready" || it.status === "error")
          .map((it) => analyzeBatchItem(it)),
      );
    } finally {
      setBatchBusy(false);
    }
  }

  async function saveAllBatch() {
    if (!batch) return;
    setBatchBusy(true);
    setErr(null);
    const savedDays = new Set<string>();
    let savedCount = 0;
    try {
      // Sequential saves: keeps insert order stable and avoids a burst of
      // concurrent writes for what is at most ~a dozen rows.
      for (const it of sortBatch(batch)) {
        if (it.status !== "done" || !it.analysis || !it.editing) continue;
        const [p1, p2] = it.photos;
        await safeFetchJson<{ ok: true; id: number }>("/api/meals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            date: it.date,
            description: it.analysis.description,
            // The user's per-photo note (hint), kept verbatim for the coach.
            note: it.hint.trim() || undefined,
            calories: it.editing.calories,
            protein_g: it.editing.protein_g,
            fat_g: it.editing.fat_g,
            carbs_g: it.editing.carbs_g,
            items: itemsWithPortions(it.analysis.items, it.fractions),
            confidence: it.analysis.confidence,
            photo_base64: p1.base64,
            photo_thumb_base64: p1.thumbBase64,
            photo_ext: "jpg",
            photo_base64_2: p2?.base64,
            photo_thumb_base64_2: p2?.thumbBase64,
            photo_ext_2: p2 ? "jpg" : undefined,
          }),
        });
        patchBatchItem(it.id, { status: "saved" });
        savedDays.add(it.date);
        savedCount += 1;
      }
      await loadExisting(date);
      refreshFrequentMeals();
      setBatch(null);
      if (savedDays.has(date)) setShowDaySummary(true);
      setNotice(
        t(lang, "meal_batch_saved")
          .replace("{n}", String(savedCount))
          .replace("{d}", String(savedDays.size)),
      );
    } catch (e: any) {
      // Saved items are already flagged "saved", so a retry only re-sends
      // the ones that didn't make it.
      setErr(e?.message ?? "save failed");
    } finally {
      setBatchBusy(false);
    }
  }

  function resetNewMealForm() {
    setAnalysis(null);
    setEditing(null);
    setFractions([]);
    setText("");
    setClarifyAnswer("");
    clearPhoto();
  }

  /** `meta` carries the route's timing/model, attached so the result card can
   *  show what the call actually cost. */
  function applyAnalysis(a: Analysis, meta?: { latencyMs?: number; model?: string }) {
    setAnalysis({ ...a, _latencyMs: meta?.latencyMs, _model: meta?.model });
    setFractions(fullPortions(a.items?.length ?? 0));
    setEditing({
      calories: a.total.calories,
      protein_g: a.total.protein_g,
      fat_g: a.total.fat_g,
      carbs_g: a.total.carbs_g,
    });
  }

  function analyze() {
    const f = pickedFile();
    const hasPhoto = !!f;
    const hasText = !!text.trim();
    if (!hasPhoto && !hasText) {
      setErr(t(lang, "meal_err_need_input"));
      return;
    }
    setErr(null);
    const fd = new FormData();
    if (f) fd.append("photo", f);
    const f2 = pickedFile2();
    if (f2) fd.append("photo2", f2);
    if (hasText) {
      // When a photo is present, text is context; otherwise text is the description.
      fd.append(hasPhoto ? "hint" : "text", text.trim());
    }
    // Runs in the background provider (not awaited here) so leaving the page
    // mid-analysis keeps it going with the global spinner, and the result is
    // applied by the analyze-transition effect — whether we stayed or came
    // back. `analyzing` is derived from the provider's pending state.
    bg.run(
      ANALYZE_TASK,
      () =>
        safeFetchJson<{ analysis: Analysis; latencyMs?: number; model?: string }>(
          "/api/meals/analyze",
          { method: "POST", body: fd },
        ),
      { label: t(lang, "meal_analyzing") },
    ).catch((e: any) => setErr(e?.message ?? "analyze failed"));
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
        const f2 = pickedFile2();
        if (f2) fd.append("photo2", f2);
        fd.append("hint", [text.trim(), qa].filter(Boolean).join(". "));
      } else {
        fd.append("text", [text.trim(), qa].filter(Boolean).join(". "));
      }
      const j = await safeFetchJson<{ analysis: Analysis }>(
        "/api/meals/analyze",
        { method: "POST", body: fd },
      );
      applyAnalysis(j.analysis as Analysis);
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
      const j = await safeFetchJson<{ ok: true; id: number }>(
        "/api/meals",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            date,
            description: analysis.description,
            // Keep the user's own note/description verbatim so the coach can
            // read what they actually said, not just the AI's description.
            note: text.trim() || undefined,
            calories: editing.calories,
            protein_g: editing.protein_g,
            fat_g: editing.fat_g,
            carbs_g: editing.carbs_g,
            items: itemsWithPortions(analysis.items, fractions),
            confidence: analysis.confidence,
            photo_base64: photoBase64 ?? undefined,
            photo_thumb_base64: photoThumbBase64 ?? undefined,
            photo_ext: photoExt,
            photo_base64_2: photoBase64_2 ?? undefined,
            photo_thumb_base64_2: photoThumbBase64_2 ?? undefined,
            photo_ext_2: photoExt2,
          }),
        },
      );
      // Reload list, clear form, surface the deterministic day summary.
      await loadExisting(date);
      resetNewMealForm();
      refreshFrequentMeals();
      setShowDaySummary(true);

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
      const j = await safeFetchJson<{ ok: true; id: number }>(
        "/api/meals",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...toSave, date }),
        },
      );
      await loadExisting(date);
      setExpandedIdx(null);
      setModifier("");
      refreshFrequentMeals();
      setShowDaySummary(true);

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
    setProgress(t(lang, "meal_saving"));
    try {
      const j = await safeFetchJson<{ ok: true; id: number }>(
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
      refreshFrequentMeals();
      setShowDaySummary(true);

    } catch (e: any) {
      setErr(e.message);
    } finally {
      setManualSaving(false);
      setProgress(null);
    }
  }

  /** One-tap creatine log. Creatine has no calories/macros, so this saves a
   *  zero-macro marker meal instantly — no picker, no parameters — just to
   *  record that it was taken today. */
  async function saveCreatine() {
    if (creatineBusy) return;
    setCreatineBusy(true);
    setErr(null);
    try {
      await safeFetchJson("/api/meals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date,
          description: t(lang, "meal_creatine"),
          calories: 0,
          protein_g: 0,
          fat_g: 0,
          carbs_g: 0,
          confidence: "high",
          icon: "shake",
          items: [{ type: "creatine", name: t(lang, "meal_creatine"), portion: "5g" }],
        }),
      });
      await loadExisting(date);
      refreshFrequentMeals();
      setShowDaySummary(true);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setCreatineBusy(false);
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
    fields: Partial<Pick<ExistingMeal, "description" | "calories" | "protein_g" | "fat_g" | "carbs_g" | "icon"> & { date: string }>,
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

  // Running total for the selected day — the header shows it against the
  // profile targets so you can see what a meal will do before logging it.
  const dayTotals = existing.reduce(
    (acc, m) => {
      acc.calories += m.calories ?? 0;
      acc.protein_g += m.protein_g ?? 0;
      return acc;
    },
    { calories: 0, protein_g: 0 },
  );
  const idle = !photoPreview && !analysis && !manualMode && !proteinMode && !batch;
  const saveLabel = isToday
    ? t(lang, "meal_confirm_save")
    : `${t(lang, "meal_save_to")} ${prettyDate(date, lang)}`;

  return (
    <div className="px-5 pt-6 pb-10 space-y-6 md:max-w-3xl md:mx-auto">
      {/* --- HEADER: title, day stepper, day-so-far --- */}
      <header className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold">{t(lang, "meal_title")}</h1>
            <p className="text-sm text-ink/60 mt-1">
              {isToday
                ? t(lang, "meal_subtitle_today")
                : `${t(lang, "meal_subtitle_past")} ${prettyDate(date, lang)}.`}
            </p>
          </div>
        </div>

        <div className="card p-3 space-y-3">
          <div className="flex items-center gap-2">
            <IconButton
              label={t(lang, "meal_prev_day")}
              onClick={() => setDate(shiftDate(date, -1))}
            >
              <ChevronIcon className="h-5 w-5 rtl:rotate-180" />
            </IconButton>
            {/* The native picker sits invisibly over the label, so tapping the
                date opens the platform calendar. No `max`: on Android Chrome a
                mid-month max disabled the next-month arrow and trapped users;
                the Today chip is the way back. */}
            <label className="relative flex-1 min-w-0 h-11 rounded-xl bg-bg-elev border border-border flex items-center justify-center gap-2 cursor-pointer state-layer">
              <CalendarIcon className="h-4 w-4 text-ink/50" aria-hidden="true" />
              <span className="text-sm font-semibold truncate">{prettyDate(date, lang)}</span>
              <input
                type="date"
                value={date}
                aria-label={t(lang, "meal_pick_date")}
                onChange={(e) => setDate(e.target.value || todayStr())}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
            </label>
            <IconButton
              label={t(lang, "meal_next_day")}
              onClick={() => setDate(shiftDate(date, 1))}
              disabled={isToday}
            >
              <ChevronIcon className="h-5 w-5 rotate-180 rtl:rotate-0" />
            </IconButton>
            {!isToday && (
              <button
                onClick={() => setDate(todayStr())}
                className="h-11 rounded-xl px-3 text-[13px] font-semibold text-accent-primary bg-accent-sec-container/60 state-layer"
              >
                {t(lang, "meal_today_btn")}
              </button>
            )}
          </div>

          {goals && (
            <div className="grid grid-cols-2 gap-3">
              <DayMeter
                label={t(lang, "macro_calories")}
                value={dayTotals.calories}
                target={goals.calories}
                unit={t(lang, "macro_kcal")}
                barClass="bg-accent-cal"
              />
              <DayMeter
                label={t(lang, "macro_protein")}
                value={dayTotals.protein_g}
                target={goals.protein_g}
                unit="g"
                barClass="bg-accent-protein"
              />
            </div>
          )}
        </div>
      </header>

      {/* --- QUICK-SNAP INBOX: snapped with a note, analyzed, awaiting confirm --- */}
      {!batch && (
        <MealInbox
          lang={lang}
          onZoom={(srcs) => setLightboxSrc(srcs)}
          onConfirmed={(days) => {
            refreshFrequentMeals();
            if (days.includes(date)) {
              loadExisting(date);
              setShowDaySummary(true);
            }
          }}
        />
      )}

      {/* --- NEW MEAL: capture (idle) --- */}
      {idle && (
        <section className="card p-4 space-y-4" aria-label={t(lang, "meal_new_meal")}>
          <button
            onClick={() => cameraRef.current?.click()}
            className="w-full rounded-2xl bg-brand-gradient shadow-brand px-5 py-5 flex items-center gap-4 text-start state-layer"
          >
            <span className="w-14 h-14 rounded-2xl bg-on-brand/15 flex items-center justify-center shrink-0">
              <CameraIcon className="h-7 w-7 text-on-brand" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-lg font-bold text-on-brand">{t(lang, "meal_take_photo")}</span>
              <span className="block text-[13px] text-on-brand/75 mt-0.5">{t(lang, "meal_analyze_photo")}</span>
            </span>
          </button>
          <div className="grid grid-cols-2 gap-2">
            <TonalButton onClick={() => galleryRef.current?.click()}>
              <GalleryIcon className="h-5 w-5" aria-hidden="true" />
              {t(lang, "meal_from_gallery")}
            </TonalButton>
            <TonalButton onClick={() => batchRef.current?.click()}>
              <StackIcon className="h-5 w-5" aria-hidden="true" />
              <span className="truncate">{t(lang, "meal_batch_title")}</span>
            </TonalButton>
          </div>
          <Link
            href="/meals/snap"
            className="h-12 rounded-xl border border-border bg-bg-elev px-3 text-[13px] font-medium text-ink/80 flex items-center justify-center gap-2 state-layer"
          >
            <BoltIcon className="h-5 w-5 text-accent-primary" aria-hidden="true" />
            <span className="truncate">{t(lang, "meal_snap_button")}</span>
          </Link>

          <div className="flex items-center gap-3 text-[12px] text-ink/45">
            <span className="h-px flex-1 bg-border" />
            {t(lang, "meal_or_describe_inline")}
            <span className="h-px flex-1 bg-border" />
          </div>

          <DescribeField
            lang={lang}
            label={t(lang, "meal_describe_label")}
            placeholder={t(lang, "meal_describe_placeholder")}
            value={text}
            onChange={setText}
          />
          {text.trim() && (
            <PrimaryButton onClick={analyze} disabled={analyzing || !!progress}>
              {analyzing ? (
                <AiThinkingPill label={progress || analyzeStageLabel} />
              ) : (
                progress || t(lang, "meal_analyze_text")
              )}
            </PrimaryButton>
          )}
        </section>
      )}

      {/* --- QUICK ADD: one-tap supplements --- */}
      {idle && (
        <section className="space-y-2">
          <SectionTitle>{t(lang, "meal_quick_add")}</SectionTitle>
          <div className="flex gap-2 overflow-x-auto scrollbar-hide -mx-1 px-1 pb-1">
            <ChipButton onClick={() => { setProteinMode(true); setErr(null); }}>
              <ShakerIcon className="h-4 w-4 text-accent-primary" aria-hidden="true" />
              {t(lang, "meal_protein_powder")}
            </ChipButton>
            <ChipButton onClick={saveCreatine} disabled={creatineBusy}>
              <CreatineIcon className="h-4 w-4 text-accent-primary" aria-hidden="true" />
              {t(lang, "meal_creatine")}
              {creatineBusy && <Spinner />}
            </ChipButton>
          </div>
        </section>
      )}

      {/* --- PROTEIN POWDER QUICK-LOG --- */}
      {proteinMode && !analysis && !batch && (
        <section className="card p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <span className="w-10 h-10 rounded-xl bg-accent-sec-container flex items-center justify-center shrink-0">
                <ShakerIcon className="h-5 w-5 text-accent-on-sec-container" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold truncate">{t(lang, "meal_protein_product")}</h2>
                <div className="text-[12px] text-ink/50">{t(lang, "meal_protein_scoop")}</div>
              </div>
            </div>
            <TextButton onClick={() => { setProteinMode(false); setErr(null); }}>
              {t(lang, "meal_cancel")}
            </TextButton>
          </div>

          <MacroSummary
            lang={lang}
            macros={{
              calories: ALLIN_WHEY.cal,
              protein_g: ALLIN_WHEY.protein,
              fat_g: ALLIN_WHEY.fat,
              carbs_g: ALLIN_WHEY.carbs,
            }}
          />

          <label className="block">
            <span className="block text-xs font-medium text-ink/60 mb-1.5">{t(lang, "meal_protein_with")}</span>
            <select
              value={proteinBase}
              onChange={(e) => setProteinBase(e.target.value)}
              dir="rtl"
              className="w-full h-12 rounded-xl bg-bg-elev border border-border px-4 text-[15px] text-ink"
            >
              {PROTEIN_BASES.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </label>

          <PrimaryButton onClick={saveProtein} disabled={proteinSaving}>
            {proteinSaving
              ? t(lang, "meal_saving_short")
              : isToday
                ? t(lang, "meal_save")
                : `${t(lang, "meal_save_to")} ${prettyDate(date, lang)}`}
          </PrimaryButton>
        </section>
      )}

      {/* --- PHOTO PICKED: preview, second angle, notes --- */}
      {photoPreview && !manualMode && !proteinMode && !batch && (
        <section className="card p-4 space-y-4">
          <div className="flex gap-3">
            <PhotoPreview
              src={photoPreview}
              lang={lang}
              analyzing={analyzing}
              onZoom={() => setLightboxSrc(photoPreview)}
              onRemove={analysis ? undefined : clearPhoto}
              className="flex-1 aspect-[4/3]"
            />
            {photoPreview2 ? (
              <PhotoPreview
                src={photoPreview2}
                lang={lang}
                analyzing={analyzing}
                onZoom={() => setLightboxSrc(photoPreview2)}
                onRemove={analysis ? undefined : clearPhoto2}
                className="w-28 shrink-0"
              />
            ) : (
              !analysis && (
                // Same picker the first photo came from is the default; both
                // sources stay one tap away for the "other side of the box" shot.
                <div className="w-28 shrink-0 rounded-2xl border-2 border-dashed border-border bg-bg-elev flex flex-col items-center justify-center gap-2 p-2">
                  <span className="text-[11px] text-ink/55 text-center leading-tight">
                    {t(lang, "meal_add_second_photo")}
                  </span>
                  <div className="flex gap-1.5">
                    <IconButton
                      label={`${t(lang, "meal_second_photo")}: ${t(lang, "meal_take_photo")}`}
                      onClick={() => camera2Ref.current?.click()}
                      tone={photoSource === "gallery" ? "plain" : "tonal"}
                    >
                      <CameraIcon className="h-5 w-5" />
                    </IconButton>
                    <IconButton
                      label={`${t(lang, "meal_second_photo")}: ${t(lang, "meal_from_gallery")}`}
                      onClick={() => gallery2Ref.current?.click()}
                      tone={photoSource === "gallery" ? "tonal" : "plain"}
                    >
                      <GalleryIcon className="h-5 w-5" />
                    </IconButton>
                  </div>
                </div>
              )
            )}
          </div>

          {!analysis && (
            <>
              <div className="flex gap-2">
                <ChipButton onClick={() => cameraRef.current?.click()}>
                  <CameraIcon className="h-4 w-4" aria-hidden="true" />
                  {t(lang, "meal_retake")}
                </ChipButton>
                <ChipButton onClick={() => galleryRef.current?.click()}>
                  <GalleryIcon className="h-4 w-4" aria-hidden="true" />
                  {t(lang, "meal_pick_gallery")}
                </ChipButton>
              </div>
              {!photoPreview2 && (
                <p className="text-[12px] text-ink/45">{t(lang, "meal_second_photo_hint")}</p>
              )}
              <DescribeField
                lang={lang}
                label={t(lang, "meal_notes_hint")}
                placeholder={t(lang, "meal_notes_placeholder")}
                value={text}
                onChange={setText}
                rows={2}
              />
              <PrimaryButton onClick={analyze} disabled={analyzing || !!progress}>
                {analyzing ? (
                  <AiThinkingPill label={progress || analyzeStageLabel} />
                ) : (
                  progress || t(lang, "meal_analyze_photo")
                )}
              </PrimaryButton>
            </>
          )}
        </section>
      )}

      {/* File inputs use sr-only (not `hidden`/display:none): some mobile
          browsers refuse to open the camera/picker when a display:none
          input is clicked programmatically. sr-only keeps them in the
          layout but invisible, which triggers reliably. */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onPickCamera}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        multiple
        onChange={onPick}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
      <input
        ref={camera2Ref}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onPickCamera2}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
      <input
        ref={gallery2Ref}
        type="file"
        accept="image/*"
        onChange={onPick2}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
      <input
        ref={batchRef}
        type="file"
        accept="image/*"
        multiple
        onChange={onPickBatch}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* --- BATCH MODE: each photo is its own meal --- */}
      {batch && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">
              {t(lang, "meal_batch_title")}{" "}
              <span className="text-ink/45 nums">({batch.length})</span>
            </h2>
            <TextButton onClick={() => setBatch(null)} disabled={batchBusy}>
              {t(lang, "meal_cancel")}
            </TextButton>
          </div>
          {groupByDay(sortBatch(batch)).map(([day, items]) => (
            <div key={day} className="space-y-2">
              <div className="text-[11px] font-medium text-ink/45 pt-1">
                {prettyDate(day, lang)} · {items.length}
              </div>
              {items.map((it) => (
                <BatchMealCard
                  key={it.id}
                  item={it}
                  lang={lang}
                  disabled={batchBusy}
                  onHint={(v) => patchBatchItem(it.id, { hint: v })}
                  onDate={(v) => patchBatchItem(it.id, { date: v || it.date })}
                  onMacro={(k, v) =>
                    patchBatchItem(it.id, {
                      editing: it.editing ? { ...it.editing, [k]: v } : it.editing,
                    })
                  }
                  onFractions={(next) =>
                    it.analysis &&
                    patchBatchItem(it.id, {
                      fractions: next,
                      editing: applyPortions(it.analysis.total, it.analysis.items, next),
                    })
                  }
                  onClarifyAnswer={(v) => patchBatchItem(it.id, { clarifyAnswer: v })}
                  onClarifySubmit={() => {
                    if (!it.analysis?.clarifying_question || !it.clarifyAnswer.trim()) return;
                    analyzeBatchItem(it, `${it.analysis.clarifying_question} Answer: ${it.clarifyAnswer.trim()}`);
                  }}
                  onClarifySkip={() =>
                    patchBatchItem(it.id, {
                      analysis: it.analysis ? { ...it.analysis, clarifying_question: undefined } : it.analysis,
                    })
                  }
                  onRetry={() => analyzeBatchItem(it)}
                  onSplit={() => splitBatchItem(it.id)}
                  onRemove={() => {
                    setBatch((prev) => {
                      const next = prev?.filter((x) => x.id !== it.id) ?? null;
                      return next && next.length > 0 ? next : null;
                    });
                  }}
                  onZoom={() => setLightboxSrc(it.photos.map((p) => p.preview))}
                />
              ))}
            </div>
          ))}
          {batch.some((it) => it.status === "done" && it.analysis?.clarifying_question) && (
            <p className="text-[12px] text-warn/85">
              {t(lang, "meal_batch_clarify_hint")}
            </p>
          )}
          <StickyActions>
            <IconButton
              label={t(lang, "meal_from_gallery")}
              onClick={() => batchRef.current?.click()}
              disabled={batchBusy}
              tone="tonal"
              size="lg"
            >
              <PlusIcon className="h-5 w-5" />
            </IconButton>
            {batch.some((it) => it.status === "ready" || it.status === "error") ? (
              <PrimaryButton onClick={analyzeAllBatch} disabled={batchBusy} className="flex-1">
                {batchBusy ? (
                  <AiThinkingPill label={t(lang, "meal_analyzing")} />
                ) : (
                  `${t(lang, "meal_batch_analyze_all")} (${batch.filter((it) => it.status === "ready" || it.status === "error").length})`
                )}
              </PrimaryButton>
            ) : (
              <PrimaryButton
                onClick={saveAllBatch}
                disabled={batchBusy || !batch.some((it) => it.status === "done")}
                className="flex-1"
              >
                {batchBusy
                  ? t(lang, "meal_saving_short")
                  : `${t(lang, "meal_batch_save_all")} (${batch.filter((it) => it.status === "done").length})`}
              </PrimaryButton>
            )}
          </StickyActions>
        </section>
      )}

      {/* --- MANUAL ENTRY FORM --- */}
      {manualMode && !analysis && !proteinMode && !batch && (
        <section className="card p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">{t(lang, "meal_manual_title")}</h2>
            <TextButton onClick={() => { setManualMode(false); setErr(null); }}>
              {t(lang, "meal_cancel")}
            </TextButton>
          </div>
          <label className="block">
            <span className="block text-xs font-medium text-ink/60 mb-1.5">
              {t(lang, "meal_manual_desc_label")}
            </span>
            <input
              value={manualDesc}
              onChange={(e) => setManualDesc(e.target.value)}
              placeholder={t(lang, "meal_manual_desc_placeholder")}
              className="w-full h-12 rounded-xl bg-bg-elev border border-border px-4 text-[15px]"
            />
          </label>
          <MacroTiles
            lang={lang}
            label={t(lang, "meal_macros_label")}
            value={manualMacros}
            onChange={(k, v) => setManualMacros({ ...manualMacros, [k]: v })}
          />
          <PrimaryButton onClick={saveManual} disabled={manualSaving}>
            {manualSaving
              ? progress || t(lang, "meal_saving_short")
              : isToday
                ? t(lang, "meal_save")
                : `${t(lang, "meal_save_to")} ${prettyDate(date, lang)}`}
          </PrimaryButton>
        </section>
      )}

      {/* --- ANALYSIS REVIEW --- */}
      {analysis && editing && !batch && (
        <section className="space-y-4">
          <div className="card p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <h2
                className="text-base font-semibold leading-snug"
                dir={/[֐-׿]/.test(analysis.description) ? "rtl" : "ltr"}
              >
                {analysis.description}
              </h2>
              <div className="flex items-center gap-1.5 shrink-0">
                {analysis._latencyMs ? (
                  <span className="text-[11px] nums text-ink/40" title={analysis._model ?? ""}>
                    {(analysis._latencyMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
                <ConfidenceChip lang={lang} confidence={analysis.confidence} />
              </div>
            </div>
            {analysis.items?.length > 0 && (
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wider text-ink/45 mb-1.5">
                  {t(lang, "meal_items_found")}
                </div>
                <ItemPortions
                  items={analysis.items}
                  fractions={fractions}
                  lang={lang}
                  onChange={(next) => {
                    setFractions(next);
                    setEditing(applyPortions(analysis.total, analysis.items, next));
                  }}
                />
              </div>
            )}
            {analysis.notes && (
              <p className="text-[12px] text-ink/50 leading-relaxed">{analysis.notes}</p>
            )}
          </div>

          {analysis.clarifying_question && (
            <ClarifyCard
              lang={lang}
              question={analysis.clarifying_question}
              answer={clarifyAnswer}
              onAnswer={setClarifyAnswer}
              onSubmit={answerClarifyingQuestion}
              onSkip={skipClarifyingQuestion}
              busy={clarifying}
            />
          )}

          <div className="card p-4">
            <MacroTiles
              lang={lang}
              label={t(lang, "meal_totals")}
              value={editing}
              onChange={(k, v) => setEditing({ ...editing, [k]: v })}
            />
          </div>

          <StickyActions>
            <button
              onClick={resetNewMealForm}
              className="h-12 rounded-full px-5 text-sm font-medium bg-bg-elev border border-border state-layer"
            >
              {t(lang, "meal_discard")}
            </button>
            <PrimaryButton onClick={save} disabled={saving || clarifying} className="flex-1">
              {saving ? progress || t(lang, "meal_saving_short") : saveLabel}
            </PrimaryButton>
          </StickyActions>
        </section>
      )}

      {showDaySummary && existing.length > 0 && (
        <DaySummaryCard
          meals={existing}
          goals={goals}
          lang={lang}
          onDismiss={() => setShowDaySummary(false)}
        />
      )}

      {notice && (
        <div role="status" className="flex items-center gap-3 rounded-2xl border border-ok/25 bg-ok/10 ps-4 pe-1.5 py-1.5 text-[13px] text-ok">
          <CheckCircleIcon className="h-5 w-5 text-ok shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-0">{notice}</span>
          <IconButton label={t(lang, "meal_close")} onClick={() => setNotice(null)}>
            <CloseIcon className="h-4 w-4" />
          </IconButton>
        </div>
      )}
      {err && (
        <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">
          <AlertIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{err}</span>
        </div>
      )}

      {/* --- EXISTING MEALS FOR THIS DATE --- */}
      {(existingLoading || existing.length > 0) && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <SectionTitle>
              {isToday ? t(lang, "meal_todays_meals") : t(lang, "meal_logged_for_day")}
              {!existingLoading && <span className="text-ink/35 nums"> · {existing.length}</span>}
            </SectionTitle>
            {!existingLoading && existing.length > 0 && (
              <ChipButton onClick={startReview} disabled={reviewing} size="sm">
                <CheckCircleIcon className="h-4 w-4 text-accent-primary" aria-hidden="true" />
                {reviewing ? t(lang, "meal_coach_checking") : t(lang, "meal_coach_check")}
              </ChipButton>
            )}
          </div>
          {existingLoading ? (
            <div className="space-y-2">
              {[0, 1].map((i) => (
                <div key={i} className="card p-3 flex items-center gap-3">
                  <div className="w-14 h-14 rounded-xl bg-bg-elev animate-pulse shrink-0" />
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
      {!analysis && !batch && (frequentLoading || frequent.length > 0) && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <SectionTitle>{t(lang, "meal_log_again")}</SectionTitle>
            <span className="text-[12px] text-ink/40">{t(lang, "meal_recurring")}</span>
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
            <div className="card divide-y divide-border overflow-hidden">
              {frequent.map((m, i) => {
                const open = expandedIdx === i;
                return (
                  <div key={i}>
                    <button
                      onClick={() => {
                        setExpandedIdx(open ? null : i);
                        setModifier("");
                      }}
                      aria-expanded={open}
                      className="w-full text-start px-4 py-3 flex items-center gap-3 state-layer"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate" dir={/[֐-׿]/.test(m.description) ? "rtl" : "ltr"}>
                          {m.description}
                        </div>
                        <MacroLine lang={lang} macros={m} className="mt-0.5" />
                      </div>
                      <span className="text-[11px] nums text-ink/60 bg-bg-elev border border-border rounded-full px-2 py-0.5 shrink-0">
                        ×{m.count}
                      </span>
                      <ChevronIcon
                        className={`h-4 w-4 text-ink/40 shrink-0 transition-transform duration-200 ${open ? "rotate-90" : "-rotate-90"}`}
                        aria-hidden="true"
                      />
                    </button>

                    {open && (
                      <div className="px-4 pb-4 space-y-2.5">
                        <input
                          value={modifier}
                          onChange={(e) => setModifier(e.target.value)}
                          dir={/[֐-׿]/.test(modifier) ? "rtl" : lang === "he" ? "rtl" : "ltr"}
                          placeholder={t(lang, "meal_modifier_placeholder")}
                          className="w-full h-11 rounded-xl bg-bg-elev border border-border px-3 text-[14px]"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => quickLog(m, "")}
                            disabled={quickBusy}
                            className="flex-1 h-11 rounded-full bg-accent-sec-container text-accent-on-sec-container text-[13px] font-semibold disabled:opacity-40 state-layer"
                          >
                            {quickBusy
                              ? progress || t(lang, "meal_saving_short")
                              : isToday
                                ? t(lang, "meal_log_asis")
                                : `${t(lang, "meal_log_asis")} · ${prettyDate(date, lang)}`}
                          </button>
                          <button
                            onClick={() => quickLog(m, modifier)}
                            disabled={quickBusy || !modifier.trim()}
                            className="flex-1 h-11 rounded-full bg-accent-brand text-on-brand text-[13px] font-semibold disabled:opacity-40 state-layer"
                          >
                            {quickBusy ? progress || t(lang, "meal_saving_short") : t(lang, "meal_log_with_change")}
                          </button>
                        </div>
                        <p className="text-[11px] text-ink/45">
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
  const [macros, setMacros] = useState(() => roundedMacros(meal));
  const [moveDate, setMoveDate] = useState<string>(meal.date);
  const [icon, setIcon] = useState<string | null>(meal.icon ?? null);
  const [busy, setBusy] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Keep local state in sync if the meal changes underneath (e.g. after a save).
  useEffect(() => {
    setDesc(meal.description ?? "");
    setMacros(roundedMacros(meal));
    setMoveDate(meal.date);
    setIcon(meal.icon ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meal.id, meal.description, meal.calories, meal.protein_g, meal.fat_g, meal.carbs_g, meal.date, meal.icon]);

  const isMoving = moveDate !== meal.date;

  const isProteinPowder = (() => {
    if (!meal.items_json) return false;
    try { return JSON.parse(meal.items_json)?.[0]?.type === "protein_powder"; }
    catch { return false; }
  })();
  // Icon is only relevant when there's no image to show.
  const noPhoto = !isProteinPowder && !meal.photo_thumb && !meal.photo_path;
  const time = loggedTime(meal, lang);

  async function handleSave() {
    setBusy(true);
    try {
      await onSave({
        description: desc.trim() || null,
        ...macros,
        ...(isMoving && { date: moveDate }),
        ...(noPhoto && { icon: icon || null }),
      });
    } finally {
      setBusy(false);
    }
  }

  const thumbBox = "w-14 h-14 rounded-xl bg-bg-elev border border-border flex items-center justify-center shrink-0 overflow-hidden";

  return (
    <div className="card">
      <div className="flex items-center gap-3 p-3">
        {isProteinPowder ? (
          <div className={thumbBox}>
            <ShakerIcon className="h-6 w-6 text-ink/55" aria-hidden="true" />
          </div>
        ) : meal.photo_thumb ? (
          <button
            onClick={() => setLightboxOpen(true)}
            aria-label={t(lang, "meal_view_photo")}
            className="relative shrink-0 rounded-xl"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={meal.photo_thumb}
              alt=""
              width={56}
              height={56}
              decoding="async"
              className="w-14 h-14 rounded-xl object-cover bg-bg-elev"
            />
            {meal.photo_thumb_2 && (
              <span className="absolute -top-1 -end-1 min-w-[18px] h-[18px] px-1 rounded-full bg-accent-brand text-[10px] font-bold flex items-center justify-center text-on-brand ring-2 ring-bg-card">
                2
              </span>
            )}
          </button>
        ) : meal.photo_path ? (
          <Image
            src={meal.photo_path}
            alt=""
            width={56}
            height={56}
            quality={55}
            sizes="56px"
            loading="lazy"
            className="w-14 h-14 rounded-xl object-cover bg-bg-elev shrink-0"
          />
        ) : (
          <div className={thumbBox}>
            {meal.icon && <MealIcon id={meal.icon} className="h-6 w-6 text-accent-primary" />}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div
            className="text-sm font-medium truncate"
            dir={meal.description && /[֐-׿]/.test(meal.description) ? "rtl" : undefined}
          >
            {meal.description || t(lang, "meal_unnamed")}
          </div>
          <MacroLine lang={lang} macros={meal} className="mt-0.5" />
        </div>
        {time && <span className="text-[11px] nums text-ink/40 shrink-0">{time}</span>}
        <IconButton
          label={isEditing ? t(lang, "meal_cancel") : t(lang, "meal_edit")}
          onClick={onEditToggle}
          tone={isEditing ? "tonal" : "plain"}
          expanded={isEditing}
        >
          {isEditing ? <CloseIcon className="h-5 w-5" /> : <PencilIcon className="h-5 w-5" />}
        </IconButton>
      </div>

      {isEditing && (
        <div className="border-t border-border p-3 space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-ink/60 mb-1.5">{t(lang, "meal_description_label")}</span>
            <input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              dir={/[֐-׿]/.test(desc) ? "rtl" : lang === "he" ? "rtl" : "ltr"}
              className="w-full h-11 rounded-xl bg-bg-elev border border-border px-3 text-[14px]"
            />
          </label>
          <MacroTiles
            lang={lang}
            value={macros}
            onChange={(k, v) => setMacros((m) => ({ ...m, [k]: v }))}
            compact
          />
          {noPhoto && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-ink/60">{t(lang, "meal_pick_icon")}</div>
              <div className="grid grid-cols-6 gap-1.5">
                {MEAL_ICON_IDS.map((id) => {
                  const selected = icon === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setIcon(selected ? null : id)}
                      aria-pressed={selected}
                      aria-label={id}
                      className={`aspect-square rounded-xl flex items-center justify-center border transition-colors ${
                        selected
                          ? "bg-accent-brand/20 border-accent-brand text-accent-primary"
                          : "bg-bg-elev border-border text-ink/60 hover:text-ink"
                      }`}
                    >
                      <MealIcon id={id} className="h-5 w-5" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <label className="flex items-center gap-2 rounded-xl bg-bg-elev border border-border px-3 h-11">
            <CalendarIcon className="h-4 w-4 text-ink/45" aria-hidden="true" />
            <span className="text-[13px] text-ink/60 flex-1">{t(lang, "meal_move_to_date")}</span>
            <input
              type="date"
              value={moveDate}
              onChange={(e) => setMoveDate(e.target.value || meal.date)}
              className="bg-transparent text-[13px] text-ink border-none outline-none"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={onDelete}
              className="h-11 rounded-full px-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-bad state-layer"
            >
              <TrashIcon className="h-4 w-4" aria-hidden="true" />
              {t(lang, "meal_delete")}
            </button>
            <PrimaryButton
              onClick={handleSave}
              disabled={busy}
              className={`flex-1 h-11 ${isMoving ? "!bg-ink/10 border border-ink/20" : ""}`}
            >
              {busy
                ? t(lang, "meal_saving_short")
                : isMoving
                  ? `${t(lang, "meal_move_to")} ${prettyDate(moveDate, lang)}`
                  : t(lang, "meal_save_changes")}
            </PrimaryButton>
          </div>
        </div>
      )}

      {lightboxOpen && meal.photo_thumb && (
        <ImageLightbox
          src={[meal.photo_thumb, meal.photo_thumb_2].filter((s): s is string => !!s)}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </div>
  );
}

function roundedMacros(m: Pick<ExistingMeal, "calories" | "protein_g" | "fat_g" | "carbs_g">): Macros {
  return {
    calories: Math.round(m.calories ?? 0),
    protein_g: Math.round(m.protein_g ?? 0),
    fat_g: Math.round(m.fat_g ?? 0),
    carbs_g: Math.round(m.carbs_g ?? 0),
  };
}

/** Local clock time the meal was logged, or null when it was logged on a
 *  different day than it's filed under (backdated or imported) — the time
 *  would describe the logging, not the meal. `created_at` is SQLite UTC. */
function loggedTime(meal: ExistingMeal, lang: Lang): string | null {
  const iso = meal.created_at.replace(" ", "T");
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
  if (Number.isNaN(d.getTime())) return null;
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (local !== meal.date) return null;
  return d.toLocaleTimeString(lang === "he" ? "he-IL" : undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Local YYYY-MM-DD `days` away from `s`. */
function shiftDate(s: string, days: number): string {
  const d = new Date(s + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

/** [day, items] pairs in the order the (already sorted) items arrive. */
function groupByDay<T extends { date: string }>(items: T[]): [string, T[]][] {
  const out: [string, T[]][] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last[0] === it.date) last[1].push(it);
    else out.push([it.date, [it]]);
  }
  return out;
}

/** Small scoop/tub icon for the creatine one-tap chip. */
function CreatineIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 8h14l-1 11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 8Z" />
      <path d="M4 8h16V6a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v2Z" />
      <path d="M10 12h4" />
    </svg>
  );
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


/** Sweeping light-beam overlay shown on top of a photo while Claude is
 *  reading it — signals "AI is looking at this" rather than a generic
 *  loading skeleton. */
function AiScanOverlay() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none bg-black/10">
      <div className="ai-scan-line" />
    </div>
  );
}

/** Picked photo with tap-to-zoom, the AI scan beam while it's being read,
 *  and a remove control (omitted once an analysis exists). Fills whatever box
 *  `className` gives it. */
function PhotoPreview({
  src,
  lang,
  analyzing,
  onZoom,
  onRemove,
  className = "",
}: {
  src: string;
  lang: Lang;
  analyzing: boolean;
  onZoom: () => void;
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <div className={`relative rounded-2xl overflow-hidden border border-border bg-bg-elev ${className}`}>
      <button
        onClick={onZoom}
        aria-label={t(lang, "meal_view_photo")}
        className="absolute inset-0 w-full h-full cursor-zoom-in"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" className="w-full h-full object-cover" />
      </button>
      {analyzing && <AiScanOverlay />}
      {onRemove && (
        <button
          onClick={onRemove}
          aria-label={t(lang, "meal_remove_photo")}
          className="absolute top-2 end-2 w-9 h-9 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/** Post-save one-liner: what's LEFT for the day — the bit the Home rings
 *  don't emphasize, so it doesn't just restate the main page. Pure
 *  arithmetic over the reloaded meal list + profile targets, so it can't
 *  disagree with the list it sits above. */
function DaySummaryCard({
  meals,
  goals,
  lang,
  onDismiss,
}: {
  meals: ExistingMeal[];
  goals: { calories: number; protein_g: number } | null;
  lang: Lang;
  onDismiss: () => void;
}) {
  if (!goals) return null;
  const totals = meals.reduce(
    (acc, m) => {
      acc.calories += m.calories ?? 0;
      acc.protein_g += m.protein_g ?? 0;
      return acc;
    },
    { calories: 0, protein_g: 0 },
  );
  const proteinLeft = Math.round(goals.protein_g - totals.protein_g);
  const calLeft = Math.round(goals.calories - totals.calories);
  const proteinPart =
    goals.protein_g > 0
      ? proteinLeft > 0
        ? `${proteinLeft}g ${t(lang, "macro_protein")}`
        : `${t(lang, "macro_protein")} ✓`
      : null;
  const calPart =
    calLeft >= 0
      ? `${calLeft.toLocaleString()} ${t(lang, "macro_kcal")}`
      : `${Math.abs(calLeft).toLocaleString()} ${t(lang, "macro_kcal")} ${t(lang, "meal_over_target")}`;
  const anythingLeft = proteinLeft > 0 || calLeft >= 0;
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-2xl border border-ok/25 bg-ok/10 ps-4 pe-1.5 py-1.5 text-[13px] text-ok"
    >
      <CheckCircleIcon className="h-5 w-5 text-ok shrink-0" aria-hidden="true" />
      <span className="nums flex-1 min-w-0">
        {[proteinPart, calPart].filter(Boolean).join(" · ")}
        {anythingLeft ? ` ${t(lang, "meal_left_today")}` : ""}
      </span>
      <IconButton label={t(lang, "meal_close")} onClick={onDismiss}>
        <CloseIcon className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

/** One meal in batch mode: photo thumbnail(s) + the day it was taken +
 *  per-meal note, then the analysis result with per-item portions, editable
 *  macros and the same clarifying-question round the single-meal flow gets. */
function BatchMealCard({
  item,
  lang,
  disabled,
  onHint,
  onDate,
  onMacro,
  onFractions,
  onClarifyAnswer,
  onClarifySubmit,
  onClarifySkip,
  onRetry,
  onSplit,
  onRemove,
  onZoom,
}: {
  item: BatchItem;
  lang: Lang;
  disabled: boolean;
  onHint: (v: string) => void;
  onDate: (v: string) => void;
  onMacro: (k: MacroKey, v: number) => void;
  onFractions: (next: number[]) => void;
  onClarifyAnswer: (v: string) => void;
  onClarifySubmit: () => void;
  onClarifySkip: () => void;
  onRetry: () => void;
  onSplit: () => void;
  onRemove: () => void;
  onZoom: () => void;
}) {
  const a = item.analysis;
  // Per-item staged pipeline label — each batch item analyzes independently,
  // so its stages advance from the moment that item enters the "analyzing"
  // state. Batch items are always photo-based.
  const stages = useMemo(() => photoAnalyzeStages(lang), [lang]);
  const stageLabel = useStagedLabel(item.status === "analyzing", stages);
  return (
    <div className={`card p-3 space-y-3 transition-opacity ${item.status === "saved" ? "opacity-50" : ""}`}>
      <div className="flex gap-3">
        <div className="relative shrink-0 w-20 h-20">
          <PhotoPreview
            src={item.photos[0].preview}
            lang={lang}
            analyzing={item.status === "analyzing"}
            onZoom={onZoom}
            className="w-full h-full"
          />
          {item.photos[1] && (
            <button
              onClick={onZoom}
              aria-label={t(lang, "meal_second_photo")}
              className="absolute -bottom-1.5 -end-1.5 w-9 h-9 rounded-lg overflow-hidden border-2 border-bg-card"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.photos[1].preview} alt="" className="w-full h-full object-cover" />
            </button>
          )}
        </div>
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex items-center gap-2 text-[11px] text-ink/45">
            <input
              type="date"
              value={item.date}
              onChange={(e) => onDate(e.target.value)}
              disabled={disabled || item.status === "saved"}
              aria-label={t(lang, "meal_date")}
              className="bg-transparent border-0 p-0 text-[11px] text-ink/60 focus:outline-none"
            />
            {item.photos.length > 1 && item.status !== "saved" && item.status !== "analyzing" && (
              <button
                onClick={onSplit}
                disabled={disabled}
                className="h-8 rounded-full px-2.5 font-medium text-accent-primary disabled:opacity-40 state-layer"
              >
                {t(lang, "meal_batch_split")}
              </button>
            )}
          </div>
          {item.status === "ready" && (
            <input
              type="text"
              value={item.hint}
              onChange={(e) => onHint(e.target.value)}
              dir={/[֐-׿]/.test(item.hint) ? "rtl" : lang === "he" ? "rtl" : "ltr"}
              placeholder={t(lang, "meal_batch_hint_placeholder")}
              disabled={disabled}
              className="w-full h-11 rounded-xl bg-bg-elev border border-border px-3 text-[13px]"
            />
          )}
          {item.status === "analyzing" && (
            <div className="text-[13px] text-ink/60 pt-2">
              <AiThinkingPill label={stageLabel} />
            </div>
          )}
          {item.status === "error" && (
            <div className="space-y-1 pt-1">
              <div className="text-[12px] text-bad">{item.error}</div>
              <TextButton onClick={onRetry} disabled={disabled}>
                {t(lang, "meal_batch_retry")}
              </TextButton>
            </div>
          )}
          {(item.status === "done" || item.status === "saved") && a && (
            <>
              <div
                className="text-[14px] font-medium leading-snug"
                dir={/[֐-׿]/.test(a.description) ? "rtl" : "ltr"}
              >
                {a.description}
              </div>
              {item.status === "done" && (
                <ItemPortions
                  items={a.items}
                  fractions={item.fractions}
                  onChange={onFractions}
                  lang={lang}
                  disabled={disabled}
                  compact
                />
              )}
              {item.hint && (
                <div className="text-[11px] text-ink/40 truncate">“{item.hint}”</div>
              )}
            </>
          )}
        </div>
        {item.status === "saved" ? (
          <CheckCircleIcon className="h-6 w-6 text-ok shrink-0 m-2.5" aria-hidden="true" />
        ) : (
          <IconButton label={t(lang, "meal_remove_photo")} onClick={onRemove} disabled={disabled}>
            <CloseIcon className="h-4 w-4" />
          </IconButton>
        )}
      </div>

      {(item.status === "done" || item.status === "saved") && a && item.editing && (
        <MacroTiles
          lang={lang}
          value={item.editing}
          onChange={onMacro}
          disabled={disabled || item.status === "saved"}
          compact
        />
      )}

      {/* Clarifying question — same flow as the single-meal analysis */}
      {item.status === "done" && a?.clarifying_question && (
        <ClarifyCard
          lang={lang}
          question={a.clarifying_question}
          answer={item.clarifyAnswer}
          onAnswer={onClarifyAnswer}
          onSubmit={onClarifySubmit}
          onSkip={onClarifySkip}
          disabled={disabled}
        />
      )}
    </div>
  );
}

/** Sparkle icon + three breathing dots, used wherever we want to say
 *  "the model is thinking" instead of a static "Loading…" label. */
// Pipeline stage lists for the analyze call, shared by the single-photo flow
// and each batch item. `after` is the ms offset from when analysis starts at
// which the label switches.
//
// The labels track what the analyzer actually does now: it identifies each
// food (to get its per-100g nutrient density), estimates the portion in grams,
// and the totals are multiplied out in code.
//
// Pacing matters as much as wording. These offsets were set when analysis ran
// on Sonnet at ~14 s; production now runs Haiku at ~3.7 s, so the last three
// labels never appeared at all. They are compressed to fit a typical call,
// with the final label holding until the real result lands.
function photoAnalyzeStages(lang: Lang) {
  return [
    { after: 0, label: t(lang, "meal_stage_upload") },
    { after: 500, label: t(lang, "meal_stage_identify") },
    { after: 1500, label: t(lang, "meal_stage_portions") },
    { after: 2600, label: t(lang, "meal_stage_nutrition") },
    { after: 3600, label: t(lang, "meal_stage_totals") },
  ];
}
function textAnalyzeStages(lang: Lang) {
  return [
    { after: 0, label: t(lang, "meal_stage_reading_text") },
    { after: 1200, label: t(lang, "meal_stage_nutrition") },
    { after: 2400, label: t(lang, "meal_stage_totals") },
  ];
}

/**
 * Advances a label through a sequence of timed stages while `active` is true,
 * so a long single request can still show which step of the pipeline is
 * running. Each stage fires at its `after` offset (ms) from when `active`
 * flips true; the label holds on the final stage until `active` goes false.
 * The stage list is captured at activation (read via a ref) so re-renders
 * don't restart the timers.
 */
function useStagedLabel(
  active: boolean,
  stages: { after: number; label: string }[],
): string {
  const stagesRef = useRef(stages);
  stagesRef.current = stages;
  const [label, setLabel] = useState(stages[0]?.label ?? "");

  useEffect(() => {
    if (!active) return;
    const s = stagesRef.current;
    setLabel(s[0]?.label ?? "");
    const timers = s
      .filter((st) => st.after > 0)
      .map((st) => setTimeout(() => setLabel(st.label), st.after));
    return () => timers.forEach(clearTimeout);
  }, [active]);

  return label;
}

function AiThinkingPill({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg viewBox="0 0 24 24" className="h-4 w-4 text-accent-brand ai-glow-pulse" fill="currentColor">
        <path d="M12 2l1.8 5.4L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.6L12 2Z" />
      </svg>
      <span>{label}</span>
      <span className="inline-flex gap-0.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="ai-think-dot inline-block w-1 h-1 rounded-full bg-current"
            style={{ animationDelay: `${i * 0.18}s` }}
          />
        ))}
      </span>
    </span>
  );
}

function ImageLightbox({ src, onClose }: { src: string | string[]; onClose: () => void }) {
  const lang = useLang();
  const srcs = Array.isArray(src) ? src : [src];

  // Make the hardware/browser Back button close the image instead of leaving
  // the page. On open we push a throwaway history entry; a Back press pops it
  // and fires `popstate`, which we turn into a close. If the lightbox is
  // instead dismissed from the UI (× / backdrop → onClose unmounts us), the
  // cleanup pops that entry itself so it never lingers. onClose is read
  // through a ref so this effect runs only once, on mount/unmount.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    let poppedByBack = false;
    window.history.pushState({ lightbox: true }, "");
    const onPop = () => {
      poppedByBack = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Closed from the UI, not the Back button — remove the entry we added.
      if (!poppedByBack) window.history.back();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        aria-label={t(lang, "meal_close")}
        className="absolute top-[calc(env(safe-area-inset-top)+1rem)] end-4 w-11 h-11 flex items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
      >
        <CloseIcon className="h-5 w-5" />
      </button>
      <div
        className="flex gap-3 max-w-full max-h-full overflow-x-auto snap-x snap-mandatory"
        onClick={(e) => e.stopPropagation()}
      >
        {srcs.map((s, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={s}
            alt=""
            className="max-w-full max-h-full object-contain rounded-lg snap-center shrink-0"
          />
        ))}
      </div>
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
  const lang = useLang();

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
          <div className="text-[11px] text-ink/45 uppercase tracking-wider">{t(lang, "review_ai_coach")}</div>
          <h2 className="text-xl font-bold mt-0.5">{t(lang, "review_title")}</h2>
        </div>
        <IconButton label={t(lang, "meal_close")} onClick={onClose} tone="tonal">
          <CloseIcon className="h-5 w-5" />
        </IconButton>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 pb-32">
        {reviewing ? (
          /* Loading skeletons */
          <div className="space-y-4 pt-2">
            <p className="text-sm text-ink/40 text-center animate-pulse">
              {t(lang, "review_loading")}
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
                {t(lang, "review_summary")}
              </div>
              <p className="text-sm text-ink/80 leading-snug">{reviewData.summary}</p>
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
                        {r.description || t(lang, "meal_unnamed")}
                      </div>
                      <div
                        className={`text-[11px] mt-0.5 ${
                          r.confidence === "high"
                            ? "text-ok/70"
                            : r.confidence === "medium"
                              ? "text-warn/70"
                              : "text-ink/40"
                        }`}
                      >
                        {t(lang, r.confidence === "high" ? "meal_conf_high" : r.confidence === "medium" ? "meal_conf_medium" : "meal_conf_low")}
                        {" · "}
                        {r.changed ? t(lang, "review_changed") : t(lang, "review_accurate")}
                      </div>
                    </div>
                    {isAccepted && (
                      <span className="text-ok text-base shrink-0 mt-1">✓</span>
                    )}
                  </div>

                  {/* Macro comparison: 4 cells, show old→new when changed */}
                  <div className="grid grid-cols-4 gap-1.5">
                    {(
                      [
                        { label: t(lang, "macro_calories"), cur: r.current.calories, sug: r.suggested.calories },
                        { label: t(lang, "macro_protein"), cur: r.current.protein_g, sug: r.suggested.protein_g },
                        { label: t(lang, "macro_fat"), cur: r.current.fat_g, sug: r.suggested.fat_g },
                        { label: t(lang, "macro_carbs"), cur: r.current.carbs_g, sug: r.suggested.carbs_g },
                      ] as const
                    ).map(({ label, cur, sug }) => {
                      const diff = sug - cur;
                      const significant = Math.abs(diff) >= 5;
                      return (
                        <div
                          key={label}
                          className="rounded-lg bg-bg-elev border border-border px-1.5 py-2 text-center"
                        >
                          <div className="text-[10px] text-ink/45 mb-1 truncate">{label}</div>
                          {significant ? (
                            <>
                              <div className="text-[10px] text-ink/25 line-through leading-tight">
                                {Math.round(cur)}
                              </div>
                              <div
                                className={`text-[13px] font-semibold leading-tight ${
                                  diff > 0 ? "text-warn" : "text-accent-fat"
                                }`}
                              >
                                {Math.round(sug)}
                              </div>
                              <div
                                className={`text-[9px] leading-tight ${
                                  diff > 0 ? "text-warn/60" : "text-accent-fat/60"
                                }`}
                              >
                                {diff > 0 ? "+" : ""}
                                {Math.round(diff)}
                              </div>
                            </>
                          ) : (
                            <div className="text-[13px] font-semibold text-ink/70">
                              {Math.round(cur)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Explanation */}
                  <p className="text-[13px] text-ink/65 leading-snug">{r.explanation}</p>

                  {/* Actions */}
                  {!isAccepted && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setAskingId(askingId === r.meal_id ? null : r.meal_id);
                          setAskText("");
                        }}
                        className="flex-1 rounded-lg border border-border bg-bg-elev py-2 text-[12px] text-ink/60"
                      >
                        {t(lang, "review_ask")}
                      </button>
                      {r.changed && (
                        <button
                          onClick={() => handleAcceptOne(r)}
                          disabled={acceptBusy === r.meal_id}
                          className="flex-1 rounded-lg bg-accent-brand py-2 text-[12px] font-semibold disabled:opacity-40 text-on-brand"
                        >
                          {acceptBusy === r.meal_id ? t(lang, "meal_saving_short") : t(lang, "review_accept")}
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
                        placeholder={t(lang, "review_ask_placeholder")}
                        className="flex-1 rounded-lg bg-bg-elev border border-border px-3 py-2 text-[13px] focus:outline-none focus:border-ink/30"
                        autoFocus
                      />
                      <button
                        onClick={() => handleAsk(r.meal_id)}
                        disabled={askBusy || !askText.trim()}
                        className="rounded-lg bg-accent-brand px-3 py-2 text-[12px] font-semibold disabled:opacity-40 text-on-brand"
                      >
                        {askBusy ? "…" : t(lang, "review_send")}
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
              className="w-full rounded-full bg-accent-brand py-3 text-sm font-semibold disabled:opacity-40 text-on-brand"
            >
              {acceptAllBusy
                ? t(lang, "review_applying")
                : `${t(lang, "review_accept_all")} (${changedCount})`}
            </button>
          ) : (
            <div className="text-center text-sm text-ok/80 py-1">
              {t(lang, "review_all_accurate")} ✓
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logger building blocks. Sizes follow the touch-target floor (44px+ for
// anything tappable); spacing and direction use logical properties
// (start/end, ps/pe) so the Hebrew layout mirrors without per-element fixes.
// ---------------------------------------------------------------------------

type Macros = { calories: number; protein_g: number; fat_g: number; carbs_g: number };
type MacroKey = keyof Macros;

const MACRO_FIELDS: { key: MacroKey; label: TKey; unit: TKey | null; dot: string }[] = [
  { key: "calories", label: "macro_calories", unit: "macro_kcal", dot: "bg-accent-cal" },
  { key: "protein_g", label: "macro_protein", unit: null, dot: "bg-accent-protein" },
  { key: "fat_g", label: "macro_fat", unit: null, dot: "bg-accent-fat" },
  { key: "carbs_g", label: "macro_carbs", unit: null, dot: "bg-accent-carbs" },
];

/** Four editable macro tiles, color-keyed to the Home rings. */
function MacroTiles({
  lang,
  label,
  value,
  onChange,
  disabled,
  compact,
}: {
  lang: Lang;
  label?: string;
  value: Macros;
  onChange: (k: MacroKey, v: number) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="space-y-2 min-w-0">
      {label && <div className="text-sm font-semibold">{label}</div>}
      <div className="grid grid-cols-4 gap-2">
        {MACRO_FIELDS.map((f) => (
          <label
            key={f.key}
            className={`min-w-0 rounded-xl bg-bg-elev border border-border flex flex-col items-center focus-within:border-accent-primary/60 transition-colors ${
              compact ? "px-1.5 pt-1.5 pb-1" : "px-2 pt-2.5 pb-2"
            }`}
          >
            <span className="flex items-center gap-1 text-[11px] text-ink/55 max-w-full">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${f.dot}`} aria-hidden="true" />
              <span className="truncate">{t(lang, f.label)}</span>
            </span>
            <input
              inputMode="decimal"
              value={value[f.key] || ""}
              placeholder="0"
              onChange={(e) => onChange(f.key, Number(e.target.value.replace(/[^\d.]/g, "")) || 0)}
              className={`w-full bg-transparent text-center font-semibold nums focus:outline-none placeholder:text-ink/25 ${
                compact ? "text-base py-0.5" : "text-xl py-1"
              }`}
            />
            <span className="text-[10px] text-ink/40">{f.unit ? t(lang, f.unit) : "g"}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Read-only version of MacroTiles, for fixed-recipe items. */
function MacroSummary({ lang, macros }: { lang: Lang; macros: Macros }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {MACRO_FIELDS.map((f) => (
        <div key={f.key} className="min-w-0 rounded-xl bg-bg-elev border border-border px-2 py-2.5 flex flex-col items-center">
          <span className="flex items-center gap-1 text-[11px] text-ink/55 max-w-full">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${f.dot}`} aria-hidden="true" />
            <span className="truncate">{t(lang, f.label)}</span>
          </span>
          <span className="text-lg font-semibold nums mt-0.5">{macros[f.key]}</span>
          <span className="text-[10px] text-ink/40">{f.unit ? t(lang, f.unit) : "g"}</span>
        </div>
      ))}
    </div>
  );
}

/** "540 kcal · P 32 · F 18 · C 60" with the letters localized and colored. */
function MacroLine({
  lang,
  macros,
  className = "",
}: {
  lang: Lang;
  macros: { calories: number | null; protein_g: number | null; fat_g: number | null; carbs_g: number | null };
  className?: string;
}) {
  const parts: { key: TKey; v: number | null; color: string }[] = [
    { key: "macro_p_short", v: macros.protein_g, color: "text-accent-protein" },
    { key: "macro_f_short", v: macros.fat_g, color: "text-accent-fat" },
    { key: "macro_c_short", v: macros.carbs_g, color: "text-accent-carbs" },
  ];
  return (
    <div className={`text-[12px] text-ink/55 nums flex flex-wrap items-center gap-x-2 ${className}`}>
      <span className="text-ink/80 font-medium">
        {Math.round(macros.calories ?? 0)} {t(lang, "macro_kcal")}
      </span>
      {parts.map((p) => (
        <span key={p.key}>
          <span className={`font-semibold ${p.color}`}>{t(lang, p.key)}</span> {Math.round(p.v ?? 0)}
        </span>
      ))}
    </div>
  );
}

/** Day-so-far progress against a target, for the header. */
function DayMeter({
  label,
  value,
  target,
  unit,
  barClass,
}: {
  label: string;
  value: number;
  target: number;
  unit: string;
  barClass: string;
}) {
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  const over = target > 0 && value > target;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="text-ink/55 truncate">{label}</span>
        <span className={`nums ${over ? "text-warn" : "text-ink/80"}`}>
          <span className="font-semibold">{Math.round(value).toLocaleString()}</span>
          <span className="text-ink/40"> / {Math.round(target).toLocaleString()} {unit}</span>
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 rounded-full bg-bg-elev overflow-hidden"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.round(target)}
        aria-valuenow={Math.round(value)}
      >
        <div className={`h-full rounded-full transition-[width] duration-500 ${over ? "bg-warn" : barClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ConfidenceChip({ lang, confidence }: { lang: Lang; confidence: "low" | "medium" | "high" }) {
  const tone =
    confidence === "high"
      ? "text-ok bg-ok/10 border-ok/25"
      : confidence === "medium"
        ? "text-warn bg-warn/10 border-warn/25"
        : "text-ink/60 bg-bg-elev border-border";
  const key: TKey =
    confidence === "high" ? "meal_conf_high" : confidence === "medium" ? "meal_conf_medium" : "meal_conf_low";
  return (
    <span className={`text-[11px] font-medium rounded-full border px-2.5 py-1 whitespace-nowrap ${tone}`}>
      {t(lang, key)}
    </span>
  );
}

/** The analyzer's follow-up question, answered inline to re-run with context. */
function ClarifyCard({
  lang,
  question,
  answer,
  onAnswer,
  onSubmit,
  onSkip,
  busy,
  disabled,
}: {
  lang: Lang;
  question: string;
  answer: string;
  onAnswer: (v: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-warn/30 bg-warn/5 p-3.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-warn">
          <SparkIcon className="h-4 w-4" aria-hidden="true" />
          {t(lang, "meal_clarify_label")}
        </div>
        <TextButton onClick={onSkip} disabled={disabled}>
          {t(lang, "meal_clarify_skip")}
        </TextButton>
      </div>
      <p className="text-[14px] text-ink/85 leading-snug" dir={/[֐-׿]/.test(question) ? "rtl" : "ltr"}>
        {question}
      </p>
      <div className="flex gap-2">
        <input
          value={answer}
          onChange={(e) => onAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) onSubmit();
          }}
          dir={/[֐-׿]/.test(answer) ? "rtl" : lang === "he" ? "rtl" : "ltr"}
          placeholder={t(lang, "meal_clarify_placeholder")}
          disabled={disabled}
          className="flex-1 min-w-0 h-11 rounded-xl bg-bg-elev border border-border px-3 text-[14px] focus:outline-none focus:border-accent-primary/60"
        />
        <button
          onClick={onSubmit}
          disabled={disabled || busy || !answer.trim()}
          className="h-11 rounded-xl bg-accent-brand px-4 text-[13px] font-semibold text-on-brand disabled:opacity-40 state-layer"
        >
          {busy ? <Spinner /> : t(lang, "meal_clarify_update")}
        </button>
      </div>
    </div>
  );
}

/** Free-text meal description / photo notes. Direction follows the text
 *  itself, so Hebrew typed into the English UI (or vice versa) reads right. */
function DescribeField({
  lang,
  label,
  placeholder,
  value,
  onChange,
  rows = 3,
}: {
  lang: Lang;
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-ink/60 mb-1.5">{label}</span>
      <textarea
        value={value}
        dir={value ? (/[֐-׿]/.test(value) ? "rtl" : "ltr") : lang === "he" ? "rtl" : "ltr"}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full rounded-xl bg-bg-elev border border-border px-4 py-3 text-[15px] resize-none focus:outline-none focus:border-accent-primary/60 transition-colors"
      />
    </label>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  className,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "h-12 rounded-full bg-accent-brand px-5 text-sm font-semibold text-on-brand inline-flex items-center justify-center gap-2 disabled:opacity-40 state-layer",
        className ?? "w-full",
      )}
    >
      {children}
    </button>
  );
}

function TonalButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="h-12 min-w-0 rounded-xl bg-accent-sec-container text-accent-on-sec-container px-3 text-[13px] font-semibold inline-flex items-center justify-center gap-2 state-layer"
    >
      {children}
    </button>
  );
}

function ChipButton({
  onClick,
  disabled,
  size = "md",
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  size?: "sm" | "md";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`shrink-0 rounded-full border border-border bg-bg-elev text-ink/85 inline-flex items-center gap-2 whitespace-nowrap disabled:opacity-50 state-layer ${
        size === "sm" ? "h-9 px-3 text-[12px]" : "h-11 px-4 text-[13px]"
      }`}
    >
      {children}
    </button>
  );
}

function TextButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="h-10 rounded-full px-3 text-[13px] font-medium text-accent-primary disabled:opacity-40 state-layer"
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  tone = "plain",
  size = "md",
  expanded,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "plain" | "tonal";
  size?: "md" | "lg";
  expanded?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      className={clsx(
        "shrink-0 rounded-full inline-flex items-center justify-center disabled:opacity-30 state-layer",
        size === "lg" ? "w-12 h-12" : "w-11 h-11",
        tone === "tonal"
          ? "bg-accent-sec-container text-accent-on-sec-container"
          : "text-ink/70 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

/** Save/discard bar that stays reachable above the bottom nav while you
 *  scroll a long analysis or batch. */
function StickyActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky z-10 bottom-[calc(var(--nav-h)+env(safe-area-inset-bottom)+0.75rem)] md:bottom-4 flex items-center gap-2 rounded-full bg-bg-card/90 backdrop-blur border border-border p-1.5 shadow-elev">
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[13px] font-semibold uppercase tracking-wide text-ink/55">{children}</h2>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 rounded-full border-2 border-ink/30 border-t-white/85 animate-spin"
      aria-hidden="true"
    />
  );
}

// Outline icons, 24px grid, 1.8 stroke — one style across the page.
function Svg(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  );
}
/** Points toward the start edge in LTR (‹); rotate for other directions. */
function ChevronIcon(props: React.SVGProps<SVGSVGElement>) {
  return <Svg {...props}><path d="m15 18-6-6 6-6" /></Svg>;
}
function CalendarIcon(props: React.SVGProps<SVGSVGElement>) {
  return <Svg {...props}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></Svg>;
}
function CameraIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13" r="4" />
    </Svg>
  );
}
function GalleryIcon(props: React.SVGProps<SVGSVGElement>) {
  return <Svg {...props}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></Svg>;
}
function StackIcon(props: React.SVGProps<SVGSVGElement>) {
  return <Svg {...props}><rect x="7" y="7" width="14" height="14" rx="2" /><path d="M3 17V5a2 2 0 0 1 2-2h12" /></Svg>;
}
function PlusIcon(props: React.SVGProps<SVGSVGElement>) {
  return <Svg {...props}><path d="M12 5v14M5 12h14" /></Svg>;
}
function PencilIcon(props: React.SVGProps<SVGSVGElement>) {
  return <Svg {...props}><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></Svg>;
}
function TrashIcon(props: React.SVGProps<SVGSVGElement>) {
  return <Svg {...props}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></Svg>;
}
function CloseIcon(props: React.SVGProps<SVGSVGElement>) {
  return <Svg {...props}><path d="M18 6 6 18M6 6l12 12" /></Svg>;
}
function CheckCircleIcon(props: React.SVGProps<SVGSVGElement>) {
  return <Svg {...props}><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></Svg>;
}
function AlertIcon(props: React.SVGProps<SVGSVGElement>) {
  return <Svg {...props}><circle cx="12" cy="12" r="9" /><path d="M12 8v4.5M12 16h.01" /></Svg>;
}
function BoltIcon(props: React.SVGProps<SVGSVGElement>) {
  return <Svg {...props}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></Svg>;
}
function SparkIcon(props: React.SVGProps<SVGSVGElement>) {
  return <Svg {...props}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /></Svg>;
}
