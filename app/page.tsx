// Server Component wrapper for the home page.
//
// Why: Previously the home page was "use client" with a useEffect that
// hit /api/today after hydration, so first paint was a skeleton waiting
// on an HTTP round-trip + serverless cold start. By doing the same DB
// queries here on the server, we ship the critical macro/meal data
// inline with the HTML — the client component hydrates already populated
// and skips the /api/today fetch entirely.
//
// The slower /api/today/training and /api/suggestion calls still happen
// from the client so they don't block the first paint.

import {
  getProfile,
  getMealsByDateLite,
  getLatestInsight,
  getSuggestion,
  todayStr,
} from "@/lib/db";
import HomeClient, { Today, Suggestion } from "./HomeClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeParseTags(s: string | null): string[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function loadInitial(): Promise<{
  today: Today;
  suggestion: Suggestion | null;
}> {
  const today = todayStr();
  // Four small DB reads in parallel — none of them call Claude or any
  // external API, so they all return inside ~50–150 ms even on a cold start.
  const [profile, meals, latestInsight, cachedSuggestion] = await Promise.all([
    getProfile(),
    getMealsByDateLite(today),
    getLatestInsight(),
    getSuggestion(today),
  ]);

  const totals = meals.reduce(
    (acc, m) => {
      acc.calories += m.calories ?? 0;
      acc.protein_g += m.protein_g ?? 0;
      acc.fat_g += m.fat_g ?? 0;
      acc.carbs_g += m.carbs_g ?? 0;
      return acc;
    },
    { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
  );

  const baseCalTarget = profile?.goal_calories ?? 0;

  const todayPayload: Today = {
    date: today,
    profile,
    totals,
    targets: {
      base_calories: baseCalTarget,
      // Training burn is filled in client-side by /api/today/training.
      training_burn_kcal: 0,
      effective_calories: baseCalTarget,
      protein_g: profile?.goal_protein_g ?? 0,
      fat_g: profile?.goal_fat_g ?? 0,
      carbs_g: profile?.goal_carbs_g ?? 0,
    },
    meals: meals.map((m) => ({
      id: m.id,
      description: m.description,
      calories: m.calories,
      protein_g: m.protein_g,
      fat_g: m.fat_g,
      carbs_g: m.carbs_g,
      // Photo bytes served lazily via /api/meals/:id/photo with year-long
      // browser cache, so this payload stays small.
      photo_path: m.has_photo ? `/api/meals/${m.id}/photo` : null,
      ai_tip: m.ai_tip,
      created_at: m.created_at,
    })),
    latestInsight: latestInsight
      ? {
          id: latestInsight.id,
          type: latestInsight.type,
          headline: latestInsight.headline,
          body: latestInsight.body,
          created_at: latestInsight.created_at,
          tags: safeParseTags(latestInsight.tags_json),
        }
      : null,
  };

  const suggestion: Suggestion | null = cachedSuggestion
    ? {
        body: cachedSuggestion.body,
        meals_count: cachedSuggestion.meals_count,
        totals_calories: cachedSuggestion.totals_calories,
        totals_protein_g: cachedSuggestion.totals_protein_g,
        updated_at: cachedSuggestion.updated_at,
        cached: true,
      }
    : null;

  return { today: todayPayload, suggestion };
}

export default async function HomePage() {
  const { today, suggestion } = await loadInitial();
  return <HomeClient initial={today} initialSuggestion={suggestion} />;
}
