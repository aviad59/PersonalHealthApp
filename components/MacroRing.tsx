"use client";

type Props = {
  label: string;
  value: number;
  target: number;
  unit: string;
  color: string; // hex or CSS color
  size?: number; // px
};

export default function MacroRing({
  label,
  value,
  target,
  unit,
  color,
  size = 92,
}: Props) {
  const pct = target > 0 ? Math.min(1, value / target) : 0;
  const stroke = 9;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * pct;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke="#26262b"
            strokeWidth={stroke}
            fill="none"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={color}
            strokeWidth={stroke}
            fill="none"
            strokeDasharray={`${dash} ${c}`}
            strokeLinecap="round"
            style={{ transition: "stroke-dasharray 300ms ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-sm font-semibold text-white">{Math.round(value)}</div>
          <div className="text-[10px] text-white/50">/ {target}{unit}</div>
        </div>
      </div>
      <div className="text-[11px] uppercase tracking-wide text-white/60">{label}</div>
    </div>
  );
}
