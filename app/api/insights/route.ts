import { NextRequest, NextResponse } from "next/server";
import { getDb, getInsights } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const filter = new URL(req.url).searchParams.get("type"); // daily | weekly | null
  const insights = getInsights(100).filter((i) =>
    filter ? i.type === filter : true,
  );
  return NextResponse.json({
    insights: insights.map((i) => ({
      ...i,
      tags: i.tags_json ? safeParse(i.tags_json) : [],
      sources: i.sources_json ? safeParse(i.sources_json) : null,
    })),
  });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const db = getDb();
  db.prepare("DELETE FROM insights WHERE id = ?").run(Number(id));
  return NextResponse.json({ ok: true });
}

function safeParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
