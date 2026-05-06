// Server-only user identity helpers. Pulls `next/headers` so this file
// can never appear in a client bundle. API routes and Server Components
// import from here; client components import lib/user.ts instead.

import { cookies } from "next/headers";
import { USER_COOKIE, isUserId, type UserId } from "./user";

/** Resolve the current user from the request cookie, or null if unset. */
export function getCurrentUserId(): UserId | null {
  const c = cookies().get(USER_COOKIE)?.value;
  return isUserId(c) ? c : null;
}

/**
 * Same as getCurrentUserId but defaults to 'idan' instead of null. API
 * routes use this so they never 500 if a request slips through without
 * a cookie — they degrade gracefully to the legacy user. The /select-user
 * gate on the home page is the actual enforcement point.
 */
export function getCurrentUserIdOrDefault(): UserId {
  return getCurrentUserId() ?? "idan";
}
