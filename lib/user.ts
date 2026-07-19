// User identity for the multi-user setup — CLIENT-SAFE constants.
//
// This file must not import next/headers (which is server-only). The
// server-side auth/session helpers live in lib/user-server.ts and
// lib/auth.ts so they can be imported from API routes and Server
// Components without dragging next/headers/next-auth server internals
// into the client bundle.

export type UserId = "idan" | "orly" | "eran" | "dan";

export type UserConfig = {
  id: UserId;
  displayName: string;
  // Google account email allowed to sign in as this user. null means
  // "not connected yet" — sign-in attempts for this slot are rejected
  // until an email is set here.
  email: string | null;
  // When false, hide the workouts page, today's workout card, recovery score,
  // and skip Hevy/training fetches.
  hasWorkouts: boolean;
};

export const USERS: Record<UserId, UserConfig> = {
  idan: { id: "idan", displayName: "Idan", email: "idanaviad10@gmail.com", hasWorkouts: true },
  orly: { id: "orly", displayName: "Orly", email: "aviad59@gmail.com", hasWorkouts: false },
  eran: { id: "eran", displayName: "Eran", email: null, hasWorkouts: false },
  dan: { id: "dan", displayName: "Dan", email: "brima.dan@gmail.com", hasWorkouts: true },
};

export const USER_LIST: UserConfig[] = [USERS.idan, USERS.orly, USERS.eran, USERS.dan];

export function isUserId(s: string | null | undefined): s is UserId {
  return s === "idan" || s === "orly" || s === "eran" || s === "dan";
}

export function getUserConfig(id: UserId): UserConfig {
  return USERS[id];
}

/**
 * Canonicalize an email for comparison. Gmail/Googlemail ignore dots in the
 * local part and treat everything after a "+" as a tag, so
 * "brima.dan@gmail.com", "brimadan@gmail.com", and "brima.dan+x@googlemail.com"
 * are all the same account. We normalize those so a mapped address matches
 * whatever exact form Google returns for the signed-in user.
 */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return trimmed;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    local = local.split("+")[0].replace(/\./g, "");
  }
  return `${local}@${domain}`;
}

/** Maps a verified Google account email to its app UserId, or null if no slot is connected to that email. */
export function getUserIdByEmail(email: string | null | undefined): UserId | null {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  for (const u of USER_LIST) {
    if (u.email && normalizeEmail(u.email) === normalized) return u.id;
  }
  return null;
}
