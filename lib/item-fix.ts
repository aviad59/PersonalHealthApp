// Client side of the per-item correction: ask the server to re-cost one
// item, then splice the answer into the meal locally.

import { safeFetchJson } from "@/lib/fetch-json";
import { replaceItem, applyPortions, type Macros, type PortionItem } from "@/lib/portions";

export type FixableMeal = { description: string; items: PortionItem[]; total: Macros };

export async function requestItemFix(
  meal: Pick<FixableMeal, "description" | "items">,
  index: number,
  prompt: string,
): Promise<{ items: PortionItem[]; description: string }> {
  return safeFetchJson("/api/meals/fix-item", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: meal.items.map(({ name, portion, calories, protein_g, fat_g, carbs_g }) => ({
        name,
        portion: portion ?? "",
        calories,
        protein_g,
        fat_g,
        carbs_g,
      })),
      index,
      prompt,
      description: meal.description,
    }),
  });
}

/** The meal with the fix applied, plus the fractions and editable totals that
 *  go with it. Pure, so callers can run it inside a state updater against the
 *  latest state rather than the one the request started from. */
export function applyItemFix<M extends FixableMeal>(
  meal: M,
  fractions: number[],
  index: number,
  fix: { items: PortionItem[]; description: string },
): { meal: M; fractions: number[]; editing: Macros } {
  const r = replaceItem(meal.items, meal.total, fractions, index, fix.items);
  return {
    meal: { ...meal, description: fix.description || meal.description, items: r.items, total: r.total },
    fractions: r.fractions,
    editing: applyPortions(r.total, r.items, r.fractions),
  };
}
