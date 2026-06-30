// Manually fire the morning daily-insight + push pipeline for the
// signed-in user. Same logic the /api/cron/daily-insight cron runs at
// 05:00 UTC daily, but scoped to the caller and gated by their normal
// session — no CRON_SECRET needed. Used from the Profile page so the
// user can verify everything end-to-end without waiting for the cron.

import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/user-server";
import {
  generateDailyInsightForUser,
  hasDailyInsightForToday,
} from "@/lib/insights";
import { getDb, getPushSubscriptionsForUser, todayStr } from "@/lib/db";
import { sendPushToAll } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    let headline: string;
    let generated = false;
    if (await hasDailyInsightForToday(userId)) {
      const db = await getDb();
      const res = await db.execute({
        sql: "SELECT headline FROM insights WHERE user_id = ? AND type = 'daily' AND for_date = ? ORDER BY id DESC LIMIT 1",
        args: [userId, todayStr()],
      });
      headline = (res.rows[0] as any)?.headline ?? "";
    } else {
      const ins = await generateDailyInsightForUser(userId);
      headline = ins.headline;
      generated = true;
    }

    const subs = await getPushSubscriptionsForUser(userId);
    const results = await sendPushToAll(subs, {
      title: "Your morning insight",
      body: headline,
      url: "/insights",
      tag: "daily-insight",
    });
    return NextResponse.json({
      ok: true,
      generated,
      headline,
      subscriptions: subs.length,
      pushed: results.filter((r) => r.ok).length,
      push_failed: results.filter((r) => !r.ok).length,
      results,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "morning_insight_failed" },
      { status: 500 },
    );
  }
}
