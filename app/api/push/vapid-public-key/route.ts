// Exposes the public VAPID key so the client can pass it to
// PushManager.subscribe(). Keeping this as an API call (instead of
// inlining via NEXT_PUBLIC_* env injection) lets us rotate keys
// without a redeploy.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const key =
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ||
    process.env.VAPID_PUBLIC_KEY ||
    null;
  return NextResponse.json({ key });
}
