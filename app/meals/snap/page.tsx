"use client";

// Quick snap: photo + a typed note at the moment of eating, then straight
// back to the camera. The note is what makes the analysis accurate, and it's
// easiest to write while the plate is in front of you — days later it means
// reconstructing the meal from memory. The analysis runs server-side in the
// background and the meal waits in the inbox on /meals/log to be confirmed.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLang } from "@/components/LangProvider";
import { useBackgroundTasks } from "@/components/BackgroundTasks";
import { compressImageFile, compressImageThumb } from "@/lib/compress-image";
import { safeFetchJson } from "@/lib/fetch-json";
import { saveToDevice } from "@/lib/save-to-device";
import { t } from "@/lib/i18n";
import { DRAFTS_CHANGED_EVENT } from "@/components/MealInbox";

type Snap = { preview: string; base64: string; thumbBase64: string };

let _snapSeq = 0;

function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

async function toSnap(f: File): Promise<Snap> {
  const [full, thumb] = await Promise.all([compressImageFile(f), compressImageThumb(f)]);
  return { preview: full.dataUri, base64: full.base64, thumbBase64: thumb.base64 };
}

export default function SnapPage() {
  const lang = useLang();
  const bg = useBackgroundTasks();
  const cameraRef = useRef<HTMLInputElement>(null);
  const camera2Ref = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const [photo, setPhoto] = useState<Snap | null>(null);
  const [photo2, setPhoto2] = useState<Snap | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<number | null>(null);

  async function refreshCount() {
    try {
      const j = await safeFetchJson<{ drafts: unknown[] }>("/api/meal-drafts", { cache: "no-store" });
      setWaiting(j.drafts.length);
    } catch {
      // count is cosmetic
    }
  }

  useEffect(() => {
    refreshCount();
  }, []);

  // Keyboard up as soon as there's a photo — the note is the point.
  useEffect(() => {
    if (photo) noteRef.current?.focus();
  }, [photo]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>, slot: 1 | 2) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    // A capture via <input> isn't kept by the browser — keep the original,
    // so a failed upload can still be backfilled from the phone later.
    saveToDevice(f);
    setErr(null);
    setFlash(null);
    setBusy(true);
    try {
      const s = await toSnap(f);
      if (slot === 1) setPhoto(s);
      else setPhoto2(s);
    } catch (e: any) {
      setErr(e?.message || "Could not read that photo");
    } finally {
      setBusy(false);
    }
  }

  function removePhoto(slot: number) {
    // Removing the first photo promotes the second into its place.
    if (slot === 0) setPhoto(photo2);
    setPhoto2(null);
  }

  function save() {
    if (!photo) return;
    const body = JSON.stringify({
      date: todayStr(),
      note: note.trim() || undefined,
      photo_base64: photo.base64,
      photo_thumb_base64: photo.thumbBase64,
      photo_base64_2: photo2?.base64,
      photo_thumb_base64_2: photo2?.thumbBase64,
    });
    // Not awaited: the provider keeps the upload + analysis going even if
    // the user leaves this page, with the global spinner showing it.
    const key = `meal-snap-${++_snapSeq}`;
    bg.run(
      key,
      () =>
        safeFetchJson("/api/meal-drafts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      { label: t(lang, "meal_inbox_pending") },
    )
      .then(() => {
        window.dispatchEvent(new Event(DRAFTS_CHANGED_EVENT));
        refreshCount();
      })
      .catch((e: any) => setErr(e?.message ?? "save failed"))
      .finally(() => bg.consume(key));

    setPhoto(null);
    setPhoto2(null);
    setNote("");
    setFlash(t(lang, "meal_snap_saved"));
    setWaiting((n) => (n ?? 0) + 1);
  }

  return (
    <div className="px-5 pt-6 pb-10 space-y-5 md:max-w-3xl md:mx-auto">
      <div>
        <h1 className="text-2xl font-bold">{t(lang, "meal_snap_title")}</h1>
        <p className="text-sm text-ink/60 mt-1">{t(lang, "meal_snap_hint")}</p>
      </div>

      {!photo ? (
        <button
          onClick={() => cameraRef.current?.click()}
          disabled={busy}
          className="w-full rounded-2xl border-2 border-dashed border-border bg-bg-elev py-14 flex flex-col items-center justify-center gap-3 disabled:opacity-50"
        >
          <div className="w-16 h-16 rounded-full bg-bg-card flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="h-8 w-8 text-ink/80" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </div>
          <div className="text-sm text-ink/75">
            {busy ? t(lang, "meal_compress") : t(lang, "meal_snap_take")}
          </div>
        </button>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-2">
            {[photo, photo2].map((p, i) =>
              p ? (
                <div key={i} className="relative w-28 h-28 rounded-2xl overflow-hidden border border-border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.preview} alt="meal" className="w-full h-full object-cover" />
                  <button
                    onClick={() => removePhoto(i)}
                    aria-label="Remove photo"
                    className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/65 text-white text-sm leading-none flex items-center justify-center"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <button
                  key={i}
                  onClick={() => camera2Ref.current?.click()}
                  disabled={busy}
                  className="w-28 h-28 rounded-2xl border-2 border-dashed border-border bg-bg-elev text-[12px] text-ink/55 disabled:opacity-50"
                >
                  {t(lang, "meal_snap_second")}
                </button>
              ),
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-ink/60 mb-1.5">
              {t(lang, "meal_snap_note_label")}
            </label>
            <textarea
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              dir={note ? (/[֐-׿]/.test(note) ? "rtl" : "ltr") : lang === "he" ? "rtl" : "ltr"}
              placeholder={t(lang, "meal_snap_note_placeholder")}
              rows={3}
              className="w-full rounded-xl bg-bg-elev border border-border px-4 py-3 text-[15px] resize-none"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => cameraRef.current?.click()}
              disabled={busy}
              className="rounded-full border border-border bg-bg-elev px-4 py-3 text-sm text-ink/70 disabled:opacity-40"
            >
              {t(lang, "meal_snap_retake")}
            </button>
            <button
              onClick={save}
              disabled={busy}
              className="flex-1 rounded-full bg-accent-brand py-3 text-sm font-semibold disabled:opacity-40 text-on-brand"
            >
              {t(lang, "meal_snap_save")}
            </button>
          </div>
        </div>
      )}

      {flash && <div className="text-sm text-ok">{flash}</div>}
      {err && <div className="text-sm text-bad">{err}</div>}

      {waiting !== null && waiting > 0 && (
        <Link
          href="/meals/log"
          className="flex items-center justify-between rounded-2xl border border-border bg-bg-elev px-4 py-3 text-sm"
        >
          <span className="text-ink/75">
            {t(lang, "meal_snap_waiting").replace("{n}", String(waiting))}
          </span>
          <span className="text-accent-brand">{t(lang, "meal_snap_open_inbox")}</span>
        </Link>
      )}

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => onPick(e, 1)}
        className="sr-only"
      />
      <input
        ref={camera2Ref}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => onPick(e, 2)}
        className="sr-only"
      />
    </div>
  );
}
