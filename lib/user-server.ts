// Server-only user identity helpers. Pulls `next/headers` (via NextAuth)
// so this file can never appear in a client bundle. API routes and
// Server Components import from here; client components use
// next-auth/react's useSession() instead.

import { getServerSession } from "next-auth";
import { authOptions } from "./auth";
import { isUserId, type UserId } from "./user";

/**
 * Resolve the current user from the verified Google session, or null if
 * unauthenticated. Unlike the old cookie-based version, this cannot be
 * spoofed by the client — it's derived from a server-verified, signed
 * session token.
 */
export async function getCurrentUserId(): Promise<UserId | null> {
  const session = await getServerSession(authOptions);
  const id = (session as any)?.appUserId;
  return isUserId(id) ? id : null;
}

/**
 * Same as getCurrentUserId, but throws instead of silently falling back
 * to a default user. Authentication middleware already blocks
 * unauthenticated requests before they reach route handlers, so reaching
 * this point with no session indicates a bug, not a normal/expected
 * path — it must never default to another user's data.
 */
export async function getCurrentUserIdOrDefault(): Promise<UserId> {
  const id = await getCurrentUserId();
  if (!id) {
    throw new Error("getCurrentUserIdOrDefault: no authenticated session");
  }
  return id;
}
