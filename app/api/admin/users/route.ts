// Admin-only user management. Lists the roster and lets an admin approve
// pending sign-ins and edit per-user settings. Guarded by the caller's own
// is_admin flag (resolved from the verified session), so a non-admin can't
// reach it even though middleware lets any signed-in user hit /api/*.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId, isCurrentUserAdmin } from "@/lib/user-server";
import { getAllUsers, invalidateUserCache } from "@/lib/user";
import { getAllUserRows, updateUserRow } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_STATUS = new Set(["pending", "active", "disabled"]);

export async function GET() {
  if (!(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Return the raw rows (all fields, all statuses) so the admin screen can
  // show pending requests and current settings.
  const rows = await getAllUserRows();
  return NextResponse.json({
    users: rows.map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      status: r.status,
      hasWorkouts: r.has_workouts === 1,
      isAdmin: r.is_admin === 1,
      trainingNotes: r.training_notes,
      hevyKeyEnv: r.hevy_key_env,
      // Never send the key itself back to the browser — only whether one is
      // stored, so the UI can show "set" without leaking it.
      hasHevyApiKey: !!r.hevy_api_key,
      createdAt: r.created_at,
    })),
  });
}

export async function PATCH(req: NextRequest) {
  const [isAdmin, myId] = await Promise.all([
    isCurrentUserAdmin(),
    getCurrentUserId(),
  ]);
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) {
    return NextResponse.json({ error: "missing user id" }, { status: 400 });
  }

  // Guard against self-lockout: an admin can't disable their own account or
  // strip their own admin rights (which could leave the app with no admin).
  if (id === myId && (body.status === "disabled" || body.isAdmin === false)) {
    return NextResponse.json(
      { error: "You can't disable or de-admin your own account." },
      { status: 400 },
    );
  }

  const patch: Parameters<typeof updateUserRow>[1] = {};
  if (typeof body.displayName === "string") patch.display_name = body.displayName.trim() || id;
  if (typeof body.email === "string") patch.email = body.email.trim() || null;
  if (typeof body.status === "string") {
    if (!VALID_STATUS.has(body.status)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    patch.status = body.status;
  }
  if (typeof body.hasWorkouts === "boolean") patch.has_workouts = body.hasWorkouts;
  if (typeof body.isAdmin === "boolean") patch.is_admin = body.isAdmin;
  if (typeof body.trainingNotes === "string" || body.trainingNotes === null) {
    patch.training_notes = body.trainingNotes ? String(body.trainingNotes).slice(0, 2000) : null;
  }
  if (typeof body.hevyKeyEnv === "string" || body.hevyKeyEnv === null) {
    patch.hevy_key_env = body.hevyKeyEnv ? String(body.hevyKeyEnv).trim() : null;
  }
  if (body.hevyApiKey !== undefined) {
    // Empty string clears it, so a key can be removed as well as set.
    patch.hevy_api_key = body.hevyApiKey ? String(body.hevyApiKey).trim() : null;
  }

  await updateUserRow(id, patch);
  invalidateUserCache();
  const users = await getAllUsers();
  return NextResponse.json({ ok: true, users });
}
