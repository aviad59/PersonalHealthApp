type Props = {
  headline: string;
  body: string;
  type?: "daily" | "weekly";
  tags?: string[];
  date?: string;
  compact?: boolean;
};

export default function InsightCard({
  headline,
  body,
  type = "daily",
  tags,
  date,
  compact,
}: Props) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-1">
        <span
          className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full ${
            type === "weekly"
              ? "bg-accent-brand/15 text-accent-brand"
              : "bg-accent-cal/15 text-accent-cal"
          }`}
        >
          {type === "weekly" ? "Weekly" : "Daily"}
        </span>
        {date && (
          <span className="text-[11px] text-white/40">{date}</span>
        )}
      </div>
      <h3 className={`font-semibold text-white ${compact ? "text-[15px]" : "text-base"}`}>
        {headline}
      </h3>
      <p className="text-sm text-white/70 mt-1 leading-relaxed">{body}</p>
      {tags && tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {tags.map((t) => (
            <span
              key={t}
              className="text-[10px] px-2 py-0.5 rounded-full bg-bg-elev border border-border text-white/60"
            >
              #{t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
