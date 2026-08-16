import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId, isCurrentUserAdmin } from "@/lib/user-server";
import {
  createAnalyzerFixtures,
  existingAnalyzerSourceUrls,
  type NewAnalyzerFixture,
} from "@/lib/db";
import {
  loadDishIds,
  loadDishTruth,
  dishImageUrl,
  dishLabel,
} from "@/lib/nutrition5k";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SOURCE = "nutrition5k";
const MAX_IMPORT = 100;

/**
 * Import test dishes from Nutrition5k as fixtures with real ground-truth
 * macros. Images are referenced by their public bucket URL rather than copied
 * into the DB, so an import is just a few small metadata fetches.
 */
export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId || !(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const count = Math.max(1, Math.min(MAX_IMPORT, Number(body?.count) || 20));
  const split: "test" | "train" = body?.split === "train" ? "train" : "test";
  // The dataset includes a few degenerate plates (0 kcal garnish, one outlier
  // near 9,500 kcal). Percent error on a ~15 kcal dish is meaningless — being
  // off by a spoonful reads as a 60% miss — so skip the extremes rather than
  // let them distort the score.
  const minCalories = Number.isFinite(body?.minCalories)
    ? Number(body.minCalories)
    : 50;
  const maxCalories = 2000;

  try {
    const [ids, truth, already] = await Promise.all([
      loadDishIds(split),
      loadDishTruth(),
      existingAnalyzerSourceUrls(SOURCE),
    ]);

    // Only dishes that have both ground truth and an overhead photo, skipping
    // anything already imported so repeat imports extend the set.
    const candidates = ids.filter((id) => {
      const d = truth.get(id);
      if (!d || already.has(dishImageUrl(id))) return false;
      return (
        d.mass_g > 0 && d.calories >= minCalories && d.calories <= maxCalories
      );
    });
    if (candidates.length === 0) {
      return NextResponse.json(
        { error: "no new dishes available to import", imported: 0 },
        { status: 400 },
      );
    }

    // Deterministic spread across the split rather than the first N in file
    // order, so a small sample isn't biased toward one capture session.
    const stride = Math.max(1, Math.floor(candidates.length / count));
    const picked: string[] = [];
    for (let i = 0; i < candidates.length && picked.length < count; i += stride) {
      picked.push(candidates[i]);
    }

    const rows: NewAnalyzerFixture[] = picked.map((id) => {
      const d = truth.get(id)!;
      return {
        label: dishLabel(d),
        mode: "photo",
        photo_base64: null,
        photo_thumb_base64: null,
        photo_mime: "image/png",
        // The ingredient list stands in for a user's own note about the meal.
        // It is only sent to the model on the "with description" variant, so
        // the photo-only runs stay honest.
        input_text: d.ingredients.length ? d.ingredients.join(", ") : null,
        expected_calories: Math.round(d.calories),
        expected_protein_g: Math.round(d.protein_g),
        expected_fat_g: Math.round(d.fat_g),
        expected_carbs_g: Math.round(d.carbs_g),
        notes: `Nutrition5k ${split} · ${id} · ${Math.round(d.mass_g)}g${
          d.ingredients.length ? ` · ${d.ingredients.join(", ")}` : ""
        }`,
        created_by: userId,
        source: SOURCE,
        source_url: dishImageUrl(id),
      };
    });

    await createAnalyzerFixtures(rows);

    return NextResponse.json({
      imported: rows.length,
      split,
      remaining: candidates.length - rows.length,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "import failed" },
      { status: 500 },
    );
  }
}
