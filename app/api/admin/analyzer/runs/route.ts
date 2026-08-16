import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId, isCurrentUserAdmin } from "@/lib/user-server";
import {
  saveAnalyzerRun,
  listAnalyzerRuns,
  getAnalyzerRun,
  deleteAnalyzerRun,
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function guard(): Promise<string | null> {
  const userId = await getCurrentUserId();
  if (!userId || !(await isCurrentUserAdmin())) return null;
  return userId;
}

/** GET — list saved runs, or ?id= for one run including its per-dish cells. */
export async function GET(req: NextRequest) {
  if (!(await guard())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    const run = await getAnalyzerRun(id);
    if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ run });
  }
  return NextResponse.json({ runs: await listAnalyzerRuns() });
}

/** POST — save a completed run so the report survives a reload. */
export async function POST(req: NextRequest) {
  const userId = await guard();
  if (!userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.rows) || !Array.isArray(body.cells)) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const id = await saveAnalyzerRun({
    label: String(body.label || "run").slice(0, 120),
    note: body.note ? String(body.note).slice(0, 500) : null,
    config: body.config ?? {},
    rows: body.rows,
    cells: body.cells,
    created_by: userId,
  });
  return NextResponse.json({ id });
}

export async function DELETE(req: NextRequest) {
  if (!(await guard())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  await deleteAnalyzerRun(id);
  return NextResponse.json({ ok: true });
}
