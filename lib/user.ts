// User identity for the multi-user setup.
//
// The roster now lives in the DATABASE (the `users` table), not in code or in
// an env var — so adding/removing/reconfiguring a user needs no deploy. A new
// Google sign-in creates a 'pending' row; an admin approves it (status
// 'active') and sets its options from the in-app admin screen. Every per-user
// attribute (workouts, coaching notes, Hevy key env) is a column, never a
// `userId === "..."` branch scattered through the app.
//
// This module is SERVER-ONLY now (it reads the DB). It must not be imported
// from client components — the browser has no DB access. Server components,
// API routes, and the NextAuth callbacks import it. Auth-critical lookups run
// often, so results are cached in-memory for a few seconds.

import {
  getAllUserRows,
  getUserRowById,
  insertPendingUser,
  type UserRow,
} from "./db";

export type UserId = string;

export type UserStatus = "pending" | "active" | "disabled";

export type UserConfig = {
  id: UserId;
  displayName: string;
  email: string | null;
  status: UserStatus;
  isAdmin: boolean;
  // When false, hide the workouts page, today's workout card, recovery score,
  // and skip Hevy/training fetches.
  hasWorkouts: boolean;
  // Optional standing coaching direction, injected into the coach/insight
  // context as `training_notes` (e.g. muscle-focus priorities).
  trainingNotes?: string;
  // Name of the env var holding this user's Hevy API key. Defaults to
  // `HEVY_API_KEY_<ID>` (uppercased) when omitted.
  hevyKeyEnv?: string;
};

function rowToConfig(r: UserRow): UserConfig {
  const status: UserStatus =
    r.status === "active" || r.status === "disabled" ? r.status : "pending";
  return {
    id: r.id,
    displayName: r.display_name,
    email: r.email,
    status,
    isAdmin: r.is_admin === 1,
    hasWorkouts: r.has_workouts === 1,
    ...(r.training_notes ? { trainingNotes: r.training_notes } : {}),
    ...(r.hevy_key_env ? { hevyKeyEnv: r.hevy_key_env } : {}),
  };
}

// Short-lived in-memory cache of the whole roster. The roster is tiny and
// changes rarely, but auth reads it on many requests, so we avoid a DB round
// trip on each. Admin writes call invalidateUserCache() for an instant refresh.
const CACHE_TTL_MS = 10_000;
let _cache: { users: UserConfig[]; at: number } | null = null;

export function invalidateUserCache(): void {
  _cache = null;
}

async function loadUsers(): Promise<UserConfig[]> {
  const now = Date.now();
  if (_cache && now - _cache.at < CACHE_TTL_MS) return _cache.users;
  const rows = await getAllUserRows();
  const users = rows.map(rowToConfig);
  _cache = { users, at: now };
  return users;
}

/** Every user in the roster, any status. Ordered oldest-first. */
export async function getAllUsers(): Promise<UserConfig[]> {
  return loadUsers();
}

/** Only approved (active) users — the set that can actually use the app. */
export async function getActiveUsers(): Promise<UserConfig[]> {
  return (await loadUsers()).filter((u) => u.status === "active");
}

/** Config for a user by id. Reads the fresh row (bypassing the list cache) so
 *  a just-approved/edited user is reflected immediately. Falls back to a safe
 *  read-only default for an unknown id so callers can always read `.hasWorkouts`
 *  etc. without a null check. */
export async function getUserConfig(id: UserId): Promise<UserConfig> {
  const cached = _cache?.users.find((u) => u.id === id);
  if (cached) return cached;
  const row = await getUserRowById(id);
  if (row) return rowToConfig(row);
  return {
    id,
    displayName: id,
    email: null,
    status: "disabled",
    isAdmin: false,
    hasWorkouts: false,
  };
}

/**
 * Canonicalize an email for comparison. Gmail/Googlemail ignore dots in the
 * local part and treat everything after a "+" as a tag, so
 * "john.doe@gmail.com", "johndoe@gmail.com", and "john.doe+x@googlemail.com"
 * are all the same account. We normalize those so a stored address matches
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

/** The active user connected to this email, or null. Used by the NextAuth jwt
 *  callback to resolve the app user id for a signed-in Google account. */
export async function getActiveUserByEmail(
  email: string | null | undefined,
): Promise<UserConfig | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const users = await loadUsers();
  return (
    users.find(
      (u) => u.status === "active" && u.email && normalizeEmail(u.email) === normalized,
    ) ?? null
  );
}

/** Back-compat helper: the active user's id for an email, or null. */
export async function getUserIdByEmail(
  email: string | null | undefined,
): Promise<UserId | null> {
  return (await getActiveUserByEmail(email))?.id ?? null;
}

/**
 * Decide whether a verified Google account may sign in, and record unknown
 * accounts as pending so an admin can approve them later.
 * - active user for this email  → allow (true)
 * - pending/disabled user       → deny (false); the row already exists
 * - no user for this email       → create a pending row, then deny (false)
 * The id for a brand-new user is its normalized email (inherently unique and
 * stable across re-sign-ins before approval).
 */
export async function authorizeSignIn(params: {
  email: string | null | undefined;
  name?: string | null;
}): Promise<boolean> {
  const normalized = normalizeEmail(params.email);
  if (!normalized) return false;
  const users = await loadUsers();
  const existing = users.find(
    (u) => u.email && normalizeEmail(u.email) === normalized,
  );
  if (existing) return existing.status === "active";
  // First time we've seen this account — record it as pending for approval.
  await insertPendingUser(
    normalized,
    params.email?.trim() ?? normalized,
    params.name?.trim() || normalized.split("@")[0],
  );
  invalidateUserCache();
  return false;
}
