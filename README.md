# Health Dashboard

A mobile-first, AI-powered personal health dashboard. Tracks nutrition (via Claude Vision), workouts (via Hevy), and generates daily/weekly insights that cross-reference all signals.

## Stack

- Next.js 14 (App Router) + TypeScript
- Tailwind CSS, dark mode
- SQLite via `better-sqlite3`
- Anthropic SDK (`claude-sonnet-4-20250514`) for vision + insights
- Direct Hevy REST API client (the [`hevy-mcp`](https://github.com/chrisdoc/hevy-mcp) repo is included in `./hevy-mcp` for use with Claude Desktop)

## Quick start

```bash
# 1. Install deps
npm install

# 2. Set up env
cp .env.local.example .env.local
# Fill in ANTHROPIC_API_KEY and HEVY_API_KEY

# 3. Run dev
npm run dev
# → http://localhost:3000
```

On first launch you'll be taken to `/onboarding` to enter body metrics and generate personalized goals.

> **Note on Windows + OneDrive:** If you previously installed `node_modules` on a different OS (e.g. the one used to set up this project), delete `node_modules` and run `npm install` again so native modules like `better-sqlite3` compile for your platform.

## Environment variables

| Variable            | Required | Purpose                                  |
| ------------------- | -------- | ---------------------------------------- |
| `ANTHROPIC_API_KEY` | yes      | Claude vision + insight generation       |
| `HEVY_API_KEY`      | yes*     | Pull workouts from Hevy (PRO required)   |
| `ZEPP_API_KEY`      | no       | Scaffold only — not wired up yet         |

\* The workouts page and insights engine degrade gracefully if `HEVY_API_KEY` is absent.

## Screens

- `/` — Today: macro rings, today's workout, latest insight
- `/meals/log` — Upload meal photo → Claude vision → confirm → save + next-meal tip
- `/insights` — Full feed, filterable; generate daily/weekly insights on demand
- `/workouts` — Hevy data, weekly summary by muscle group
- `/profile` — Edit body metrics + recalculate goals
- `/health` — Zepp placeholder (no API wired yet)

## Architecture notes

### Insights engine

`POST /api/insights/generate` with `{ "type": "daily" | "weekly" }` collects:

- Profile and personalized targets
- Today's meals, totals
- Today's workout(s) from Hevy (if key set)
- Last 7 days of meals and workouts (day-by-day)
- Zepp placeholder (null for now)

...then calls Claude with a strict-JSON prompt and stores the result in `insights`. Each insight is `{ headline, body, tags }` keyed to `created_at`.

The prompts (`lib/prompts.ts`) instruct the model to reference actual numbers and combine at least two signals. When Zepp data is wired in, the context will automatically flow through to the prompt.

### Nutrition (Claude Vision)

`POST /api/meals/analyze` accepts `multipart/form-data` with a `photo` file and an optional `hint`. Returns `{ description, items[], total, confidence, notes }` strict-JSON.

`POST /api/meals` saves a confirmed meal (including optional photo to `public/uploads/`) and in the same request runs a short "next meal tip" pass using the user's daily totals so far.

### Workouts (Hevy)

`lib/hevy.ts` is a thin client for `api.hevyapp.com/v1` with typed workouts + set summarization. `lib/hevy.ts` infers muscle groups by exercise title heuristic (good enough for a weekly rollup).

### hevy-mcp

The [`chrisdoc/hevy-mcp`](https://github.com/chrisdoc/hevy-mcp) repo is cloned into `./hevy-mcp`. The web app itself does **not** call it — it hits the Hevy REST API directly, which is simpler for a server-rendered app. If you want to point **Claude Desktop** at it for a different use case:

```bash
cd hevy-mcp
npm install
npm run build
# then add to claude_desktop_config.json as shown in hevy-mcp/README.md
```

The bundled repo includes a nested `./hevy-mcp/hevy-mcp/` folder (artifact of copying over OneDrive). You can safely delete it on Windows.

## Data

SQLite lives at `./data/health.db`. Tables:

- `profile` (single row, `id = 1`) — body metrics + computed goals
- `meals` — every logged meal with macros and optional photo
- `insights` — AI-generated daily/weekly insights
- `workouts_cache` / `zepp_cache` — reserved for future offline caching

## Formulas

- **Body fat**: U.S. Navy tape formula (`lib/calc.ts`)
- **BMR**: Mifflin-St Jeor
- **TDEE**: BMR × activity multiplier (1.2 → 1.9)
- **Macros**: protein from lean mass (goal-dependent), fat from body-weight approximation, carbs fill remaining kcal

Change goal mode (`recomp | cut | bulk | maintain`) on the Profile page to retune.

## What's next / stubs

- Zepp integration — `lib/zepp.ts` + `app/health/` currently placeholder
- Real cron for nightly insight generation (Vercel Cron or `node-cron`)
- PR detection on Hevy workouts (currently just volume)
- Export / weekly email digest

## Troubleshooting

- **`better-sqlite3` build errors on Windows**: install the [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) or run `npm install --build-from-source`.
- **Hevy returns 401**: Hevy API requires a **PRO** subscription. Key is passed via `api-key:` header.
- **Insights say "Profile not set up"**: visit `/onboarding` first.
