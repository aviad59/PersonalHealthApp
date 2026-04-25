export const dynamic = "force-dynamic";

export default function HealthPage() {
  const zeppKey = process.env.ZEPP_API_KEY;
  return (
    <div className="px-5 pt-6 pb-10 space-y-5">
      <h1 className="text-2xl font-bold">Health</h1>
      <div className="card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-bg-elev border border-border flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="h-5 w-5 text-accent-brand" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78Z" />
            </svg>
          </div>
          <div>
            <div className="font-semibold">Zepp integration</div>
            <div className="text-xs text-white/50">Scaffold · coming soon</div>
          </div>
        </div>
        <div className="text-sm text-white/70 leading-relaxed">
          This page is a placeholder for your Zepp wearable data (sleep, HRV, resting heart rate, steps).
          Once you provide the <code className="text-accent-brand">ZEPP_API_KEY</code> and an integration spec, the Insights Engine will factor in:
        </div>
        <ul className="space-y-1 list-disc list-inside text-white/60 text-sm">
          <li>Sleep quality &amp; duration vs. training load</li>
          <li>Resting HR trends vs. nutrition / recovery</li>
          <li>Step count as NEAT signal for calorie targets</li>
        </ul>
        <div className="rounded-xl bg-bg-elev border border-border p-4 text-xs">
          <div className="text-white/60">API key detected:</div>
          <div className="font-mono mt-1">
            {zeppKey ? "\u2713 ZEPP_API_KEY set" : "\u2717 ZEPP_API_KEY not set"}
          </div>
        </div>
      </div>
    </div>
  );
}
