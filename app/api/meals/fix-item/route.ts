import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fixMealItem } from "@/lib/analyze";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ItemSchema = z.object({
  name: z.string(),
  portion: z.string().default(""),
  calories: z.number(),
  protein_g: z.number(),
  fat_g: z.number(),
  carbs_g: z.number(),
});

const FixSchema = z.object({
  items: z.array(ItemSchema).min(1).max(40),
  index: z.number().int().min(0),
  prompt: z.string().trim().min(1).max(500),
  description: z.string().optional(),
});

/** Re-cost one item of an analyzed meal from the user's correction. Stateless:
 *  the caller merges the replacement into whatever it holds (an unsaved
 *  analysis, a batch card, an inbox draft or a saved meal). */
export async function POST(req: NextRequest) {
  const lang = req.cookies.get("lang")?.value || "en";
  const parsed = FixSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success || parsed.data.index >= parsed.data.items.length) {
    return NextResponse.json(
      { error: "validation", issues: parsed.success ? [] : parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const result = await fixMealItem({ ...parsed.data, lang });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "fix_failed" }, { status: 500 });
  }
}
