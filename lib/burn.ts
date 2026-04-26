// Pure (no-LLM) calorie-burn estimation for a strength session.
//
// Resistance training sits at MET ≈ 5.0 for "general / vigorous" effort.
// Burn (kcal) = MET × bodyWeightKg × hours.  For a 70 kg lifter doing a 60-min
// session that's ~350 kcal — in line with Compendium of Physical Activities
// values for resistance training.
//
// We add a small bump for very high-volume sessions (heavy compound days)
// because pure MET undercounts the post-workout EPOC bump on those days.
//
// Inputs: workout duration in minutes, total volume in kg (sum of weight × reps
// across working sets — already computed elsewhere), and the user's bodyweight.

const MET_RESISTANCE = 5.0;
const MIN_DURATION_MIN = 10;   // avoid junk durations from accidental session creates
const MAX_DURATION_MIN = 180;  // cap silly long sessions (forgot to end timer)
const VOLUME_BUMP_THRESHOLD_KG = 8000; // ~ a heavy-leg-day volume
const VOLUME_BUMP_MAX_PCT = 0.20;       // up to +20% on monster sessions

export type BurnInput = {
  durationMin: number;
  volumeKg: number;
  bodyWeightKg: number | null | undefined;
};

export type BurnEstimate = {
  kcal: number;
  durationMinClamped: number;
  bodyWeightKgUsed: number;
  volumeBumpPct: number;
  reason: string;
};

export function estimateWorkoutBurn(input: BurnInput): BurnEstimate {
  const bw =
    typeof input.bodyWeightKg === "number" && input.bodyWeightKg > 0
      ? input.bodyWeightKg
      : 75; // fallback if profile not set yet
  const dur = Math.min(
    MAX_DURATION_MIN,
    Math.max(MIN_DURATION_MIN, Math.round(input.durationMin || 0)),
  );

  const baseHours = dur / 60;
  const baseKcal = MET_RESISTANCE * bw * baseHours;

  // Volume bump: linearly scales 0 → 0.20 as volume goes 0 → threshold,
  // capped at +20%.
  const ratio = Math.max(
    0,
    Math.min(1, (input.volumeKg || 0) / VOLUME_BUMP_THRESHOLD_KG),
  );
  const bumpPct = ratio * VOLUME_BUMP_MAX_PCT;

  const kcal = Math.round(baseKcal * (1 + bumpPct));
  return {
    kcal,
    durationMinClamped: dur,
    bodyWeightKgUsed: bw,
    volumeBumpPct: Math.round(bumpPct * 100),
    reason: `MET 5.0 × ${bw}kg × ${dur}min${
      bumpPct > 0 ? ` + ${Math.round(bumpPct * 100)}% volume bump` : ""
    }`,
  };
}
