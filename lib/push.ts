// Web Push helper — wraps the `web-push` package with our VAPID config
// and a sender that prunes dead subscriptions on 404/410 (the standard
// "this endpoint is gone" responses from push services).
//
// Required env vars:
//   VAPID_PUBLIC_KEY           — base64url-encoded P-256 public key
//   VAPID_PRIVATE_KEY          — base64url-encoded P-256 private key
//   VAPID_SUBJECT              — "mailto:you@example.com" or https URL
//   NEXT_PUBLIC_VAPID_PUBLIC_KEY — same value as VAPID_PUBLIC_KEY, exposed
//                                  to the client for PushManager.subscribe().
//
// Generate the keypair once with:
//   npx web-push generate-vapid-keys

import webpush from "web-push";
import {
  deletePushSubscription,
  touchPushSubscription,
  type PushSubscriptionRow,
} from "./db";

let configured = false;

function ensureConfigured(): boolean {
  if (configured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:noreply@example.com";
  if (!publicKey || !privateKey) {
    console.warn("[push] VAPID keys not configured — skipping send");
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

export type SendResult =
  | { ok: true; endpoint: string }
  | { ok: false; endpoint: string; status: number; pruned: boolean; error: string };

/** Send a single push. On 404/410 the endpoint is removed from the DB.
 *  Other errors are reported but the subscription is left intact. */
export async function sendPush(
  sub: Pick<PushSubscriptionRow, "endpoint" | "p256dh" | "auth">,
  payload: PushPayload,
): Promise<SendResult> {
  if (!ensureConfigured()) {
    return { ok: false, endpoint: sub.endpoint, status: 0, pruned: false, error: "not configured" };
  }
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      JSON.stringify(payload),
      { TTL: 60 * 60 * 4 }, // best-effort for 4h
    );
    // Best-effort — don't block the send result on this.
    touchPushSubscription(sub.endpoint).catch(() => {});
    return { ok: true, endpoint: sub.endpoint };
  } catch (err: any) {
    const status = typeof err?.statusCode === "number" ? err.statusCode : 0;
    const gone = status === 404 || status === 410;
    if (gone) {
      await deletePushSubscription(sub.endpoint).catch(() => {});
    }
    return {
      ok: false,
      endpoint: sub.endpoint,
      status,
      pruned: gone,
      error: err?.message ?? String(err),
    };
  }
}

export async function sendPushToAll(
  subs: Pick<PushSubscriptionRow, "endpoint" | "p256dh" | "auth">[],
  payload: PushPayload,
): Promise<SendResult[]> {
  return Promise.all(subs.map((s) => sendPush(s, payload)));
}
