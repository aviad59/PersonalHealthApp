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
export const maxDuration = 300; // generation + send can take a minute per user

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
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") || "";
  return header === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
      let status: "generated" | "reused";
      if (already) {
        // Already have one (e.g. user opened the app earlier and triggered
        // generation manually) — reuse it for the notification body.
        const existingHeadline = await loadTodaysHeadline(user.id);
        if (!existingHeadline) {
          results.push({ user_id: user.id, status: "no_insight", error: "today's insight not found" });
          continue;
        }
        headline = existingHeadline;
        status = "reused";
      } else {
        const ins = await generateDailyInsightForUser(user.id);
        headline = ins.headline;
        status = "generated";
      }

      const subs = await getPushSubscriptionsForUser(user.id);
      const sendResults = await sendPushToAll(subs, {
        title: "Your morning insight",
        body: headline,
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

  return NextResponse.json({ ok: true, results });
}

async function loadTodaysHeadline(userId: string): Promise<string | null> {
  const { getDb, todayStr } = await import("@/lib/db");
  const db = await getDb();
  const res = await db.execute({
    sql: "SELECT headline FROM insights WHERE user_id = ? AND type = 'daily' AND for_date = ? ORDER BY id DESC LIMIT 1",
    args: [userId, todayStr()],
  });
  const row = res.rows[0] as any;
  return row?.headline ?? null;
}
