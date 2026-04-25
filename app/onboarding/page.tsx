"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ACTIVITY_LABELS } from "@/lib/calc";

type Form = {
  age: string;
  sex: "male" | "female";
  height_cm: string;
  weight_kg: string;
  neck_cm: string;
  waist_cm: string;
  hips_cm: string;
  activity_level: keyof typeof ACTIVITY_LABELS;
  goal_mode: "recomp" | "cut" | "bulk" | "maintain";
};

const steps = ["Basics", "Body", "Activity", "Goal", "Review"] as const;

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<any | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [form, setForm] = useState<Form>({
    age: "",
    sex: "male",
    height_cm: "",
    weight_kg: "",
    neck_cm: "",
    waist_cm: "",
    hips_cm: "",
    activity_level: "moderate",
    goal_mode: "recomp",
  });

  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const toPayload = () => ({
    age: parseInt(form.age, 10),
    sex: form.sex,
    height_cm: parseFloat(form.height_cm),
    weight_kg: parseFloat(form.weight_kg),
    neck_cm: parseFloat(form.neck_cm),
    waist_cm: parseFloat(form.waist_cm),
    hips_cm: form.sex === "female" ? parseFloat(form.hips_cm) : null,
    activity_level: form.activity_level,
    goal_mode: form.goal_mode,
  });

  const basicsOk =
    form.age && form.sex && form.height_cm && form.weight_kg;
  const bodyOk =
    form.neck_cm &&
    form.waist_cm &&
    (form.sex === "male" || form.hips_cm);
  const canNext = [basicsOk, bodyOk, true, true, true][step];

  async function loadPreview() {
    setPreviewError(null);
    setPreview(null);
    try {
      const res = await fetch("/api/goals/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toPayload()),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "preview failed");
      setPreview(j);
    } catch (e: any) {
      setPreviewError(e.message);
    }
  }

  async function submit() {
    setSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toPayload()),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "save failed");
      router.push("/");
      router.refresh();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-5 pt-6 pb-40">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Let&apos;s get set up</h1>
        <span className="text-xs text-white/50">
          Step {step + 1}/{steps.length}
        </span>
      </div>
      <div className="flex gap-1.5 mb-8">
        {steps.map((_, i) => (
          <div
            key={i}
            className={`flex-1 h-1 rounded-full ${
              i <= step ? "bg-accent-brand" : "bg-bg-elev"
            }`}
          />
        ))}
      </div>

      {step === 0 && (
        <Card>
          <H>About you</H>
          <Field label="Age">
            <NumberInput value={form.age} onChange={(v) => set("age", v)} placeholder="28" />
          </Field>
          <Field label="Sex">
            <div className="grid grid-cols-2 gap-2">
              <Toggle
                active={form.sex === "male"}
                onClick={() => set("sex", "male")}
              >
                Male
              </Toggle>
              <Toggle
                active={form.sex === "female"}
                onClick={() => set("sex", "female")}
              >
                Female
              </Toggle>
            </div>
          </Field>
          <Field label="Height (cm)">
            <NumberInput value={form.height_cm} onChange={(v) => set("height_cm", v)} placeholder="178" />
          </Field>
          <Field label="Weight (kg)">
            <NumberInput value={form.weight_kg} onChange={(v) => set("weight_kg", v)} placeholder="78" />
          </Field>
        </Card>
      )}

      {step === 1 && (
        <Card>
          <H>Tape measurements</H>
          <p className="text-sm text-white/60 mb-4">
            We use the U.S. Navy formula to estimate body fat. Measure at the narrowest point for each.
          </p>
          <Field label="Neck (cm)">
            <NumberInput value={form.neck_cm} onChange={(v) => set("neck_cm", v)} placeholder="38" />
          </Field>
          <Field label="Waist (cm) — at navel">
            <NumberInput value={form.waist_cm} onChange={(v) => set("waist_cm", v)} placeholder="82" />
          </Field>
          {form.sex === "female" && (
            <Field label="Hips (cm) — widest">
              <NumberInput value={form.hips_cm} onChange={(v) => set("hips_cm", v)} placeholder="98" />
            </Field>
          )}
        </Card>
      )}

      {step === 2 && (
        <Card>
          <H>Activity level</H>
          <div className="space-y-2">
            {(Object.keys(ACTIVITY_LABELS) as (keyof typeof ACTIVITY_LABELS)[]).map((key) => (
              <button
                key={key}
                onClick={() => set("activity_level", key)}
                className={`w-full text-left rounded-xl border px-4 py-3 transition-colors ${
                  form.activity_level === key
                    ? "border-accent-brand bg-accent-brand/10"
                    : "border-border bg-bg-elev hover:border-white/20"
                }`}
              >
                <div className="text-sm font-medium text-white">{ACTIVITY_LABELS[key]}</div>
              </button>
            ))}
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card>
          <H>Your primary goal</H>
          <div className="grid grid-cols-2 gap-2">
            {([
              ["recomp", "Recomp", "lose fat + build muscle"],
              ["cut", "Cut", "lose fat"],
              ["bulk", "Bulk", "build muscle"],
              ["maintain", "Maintain", "stay where I am"],
            ] as const).map(([key, label, sub]) => (
              <button
                key={key}
                onClick={() => set("goal_mode", key)}
                className={`rounded-xl border px-3 py-3 text-left ${
                  form.goal_mode === key
                    ? "border-accent-brand bg-accent-brand/10"
                    : "border-border bg-bg-elev"
                }`}
              >
                <div className="text-sm font-semibold">{label}</div>
                <div className="text-[11px] text-white/50">{sub}</div>
              </button>
            ))}
          </div>
        </Card>
      )}

      {step === 4 && (
        <Card>
          <H>Review</H>
          <p className="text-sm text-white/60 mb-3">We&apos;ll calculate personalized goals based on your inputs.</p>
          <button
            onClick={loadPreview}
            className="w-full rounded-xl bg-accent-brand/15 border border-accent-brand/40 text-accent-brand py-3 text-sm font-semibold mb-4"
          >
            Calculate my targets
          </button>
          {previewError && (
            <div className="text-sm text-red-400 mb-3">{previewError}</div>
          )}
          {preview && (
            <div className="space-y-3">
              <Row k="Body fat" v={`${preview.body_fat_pct}%`} />
              <Row k="Lean mass" v={`${preview.lean_mass_kg} kg`} />
              <Row k="BMR" v={`${preview.bmr} kcal`} />
              <Row k="TDEE" v={`${preview.tdee} kcal`} />
              <div className="h-px bg-border my-2" />
              <Row k="Daily calories" v={`${preview.goal_calories} kcal`} emphasize />
              <Row k="Protein" v={`${preview.goal_protein_g} g`} emphasize />
              <Row k="Fat" v={`${preview.goal_fat_g} g`} emphasize />
              <Row k="Carbs" v={`${preview.goal_carbs_g} g`} emphasize />
              <div className="h-px bg-border my-2" />
              <Row k="Weekly workouts" v={`${preview.weekly_workout_target} sessions`} />
              <div className="text-xs text-white/50 mt-1">{preview.weekly_volume_note}</div>
            </div>
          )}
        </Card>
      )}

      <div className="fixed bottom-0 left-0 right-0 safe-bottom bg-gradient-to-t from-bg via-bg/95 to-transparent pt-6 pb-4">
        <div className="mx-auto max-w-md px-5 flex gap-3">
          {step > 0 && (
            <button
              onClick={() => setStep((s) => s - 1)}
              className="flex-1 rounded-xl border border-border bg-bg-elev py-3 text-sm font-medium"
            >
              Back
            </button>
          )}
          {step < steps.length - 1 ? (
            <button
              disabled={!canNext}
              onClick={() => setStep((s) => s + 1)}
              className="flex-[2] rounded-xl bg-accent-brand py-3 text-sm font-semibold text-white disabled:opacity-40"
            >
              Continue
            </button>
          ) : (
            <button
              disabled={saving || !preview}
              onClick={submit}
              className="flex-[2] rounded-xl bg-accent-brand py-3 text-sm font-semibold text-white disabled:opacity-40"
            >
              {saving ? "Saving..." : "Save & start"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="card p-5 space-y-4">{children}</div>;
}
function H({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold">{children}</h2>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-white/60 mb-1.5">{label}</label>
      {children}
    </div>
  );
}
function NumberInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
      placeholder={placeholder}
      className="w-full rounded-xl bg-bg-elev border border-border px-4 py-3 text-[15px] text-white placeholder-white/30 focus:outline-none focus:border-accent-brand"
    />
  );
}
function Toggle({
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
      className={`rounded-xl py-3 text-sm font-medium transition-colors ${
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
