// POST  — register a Web Push subscription for the signed-in user.
// DELETE — remove a subscription (the user toggled push off, or the
//          browser told us the endpoint is no longer valid).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deletePushSubscription,
  upsertPushSubscription,
} from "@/lib/db";
import { getCurrentUserId } from "@/lib/user-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const UnsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const parsed = SubscribeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 400 });
  }
  await upsertPushSubscription(userId, parsed.data);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const parsed = UnsubscribeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 400 });
  }
  await deletePushSubscription(parsed.data.endpoint);
  return NextResponse.json({ ok: true });
}
