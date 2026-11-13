// Fallback for Share → Health when the service worker isn't controlling the
// page yet (first launch after install): the SW normally intercepts this POST
// and stashes the photos. Without it we can't hand the files to the client,
// so just land on the logger instead of a 404.

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return NextResponse.redirect(new URL("/meals/log", req.url), 303);
}
