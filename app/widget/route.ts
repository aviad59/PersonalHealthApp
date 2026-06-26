import { getProfile, getMealsByDate, todayStr } from "@/lib/db";
import { getCurrentUserIdOrDefault } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatDate(d: string) {
  const date = new Date(d + "T12:00:00");
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function bar(value: number, target: number) {
  const pct = Math.min(100, target > 0 ? Math.round((value / target) * 100) : 0);
  const color = pct >= 90 ? "#13c08a" : pct >= 60 ? "#0ea5e9" : "#7a8799";
  return `<div style="height:5px;background:#1a2030;border-radius:3px;overflow:hidden;margin-top:3px">
    <div style="height:100%;width:${pct}%;background:${color};border-radius:3px"></div>
  </div>`;
}

export async function GET() {
  const userId = await getCurrentUserIdOrDefault();
  const today = todayStr();

  const [profile, meals] = await Promise.all([
    getProfile(userId),
    getMealsByDate(userId, today),
  ]);

  const totals = meals.reduce(
    (acc, m) => ({
      calories: acc.calories + (m.calories ?? 0),
      protein_g: acc.protein_g + (m.protein_g ?? 0),
      fat_g: acc.fat_g + (m.fat_g ?? 0),
      carbs_g: acc.carbs_g + (m.carbs_g ?? 0),
    }),
    { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
  );

  const goalCal = profile?.goal_calories ?? 2000;
  const goalP = profile?.goal_protein_g ?? 150;
  const goalF = profile?.goal_fat_g ?? 65;
  const goalC = profile?.goal_carbs_g ?? 200;

  const cal = Math.round(totals.calories);
  const p = Math.round(totals.protein_g);
  const f = Math.round(totals.fat_g);
  const c = Math.round(totals.carbs_g);

  const calPct = Math.min(100, goalCal > 0 ? Math.round((cal / goalCal) * 100) : 0);
  const calColor = calPct >= 90 ? "#13c08a" : calPct >= 60 ? "#0ea5e9" : "#7a8799";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <meta http-equiv="refresh" content="300">
  <title>Macros</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{
      width:100%;height:100%;min-height:100vh;
      background:#080c10;color:#e8edf5;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      -webkit-font-smoothing:antialiased;
    }
    .w{
      padding:14px;
      display:flex;flex-direction:column;gap:10px;
      height:100vh;min-height:180px;
    }
    .hdr{font-size:11px;color:#7a8799;font-weight:500;letter-spacing:.02em}
    .cal-row{display:flex;align-items:baseline;gap:5px}
    .cal-num{font-size:38px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
    .cal-of{font-size:13px;color:#7a8799}
    .macros{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:2px}
    .macro{display:flex;flex-direction:column;gap:1px}
    .mlabel{font-size:10px;color:#7a8799;text-transform:uppercase;letter-spacing:.06em}
    .mval{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.2}
    .mtgt{font-size:10px;color:#7a8799}
    .btn{
      display:block;text-align:center;
      background:#0ea5e9;color:#fff;
      padding:9px 0;border-radius:12px;
      text-decoration:none;font-size:13px;font-weight:600;
      margin-top:auto;
    }
  </style>
</head>
<body>
<div class="w">
  <div class="hdr">Health &middot; ${formatDate(today)}</div>

  <div>
    <div class="cal-row">
      <span class="cal-num" style="color:${calColor}">${cal.toLocaleString()}</span>
      <span class="cal-of">/ ${goalCal.toLocaleString()} kcal</span>
    </div>
    <div style="height:5px;background:#1a2030;border-radius:3px;overflow:hidden;margin-top:6px">
      <div style="height:100%;width:${calPct}%;background:${calColor};border-radius:3px"></div>
    </div>
  </div>

  <div class="macros">
    <div class="macro">
      <span class="mlabel">Protein</span>
      <span class="mval" style="color:#f04444">${p}g</span>
      <span class="mtgt">/ ${goalP}g</span>
      ${bar(p, goalP)}
    </div>
    <div class="macro">
      <span class="mlabel">Fat</span>
      <span class="mval" style="color:#4a90e2">${f}g</span>
      <span class="mtgt">/ ${goalF}g</span>
      ${bar(f, goalF)}
    </div>
    <div class="macro">
      <span class="mlabel">Carbs</span>
      <span class="mval" style="color:#f5a623">${c}g</span>
      <span class="mtgt">/ ${goalC}g</span>
      ${bar(c, goalC)}
    </div>
  </div>

  <a href="/meals/log" class="btn">+ Log Meal</a>
</div>
</body>
</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
