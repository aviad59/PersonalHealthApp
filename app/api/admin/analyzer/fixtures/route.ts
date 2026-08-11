import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId, isCurrentUserAdmin } from "@/lib/user-server";
import {
  listAnalyzerFixtures,
  createAnalyzerFixture,
  deleteAnalyzerFixture,
  type NewAnalyzerFixture,
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function guard(): Promise<string | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;
  if (!(await isCurrentUserAdmin())) return null;
  return userId;
}

/** GET — list all fixtures (without full-size photos). */
export async function GET() {
  if (!(await guard())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const fixtures = await listAnalyzerFixtures();
  return NextResponse.json({ fixtures });
}

/** POST — create a fixture. Body carries any photo already base64-encoded. */
export async function POST(req: NextRequest) {
  const userId = await guard();
  if (!userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const label = String(body.label || "").trim();
  const mode = body.mode === "text" ? "text" : "photo";
  if (!label) {
    return NextResponse.json({ error: "label is required" }, { status: 400 });
  }
  if (mode === "photo" && !body.photo_base64) {
    return NextResponse.json(
      { error: "photo mode requires a photo" },
      { status: 400 },
    );
  }
  if (mode === "text" && !String(body.input_text || "").trim()) {
    return NextResponse.json(
      { error: "text mode requires a description" },
      { status: 400 },
    );
  }

  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const fixture: NewAnalyzerFixture = {
    label,
    mode,
    photo_base64: mode === "photo" ? String(body.photo_base64) : null,
    photo_thumb_base64: body.photo_thumb_base64
      ? String(body.photo_thumb_base64)
      : null,
    photo_mime: body.photo_mime ? String(body.photo_mime) : "image/jpeg",
    input_text: body.input_text ? String(body.input_text) : null,
    expected_calories: num(body.expected_calories),
    expected_protein_g: num(body.expected_protein_g),
    expected_fat_g: num(body.expected_fat_g),
    expected_carbs_g: num(body.expected_carbs_g),
    notes: body.notes ? String(body.notes) : null,
    created_by: userId,
  };

  const id = await createAnalyzerFixture(fixture);
  return NextResponse.json({ id });
}

/** DELETE — remove a fixture by ?id=. */
export async function DELETE(req: NextRequest) {
  if (!(await guard())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  await deleteAnalyzerFixture(id);
  return NextResponse.json({ ok: true });
}
