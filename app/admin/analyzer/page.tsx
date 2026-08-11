// Admin analyzer lab — an eval harness for the meal analyzer. Server-guards on
// the session's admin flag before rendering anything; non-admins are bounced
// to Home (same pattern as the user-management admin page).

import { redirect } from "next/navigation";
import { getCurrentUserId, isCurrentUserAdmin } from "@/lib/user-server";
import AnalyzerLabClient from "./AnalyzerLabClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AnalyzerLabPage() {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/signin");
  if (!(await isCurrentUserAdmin())) redirect("/");
  return <AnalyzerLabClient />;
}
