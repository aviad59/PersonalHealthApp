// Admin screen — user management. Server-guards on the session's admin flag
// before rendering anything; non-admins are bounced to Home.

import { redirect } from "next/navigation";
import { getCurrentUserId, isCurrentUserAdmin } from "@/lib/user-server";
import AdminUsersClient from "./AdminUsersClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/signin");
  if (!(await isCurrentUserAdmin())) redirect("/");
  return <AdminUsersClient />;
}
