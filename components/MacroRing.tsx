"use client";

type Props = {
  label: string;
  value: number;
  target: number;
  unit: string;
  color: string; // hex or CSS color for the base ring
  size?: number; // px
  /** Whether exceeding the target is a bad thing. Only true for macros that
   *  are budgets you want to stay close to (calories, fat). Protein and
   *  carbs are floors / not penalized for overshoot — the ring should just
   *  read as "hit your goal" without a warning layer. Defaults to true so
   *  callers that omit it stay conservative. */
  warnOnOver?: boolean;
};

/** Macro ring with optional overage layer.
 *
 *  - When `value <= target`, render a single ring filled to value/target in
 *    the macro's brand color.
 *  - When `value > target` AND `warnOnOver` is true, the base ring stays
 *    filled to 100% and we render a second, slightly thinner outer ring
 *    whose dash tracks how far past target the user went, drawn in an
 *    amber→red glow to flag the overshoot. The overage ring caps at one
 *    full revolution (200% of target) so a 3× day doesn't spin invisibly.
 *  - When `warnOnOver` is false (protein/carbs), going past target just
 *    keeps the base ring full — no warning treatment, since hitting more
 *    protein or more carbs is fine.
 */
export default function MacroRing({
  label,
  value,
  target,
  unit,
  color,
  size = 92,
  warnOnOver = true,
}: Props) {
  const safeTarget = target > 0 ? target : 0;
  const ratio = safeTarget > 0 ? value / safeTarget : 0;
  const basePct = Math.min(1, ratio);
  const over = warnOnOver ? Math.max(0, ratio - 1) : 0;
  const overPct = Math.min(1, over); // visually cap at +100% past target

  const stroke = 12;
  const overStroke = 5;
  const overGap = 4; // px between base ring and overage ring
  const baseR = (size - stroke) / 2;
  const baseC = 2 * Math.PI * baseR;
  const baseDash = baseC * basePct;

  const overR = baseR + stroke / 2 + overGap + overStroke / 2;
  const overC = 2 * Math.PI * overR;
  const overDash = overC * overPct;

  // SVG must be large enough to contain the overage ring + glow.
  const svgSize = size + (overGap + overStroke + 6) * 2;
  const center = svgSize / 2;

  const hasOver = over > 0;
  const safeLabel = label.replace(/\s+/g, "");
  const gradientId = `over-${safeLabel}`;
  const innerId = `inner-${safeLabel}`;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: svgSize, height: svgSize }}>
        <svg width={svgSize} height={svgSize} className="-rotate-90">
          <defs>
            {/* Inner shadow so the track reads as a recessed groove and the
                value arc looks like it fills it. */}
            <filter id={innerId} x="-30%" y="-30%" width="160%" height="160%">
              <feOffset dx="0" dy="1.2" />
              <feGaussianBlur stdDeviation="1.6" result="offset-blur" />
              <feComposite operator="out" in="SourceGraphic" in2="offset-blur" result="inverse" />
              <feFlood floodColor="#000000" floodOpacity="0.6" result="color" />
              <feComposite operator="in" in="color" in2="inverse" result="shadow" />
              <feComposite operator="over" in="shadow" in2="SourceGraphic" />
            </filter>
            {hasOver && (
              <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#f59e0b" />
                <stop offset="100%" stopColor="#ef4444" />
              </linearGradient>
            )}
          </defs>

          {/* Base track — recessed groove via inner-shadow filter */}
          <circle
            cx={center}
            cy={center}
            r={baseR}
            stroke="#1b2029"
            strokeWidth={stroke}
            fill="none"
            filter={`url(#${innerId})`}
          />
          {/* Base value ring — sits in the groove with a soft glow so it
              reads as a filled level. */}
          <circle
            cx={center}
            cy={center}
            r={baseR}
            stroke={color}
            strokeWidth={stroke}
            fill="none"
            strokeDasharray={`${baseDash} ${baseC}`}
            strokeLinecap="round"
            style={{
              transition: "stroke-dasharray 300ms ease",
              filter: basePct > 0 ? `drop-shadow(0 0 3px ${color}66)` : undefined,
            }}
          />

          {/* Overage layer */}
          {hasOver && (
            <>
              {/* Faint outer track so the overage ring has something to sit on */}
              <circle
                cx={center}
                cy={center}
                r={overR}
                stroke="#26262b"
                strokeOpacity={0.7}
                strokeWidth={overStroke}
                fill="none"
              />
              <circle
                cx={center}
                cy={center}
                r={overR}
                stroke={`url(#${gradientId})`}
                strokeWidth={overStroke}
                fill="none"
                strokeDasharray={`${overDash} ${overC}`}
                strokeLinecap="round"
                style={{
                  filter: "drop-shadow(0 0 3px rgba(239, 68, 68, 0.6))",
                  transition: "stroke-dasharray 300ms ease",
                }}
              />
            </>
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className={`text-sm font-semibold ${hasOver ? "text-amber-300" : "text-white"}`}>
            {Math.round(value)}
          </div>
          <div className="text-[10px] text-white/50">
            / {target}
            {unit}
          </div>
        </div>
      </div>
      <div className="text-[11px] uppercase tracking-wide text-white/60">{label}</div>
    </div>
  );
}
