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
import { getCurrentUserId } from "@/lib/user-server";
import { getUserConfig } from "@/lib/user";
import HomeClient from "./HomeClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/signin");
  const cfg = getUserConfig(userId);
  return (
    <HomeClient
      hasWorkouts={cfg.hasWorkouts}
      userDisplayName={cfg.displayName}
    />
  );
}
