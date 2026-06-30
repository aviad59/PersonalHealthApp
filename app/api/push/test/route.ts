// "Send a test push" — POSTed from the Profile page, fires an immediate
// notification to every subscription the signed-in user has registered.
// Used to validate the VAPID config + SW push handler without waiting for
// the morning cron.

import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/user-server";
import { getPushSubscriptionsForUser } from "@/lib/db";
import { sendPushToAll } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const haveVapid =
    !!process.env.VAPID_PUBLIC_KEY && !!process.env.VAPID_PRIVATE_KEY;
  if (!haveVapid) {
    return NextResponse.json(
      { ok: false, reason: "VAPID keys not set in environment" },
      { status: 500 },
    );
  }

  const subs = await getPushSubscriptionsForUser(userId);
  if (subs.length === 0) {
    return NextResponse.json(
      { ok: false, reason: "No push subscriptions registered for this user" },
      { status: 404 },
    );
  }

  const results = await sendPushToAll(subs, {
    title: "Test push",
    body: "If you see this, notifications are wired up correctly.",
    url: "/",
    tag: "push-test",
  });
  return NextResponse.json({
    ok: true,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}
