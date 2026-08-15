// Nutrition5k — Google Research's public dataset of ~5,000 real plated dishes
// with scale-measured ground truth (calories, mass, fat, carbs, protein).
// https://github.com/google-research-datasets/Nutrition5k  (CC BY 4.0)
//
// We use it to score the meal analyzer against known-correct macros. Only the
// small metadata/id files are fetched — dish images stay in the public bucket
// and are referenced by URL, so importing a test set costs almost no storage.

const BASE =
  "https://storage.googleapis.com/nutrition5k_dataset/nutrition5k_dataset";

/** Overhead RGB photo for a dish — the view closest to how a user shoots a meal. */
export function dishImageUrl(dishId: string): string {
  return `${BASE}/imagery/realsense_overhead/${dishId}/rgb.png`;
}

export type DishTruth = {
  dish_id: string;
  calories: number;
  mass_g: number;
  fat_g: number;
  carbs_g: number;
  protein_g: number;
  /** Ingredient names, used to label the fixture readably. */
  ingredients: string[];
};

/**
 * Dish metadata rows are:
 *   dish_id, calories, mass, fat, carb, protein, [ingr_id, name, grams, cal, fat, carb, protein]*
 * There is no header row. The six leading fields are always id/numbers, so a
 * plain comma split is safe for them regardless of commas inside later
 * ingredient names.
 */
function parseDishCsv(text: string, into: Map<string, DishTruth>): void {
  for (const line of text.split("\n")) {
    if (!line.startsWith("dish_")) continue;
    const f = line.split(",");
    if (f.length < 6) continue;
    const [dish_id, cal, mass, fat, carb, protein] = f;
    const nums = [cal, mass, fat, carb, protein].map(Number);
    if (nums.some((n) => !Number.isFinite(n))) continue;

    // Ingredient names sit at offset 7 of each repeating 7-field group.
    const ingredients: string[] = [];
    for (let i = 6; i + 1 < f.length; i += 7) {
      const name = f[i + 1]?.trim();
      if (name && !name.startsWith("ingr_")) ingredients.push(name);
    }

    into.set(dish_id, {
      dish_id,
      calories: nums[0],
      mass_g: nums[1],
      fat_g: nums[2],
      carbs_g: nums[3],
      protein_g: nums[4],
      ingredients,
    });
  }
}

async function getText(path: string): Promise<string> {
  const r = await fetch(`${BASE}/${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`nutrition5k: ${path} → ${r.status}`);
  return r.text();
}

// The metadata CSVs total ~4 MB and never change, so parse once per warm
// serverless instance rather than on every import request.
let _truthCache: Map<string, DishTruth> | null = null;

export async function loadDishTruth(): Promise<Map<string, DishTruth>> {
  if (_truthCache) return _truthCache;
  const map = new Map<string, DishTruth>();
  const [cafe1, cafe2] = await Promise.all([
    getText("metadata/dish_metadata_cafe1.csv"),
    getText("metadata/dish_metadata_cafe2.csv"),
  ]);
  parseDishCsv(cafe1, map);
  parseDishCsv(cafe2, map);
  _truthCache = map;
  return map;
}

let _idsCache: Record<string, string[]> = {};

/**
 * Dish ids that have overhead RGB-D imagery. The "test" split is the dataset's
 * official held-out set (507 dishes) — the methodologically correct one to
 * benchmark against, since it was never used to fit anything.
 */
export async function loadDishIds(split: "test" | "train"): Promise<string[]> {
  if (_idsCache[split]) return _idsCache[split];
  const file =
    split === "test"
      ? "dish_ids/splits/depth_test_ids.txt"
      : "dish_ids/splits/depth_train_ids.txt";
  const ids = (await getText(file))
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("dish_"));
  _idsCache[split] = ids;
  return ids;
}

/** Short readable label for a dish, e.g. "rice, chicken, broccoli (301 kcal)". */
export function dishLabel(d: DishTruth): string {
  const names = d.ingredients.slice(0, 3).join(", ");
  const more = d.ingredients.length > 3 ? "…" : "";
  const what = names ? `${names}${more}` : d.dish_id;
  return `${what} (${Math.round(d.calories)} kcal)`;
}

/** Fetch a dish photo and return it as base64 for the vision call. */
export async function fetchDishImageBase64(
  url: string,
): Promise<{ base64: string; mediaType: "image/png" | "image/jpeg" }> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`nutrition5k image ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const mediaType = url.endsWith(".png") ? "image/png" : "image/jpeg";
  return { base64: buf.toString("base64"), mediaType };
}
