// User identity for the multi-user setup — CLIENT-SAFE constants.
//
// This file must not import next/headers (which is server-only). The
// server-side auth/session helpers live in lib/user-server.ts and
// lib/auth.ts so they can be imported from API routes and Server
// Components without dragging next/headers/next-auth server internals
// into the client bundle.
//
// The roster is DATA, not code. It is loaded from the APP_USERS environment
// variable (a JSON array) so that adding, removing, or reconfiguring a user
// is an env change — no code edit, no redeploy of logic, and no personal
// emails committed to the repo. Every per-user attribute (whether they have
// workouts, their coaching notes, which env var holds their Hevy key) is a
// FIELD on this data, never a `userId === "..."` branch scattered through
// the app. If APP_USERS is unset or malformed we fall back to the built-in
// defaults below so the app still boots.

export type UserId = string;

export type UserConfig = {
  id: UserId;
  displayName: string;
  // Google account email allowed to sign in as this user. null means
  // "not connected yet" — sign-in attempts for this slot are rejected
  // until an email is set. Keep real emails in APP_USERS (env), not here.
  email: string | null;
  // When false, hide the workouts page, today's workout card, recovery score,
  // and skip Hevy/training fetches.
  hasWorkouts: boolean;
  // Optional standing coaching direction for this user, injected into the
  // coach/insight context as `training_notes` (e.g. muscle-focus priorities).
  // Replaces what used to be a hardcoded `if (userId === "idan")` blob.
  trainingNotes?: string;
  // Name of the env var holding this user's Hevy API key. Each workouts-enabled
  // user needs their OWN key so we never pull another user's workouts. Defaults
  // to `HEVY_API_KEY_<ID>` (uppercased) when omitted.
  hevyKeyEnv?: string;
};

// Built-in fallback roster, used only when APP_USERS is not set. Set real
// addresses via APP_USERS in the environment to keep them out of the repo.
// (`idan` keeps the legacy bare HEVY_API_KEY via hevyKeyEnv.)
const DEFAULT_USERS: UserConfig[] = [
  { id: "idan", displayName: "Idan", email: "idanaviad10@gmail.com", hasWorkouts: true, hevyKeyEnv: "HEVY_API_KEY", trainingNotes: "Legs are intentionally undertrained (already strong/overdeveloped). Priority is chest and arm (biceps/triceps) development, which are currently weaker. Never surface leg volume or leg frequency as an issue. Focus muscle commentary on chest, arms, shoulders, back, and core." },
  { id: "orly", displayName: "Orly", email: "aviad59@gmail.com", hasWorkouts: false },
  { id: "eran", displayName: "Eran", email: null, hasWorkouts: false },
  { id: "dan", displayName: "Dan", email: "brima.dan@gmail.com", hasWorkouts: true },
];

/** Parse and validate one entry from the APP_USERS JSON array. Returns null
 *  for anything missing the required id so a single bad row can't take the
 *  whole roster down. */
function coerceUser(raw: any): UserConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const displayName =
    typeof raw.displayName === "string" && raw.displayName.trim()
      ? raw.displayName.trim()
      : id;
  return {
    id,
    displayName,
    email: typeof raw.email === "string" && raw.email.trim() ? raw.email.trim() : null,
    hasWorkouts: raw.hasWorkouts === true,
    ...(typeof raw.trainingNotes === "string" && raw.trainingNotes.trim()
      ? { trainingNotes: raw.trainingNotes.trim() }
      : {}),
    ...(typeof raw.hevyKeyEnv === "string" && raw.hevyKeyEnv.trim()
      ? { hevyKeyEnv: raw.hevyKeyEnv.trim() }
      : {}),
  };
}

function loadRoster(): UserConfig[] {
  const raw = process.env.APP_USERS;
  if (!raw || !raw.trim()) return DEFAULT_USERS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("APP_USERS must be a JSON array");
    const users = parsed.map(coerceUser).filter((u): u is UserConfig => u !== null);
    if (users.length === 0) throw new Error("APP_USERS has no valid users");
    return users;
  } catch (e) {
    // Never boot with a broken roster — fall back and make the reason loud.
    console.error("[user] Failed to parse APP_USERS; using default roster.", e);
    return DEFAULT_USERS;
  }
}

// Resolved once at module load. Env is fixed for a process lifetime, so
// there's no benefit to re-parsing per request (and auth runs this a lot).
export const USER_LIST: UserConfig[] = loadRoster();

export const USERS: Record<UserId, UserConfig> = Object.fromEntries(
  USER_LIST.map((u) => [u.id, u]),
);

export function isUserId(s: string | null | undefined): s is UserId {
  return typeof s === "string" && s in USERS;
}

/** Config for a known user, or a safe read-only default for an unknown id
 *  (workouts off, no email) so callers can always read `.hasWorkouts` etc.
 *  without a null check. */
export function getUserConfig(id: UserId): UserConfig {
  return USERS[id] ?? { id, displayName: id, email: null, hasWorkouts: false };
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
