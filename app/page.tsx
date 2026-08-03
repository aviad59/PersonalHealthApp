// Server entry for the home page.
//
// We deliberately do NOT fetch meal/insight/suggestion data here.
// Previously this server component ran 4 Turso queries on every nav
// (force-dynamic + no router cache) before any HTML was returned —
// users were seeing 1–2s click-to-render lag every time. Now the
// server does only the cheap session/config check; HomeClient hydrates
// from a localStorage snapshot on mount (instant paint) and refreshes
// from /api/today in the background, mirroring the stats/workouts
// pattern.

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getUserConfig } from "@/lib/user";
import { getProfile } from "@/lib/db";
import HomeClient from "./HomeClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await getServerSession(authOptions);
  const appUserId = (session as any)?.appUserId;
  const userId = typeof appUserId === "string" && appUserId ? appUserId : null;
  if (!userId) redirect("/signin");
  const [cfg, profile] = await Promise.all([
    getUserConfig(userId),
    getProfile(userId),
  ]);
  // A freshly-approved user has no profile yet — send them through onboarding
  // once so the app has their metrics/goals before showing an empty Home.
  if (!profile) redirect("/onboarding");
  // Greet with the person's real (Google) first name, not the roster label
  // (which for the bootstrap admin may just be "Admin"). Fall back to the
  // roster display name if the session has no name.
  const firstName = session?.user?.name?.trim().split(/\s+/)[0];
  return (
    <HomeClient
      hasWorkouts={cfg.hasWorkouts}
      userDisplayName={firstName || cfg.displayName}
    />
  );
}
