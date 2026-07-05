// Morning cron — generates today's daily insight per user and pushes a
// notification to all of their subscribed devices.
//
// Triggered by Vercel Cron (see vercel.json) at 05:00 UTC = 08:00 Asia/
// Jerusalem in IDT (summer) / 07:00 in IST (winter), which is "around 8 AM"
// for the user, the closest a single fixed UTC slot can get without
// straddling DST.
//
// Auth: Vercel attaches Authorization: Bearer <CRON_SECRET> on cron-
// triggered requests; we accept that, and as a fallback the same header
// can be sent manually for debugging.

import { NextRequest, NextResponse } from "next/server";
import { USER_LIST } from "@/lib/user";
import {
  generateDailyInsightForUser,
  hasDailyInsightForToday,
} from "@/lib/insights";
import { getPushSubscriptionsForUser } from "@/lib/db";
import { sendPushToAll } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 60 is the Hobby-plan ceiling — a higher value can fail the function's
// deployment. One user's generation+push takes ~10-20s, well within it.
export const maxDuration = 60;

type PerUserResult =
  | { user_id: string; status: "skipped_no_email" }
  | { user_id: string; status: "no_insight"; error: string }
  | {
      user_id: string;
      status: "generated" | "reused";
      headline: string;
      pushed: number;
      push_failed: number;
    };

function isAuthorized(req: NextRequest): boolean {
  // Bearer-secret path: Vercel automatically attaches
  // "Authorization: Bearer <CRON_SECRET>" to cron invocations when the
  // CRON_SECRET env var is set; the same header works for manual curls.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = req.headers.get("authorization") || "";
    if (header === `Bearer ${secret}`) return true;
  }
  // Vercel cron identifies itself with this user-agent. It's spoofable in
  // principle, but the worst an outsider can do is trigger an insight
  // generation + push to the user's own devices — annoying, not harmful —
  // and without this fallback the cron silently 401s forever when
  // CRON_SECRET was never added to the project env. (The previous check
  // looked for an "x-vercel-cron" header that Vercel doesn't send, which
  // is exactly what happened.)
  const ua = req.headers.get("user-agent") || "";
  if (ua.startsWith("vercel-cron/")) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    console.warn("[cron/daily-insight] unauthorized", {
      hasSecretEnv: !!process.env.CRON_SECRET,
      hasAuthHeader: !!req.headers.get("authorization"),
      userAgent: req.headers.get("user-agent"),
    });
    return NextResponse.json(
      {
        error: "unauthorized",
        hint: "Expected Authorization: Bearer <CRON_SECRET> or the vercel-cron user-agent.",
      },
      { status: 401 },
    );
  }

  // Surface config gaps in the response so a failed run is easy to
  // diagnose from the Vercel cron log instead of looking like a generic
  // 200 with empty effects.
  const env = {
    have_vapid_public: !!process.env.VAPID_PUBLIC_KEY,
    have_vapid_private: !!process.env.VAPID_PRIVATE_KEY,
    have_vapid_subject: !!process.env.VAPID_SUBJECT,
    have_anthropic_key: !!process.env.ANTHROPIC_API_KEY,
    have_cron_secret: !!process.env.CRON_SECRET,
  };

  const results: PerUserResult[] = [];

  for (const user of USER_LIST) {
    // No email mapped → no real user behind the slot; nothing to send to.
    if (!user.email) {
      results.push({ user_id: user.id, status: "skipped_no_email" });
      continue;
    }
    try {
      const already = await hasDailyInsightForToday(user.id);
      let headline: string;
      let body: string;
      let status: "generated" | "reused";
      if (already) {
        // Already have one (e.g. user opened the app earlier and triggered
        // generation manually) — reuse it for the notification.
        const existing = await loadTodaysInsight(user.id);
        if (!existing) {
          results.push({ user_id: user.id, status: "no_insight", error: "today's insight not found" });
          continue;
        }
        headline = existing.headline;
        body = existing.body;
        status = "reused";
      } else {
        // Morning mode: retrospective over recent days — "today" is empty
        // at this hour and recent gaps may just be un-uploaded batches.
        const ins = await generateDailyInsightForUser(user.id, { morning: true });
        headline = ins.headline;
        body = ins.body;
        status = "generated";
      }

      const subs = await getPushSubscriptionsForUser(user.id);
      // Headline as the notification title, full insight text as the body —
      // Android expands multi-line notifications, so the user gets the whole
      // insight without opening the app.
      const sendResults = await sendPushToAll(subs, {
        title: headline,
        body: body.length > 600 ? body.slice(0, 597) + "…" : body,
        url: "/insights",
        tag: "daily-insight",
      });
      const pushed = sendResults.filter((r) => r.ok).length;
      const push_failed = sendResults.filter((r) => !r.ok).length;
      results.push({ user_id: user.id, status, headline, pushed, push_failed });
    } catch (e: any) {
      results.push({
        user_id: user.id,
        status: "no_insight",
        error: e?.message ?? "generation failed",
      });
    }
  }

  // Shows up in the Vercel function log for the cron run, so a bad morning
  // is diagnosable without reproducing it.
  console.log("[cron/daily-insight] run complete", JSON.stringify({ env, results }));

  return NextResponse.json({ ok: true, env, results });
}

async function loadTodaysInsight(
  userId: string,
): Promise<{ headline: string; body: string } | null> {
  const { getDb, todayStr } = await import("@/lib/db");
  const db = await getDb();
  const res = await db.execute({
    sql: "SELECT headline, body FROM insights WHERE user_id = ? AND type = 'daily' AND for_date = ? ORDER BY id DESC LIMIT 1",
    args: [userId, todayStr()],
  });
  const row = res.rows[0] as any;
  return row ? { headline: row.headline, body: row.body ?? "" } : null;
}
