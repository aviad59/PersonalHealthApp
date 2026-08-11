import { NextRequest, NextResponse } from "next/server";
import { analyzeMeal, type AnalyzeImage, type BaseMeal } from "@/lib/analyze";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const lang = req.cookies.get("lang")?.value || "en";
  const form = await req.formData();
  const file = form.get("photo");
  const file2 = form.get("photo2");
  const hint = (form.get("hint") as string | null)?.trim() || "";
  const text = (form.get("text") as string | null)?.trim() || "";
  const baseRaw = (form.get("base") as string | null)?.trim() || "";
  let base: BaseMeal | null = null;
  if (baseRaw) {
    try {
      base = JSON.parse(baseRaw);
    } catch {
      return NextResponse.json(
        { error: "base must be valid JSON" },
        { status: 400 },
      );
    }
  }

  const hasPhoto = file instanceof File || file2 instanceof File;
  if (!hasPhoto && !text && !base) {
    return NextResponse.json(
      { error: "need one of: photo, text, base" },
      { status: 400 },
    );
  }

  try {
    // Decode any uploaded files into base64 image blocks for the shared core.
    const images: AnalyzeImage[] = await Promise.all(
      [file as File, file2]
        .filter((f): f is File => f instanceof File)
        .map(async (f) => {
          const buf = Buffer.from(await f.arrayBuffer());
          const mediaType = (f.type || "image/jpeg") as AnalyzeImage["mediaType"];
          return { mediaType, base64: buf.toString("base64") };
        }),
    );

    const result = await analyzeMeal({
      images: hasPhoto ? images : undefined,
      hint,
      text,
      base,
      lang,
    });

    if (result.parseError || !result.analysis) {
      throw new Error(result.parseError || "analyze_failed");
    }

    // Preserve the original response shape exactly.
    return NextResponse.json({ analysis: result.analysis, mode: result.mode });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "analyze_failed" },
      { status: 500 },
    );
  }
}
