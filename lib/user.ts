// User identity for the multi-user setup — CLIENT-SAFE constants.
//
// This file must not import next/headers (which is server-only). The
// server-side cookie helpers live in lib/user-server.ts so they can be
// imported from API routes and Server Components without dragging
// next/headers into the client bundle.

export const USER_COOKIE = "cowork_user";

export type UserId = "idan" | "orly" | "eran";

export type UserConfig = {
  id: UserId;
  displayName: string;
  // When false, hide the workouts page, today's workout card, recovery score,
  // and skip Hevy/training fetches.
  hasWorkouts: boolean;
};

export const USERS: Record<UserId, UserConfig> = {
  idan: { id: "idan", displayName: "Idan", hasWorkouts: true },
  orly: { id: "orly", displayName: "Orly", hasWorkouts: false },
  eran: { id: "eran", displayName: "Eran", hasWorkouts: true },
};

export const USER_LIST: UserConfig[] = [USERS.idan, USERS.orly, USERS.eran];

export function isUserId(s: string | null | undefined): s is UserId {
  return s === "idan" || s === "orly" || s === "eran";
}

export function getUserConfig(id: UserId): UserConfig {
  return USERS[id];
}
