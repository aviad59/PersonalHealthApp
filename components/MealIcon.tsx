"use client";

import React from "react";

// Pickable icons shown in meal lists when a meal has no photo. Ids are
// stored in meals.icon; keep them stable (they're persisted).
export const MEAL_ICON_IDS = [
  "meal",
  "coffee",
  "egg",
  "salad",
  "fish",
  "meat",
  "bread",
  "fruit",
  "shake",
  "water",
  "pizza",
  "snack",
] as const;

export type MealIconId = (typeof MEAL_ICON_IDS)[number];

const ICONS: Record<string, React.ReactNode> = {
  meal: (
    <>
      <path d="M5 3v7a2 2 0 0 0 2 2v9" />
      <path d="M9 3v7" />
      <path d="M7 3v4" />
      <path d="M17 3c-1.6 0-2.5 2-2.5 4.5S15.4 12 17 12v9" />
    </>
  ),
  coffee: (
    <>
      <path d="M4 9h13v5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9Z" />
      <path d="M17 11h2a2 2 0 0 1 0 4h-2" />
      <path d="M7 4v2M11 4v2" />
    </>
  ),
  egg: <path d="M12 3c3.2 0 6 5 6 9a6 6 0 0 1-12 0c0-4 2.8-9 6-9Z" />,
  salad: (
    <>
      <path d="M3.5 11h17a8.5 8.5 0 0 1-17 0Z" />
      <path d="M12 11c0-3 2-5 5-5" />
      <path d="M11 11c0-2.2-1.6-4-4-4" />
      <path d="M12 11c.4-1.4 1.4-2.4 2.8-2.8" />
    </>
  ),
  fish: (
    <>
      <path d="M16 12c0 2.8-3.8 5-8 5-3 0-5-2-5-5s2-5 5-5c4.2 0 8 2.2 8 5Z" />
      <path d="M16 12l5-3.5v7L16 12Z" />
      <circle cx="6.5" cy="10.5" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  meat: (
    <>
      <path d="M13.5 10.5a5 5 0 1 0-7-7 5 5 0 0 0 .3 7.4L4 13.7a2.1 2.1 0 1 0 2 2l2.8-2.8a5 5 0 0 0 4.7-2.4Z" />
    </>
  ),
  bread: (
    <>
      <path d="M5 11a4 4 0 0 1 4-4h6a4 4 0 0 1 0 8v3a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7Z" />
      <path d="M9 7c0-1.2 1-2 2.5-2S14 5.8 14 7" />
    </>
  ),
  fruit: (
    <>
      <path d="M12 8c-1.2-1.8-4-2.4-5.7-.5-1.8 2-1 5.6.7 8.3 1.2 1.9 2.6 3.2 4 3.2s2.8-1.3 4-3.2c1.7-2.7 2.5-6.3.7-8.3C17.9 5.6 15.2 6.2 14 8Z" />
      <path d="M12 8V4.5" />
      <path d="M12 5c.6-1.4 2.2-1.8 3.2-1" />
    </>
  ),
  shake: (
    <>
      <path d="M8 3h8l1 3H7l1-3Z" />
      <path d="M7 6l-1 13.5A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5L17 6H7Z" />
      <path d="M6.6 11h10.8" />
    </>
  ),
  water: <path d="M12 3s6 7.5 6 12a6 6 0 0 1-12 0c0-4.5 6-12 6-12Z" />,
  pizza: (
    <>
      <path d="M12 3 3 20l9-2.5L21 20 12 3Z" />
      <circle cx="10" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="13.5" cy="15" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  snack: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="10" cy="10" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="14" cy="11" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="11" cy="14.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="15" r="0.8" fill="currentColor" stroke="none" />
    </>
  ),
};

export function MealIcon({ id, className }: { id: string | null | undefined; className?: string }) {
  const content = ICONS[id ?? "meal"] ?? ICONS.meal;
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {content}
    </svg>
  );
}
