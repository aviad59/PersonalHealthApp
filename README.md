# Personal Health App

A mobile-first, AI-powered personal health dashboard for nutrition, training, and recovery. It aims to remove the friction from logging meals (photo → macros via Claude Vision), give a single place to see how nutrition and training interact day-to-day, and surface AI-generated coaching (daily/weekly insights, a free-form chat coach, and meal-level sanity checks) that's grounded in the user's real logged data rather than generic advice.

This doc is written for product planning: what exists today, what data backs it, and where the real gaps are — not a step-by-step dev setup guide (see [Development](#development) for that).

## Recent updates

- **Batch meal logging** — select many photos at once and each becomes its own meal: per-photo notes, all analyses run in parallel, per-meal clarifying questions, editable macros, one "Save all". Built for the real usage pattern of photographing meals during the day and uploading them in one evening session.
- **Morning insight push** — a Vercel cron generates each user's daily insight at ~8 AM Israel time and delivers the headline as a Web Push notification (opt-in from Profile, with test buttons).
- **Deterministic post-save summary** — saving a meal now shows a computed "left today" chip (protein/calories remaining vs targets) instead of an LLM-written tip that could get the math wrong.
- **Google sign-in** — real Google OAuth (NextAuth); every route gated behind a verified session, emails mapped per user slot in `lib/user.ts`.
- **Two-photo meal logging** — a second angle/side photo per meal, both sent to Claude Vision together.
- **Meal photos in Vercel Blob** — full-size photos moved out of the DB rows into private Blob storage (thumbnails stay inline); `npm run backfill:photos` migrates pre-existing inline photos.
- **Data export** — meals and weight log downloadable as CSV from Profile.

## Stack

- Next.js 14 (App Router) + TypeScript
- Tailwind CSS, dark mode
- Turso/libSQL (`@libsql/client`) — not local SQLite; works against a remote or local-file DB
- Anthropic SDK, two model tiers in active use (`lib/anthropic.ts`):
  - `CLAUDE_MODEL` (Sonnet 4.6) — meal vision/text analysis, clarifying-question follow-up, daily/weekly insights, AI Coach chat, CSV AI-fill
  - `CLAUDE_OPUS_MODEL` (Opus 4.8) — meal review ("Coach Check")
- Web Push (`web-push` + VAPID) for the morning-insight notification, scheduled by a Vercel cron (`vercel.json`)
- Direct Hevy REST API client (read-only workout sync)

## Product surface (by screen)

All screens require Google sign-in — see [Multi-user model](#multi-user-model).

### `/` — Home
Today's macro totals vs. goals (with an overage ring for calories/fat), today's meals (thumbnail list), latest insight headline, and (if the user tracks workouts) a this-week workout counter vs. weekly target with behind/on/ahead pace, training burn, and a recovery readiness score with a tap-to-expand signal breakdown.

### `/meals/log` — Meal Logger
The core daily-use screen.
- **Photo logging**: take/upload a photo → Claude Vision returns description, itemized breakdown, macros, and a confidence level. A second photo can be added (e.g. the other side of a plate or package) for a more accurate read — both are sent to Claude together.
- **Batch logging**: select many photos at once, each becomes its own meal — per-photo notes, parallel analysis, per-meal clarifying questions, editable macros, one "Save all". Designed for uploading a whole day's photos in one session.
- **Clarifying question**: rarely, when one specific detail would meaningfully change the macros (e.g. "ground beef or steak cut?"), the analysis includes a follow-up question. Answering it re-runs the analysis with that context folded in; the user can also skip it. Works per-meal in batch mode too.
- **Text-only logging**: describe a meal in words, no photo required.
- **Quick-add carousel**: protein-powder shortcut plus the user's most frequent meals as one-tap re-log chips.
- **Frequent meals**: one-tap re-log of meals eaten 2+ times in the last 60 days, with an optional modifier ("same but double the rice").
- **Manual entry**: type in macros directly.
- **AI meal review ("Coach Check")**: re-checks all of a day's logged meals against their descriptions/photos and flags macro estimates that look off, with suggested corrections the user can accept or question.
- Edit, delete, or move any meal to a different date. Saves show a computed "left today" protein/calorie chip.

### `/insights` — Insights Feed
Feed of past daily/weekly AI insights (headline + body + tags), generated on demand:
- **Daily** (~5–10s): today's meals/workouts plus a 7-day rolling lookback.
- **Weekly** (~10–30s): the current calendar week (Sunday–Saturday) of meals and training, summarized.

### `/workouts` — Hevy Sync
Cached view of Hevy workouts: 7-day session count, total volume, total minutes, average RPE, per-muscle-group breakdown, and recent sessions with top-set detail. Manual refresh, plus a slower full-history backfill. Read-only — no in-app workout logging.

### `/stats` — Nutrition Analytics
7/14/30-day nutrition view: daily macro bar chart with a 7-day rolling average and target lines, average/target summary, highlights (protein hit-rate, best/highest days), and a full daily breakdown table.

### `/coach` — AI Coach Chat
Free-form chat with full context (profile, today's meals, this week's day-by-day breakdown, recent weight, recent workouts) and tools to pull deeper history on demand (meal history, workout history, weight history, a specific day's meals). Conversation persists per user; can be cleared.

### `/profile` — Settings & Profile
Body metrics and computed goals (age, sex, height/weight/neck/waist/hips, activity level, goal mode, weekly workout target), a "recalculate goals" preview, language toggle (English/Hebrew), text-size preference, weight log management, and CSV meal backfill/import with per-date conflict resolution and optional Claude-assisted gap-filling.

### `/health` — Wearable (Zepp) Scaffold
Placeholder only — "coming soon." No data is collected here yet.

### `/onboarding` — Setup Wizard
5-step first-run flow (basics → body metrics → activity level → goal mode → review) that computes and saves initial goals.

### `/signin` — Sign In
Google sign-in only. Rejects any Google account not mapped to a user slot in `lib/user.ts`.

### `/widget` — Macro Widget
Minimal endpoint/page for a homescreen/PWA macro-summary widget.

## AI features — what each one sees and does

| Feature | Model | Given | Produces |
|---|---|---|---|
| Meal photo/text analysis | Sonnet | Photo(s) and/or text description, optional hint | Description, itemized macros, confidence, rare clarifying question |
| Clarifying-question follow-up | Sonnet | Original input + user's answer | Re-analyzed macros |
| Meal review ("Coach Check") | Opus | A day's meals + photos + current macros | Per-meal corrected macros (if needed) + explanation |
| Daily insight (on-demand + morning cron) | Sonnet | Profile, goals, today + rolling 7-day history, today's workouts | Headline + short body + tags (headline also pushed as the morning notification) |
| Weekly insight | Sonnet | Profile, goals, current calendar week's meals/workouts | Headline + short body + tags |
| AI Coach chat | Sonnet | Profile, precomputed day/week aggregates (the model is forbidden from doing its own arithmetic), today's meals, recent weight/workouts, chat thread, on-demand history tools | Free-form coaching reply |
| CSV backfill AI-fill | Sonnet | Imported rows with partial/missing macros | Estimated missing macros + confidence |

All meal/insight/coach prompts are bilingual (English/Hebrew) and apply standing dietary rules (kosher: no pork/shellfish, no dairy+meat together).

## Computed / derived features

- **Goal calculation** (`lib/calc.ts`): Navy-formula body fat %, Mifflin-St Jeor BMR, TDEE via activity multiplier, and goal-mode-specific (recomp/cut/bulk/maintain) calorie deltas and protein/fat targets.
- **Weight trend analysis** (`lib/calc.ts`): 7-day/28-day moving averages, regression slope vs. goal-mode-expected slope, and a suggested calorie adjustment when trend drifts off-target.
- **Recovery readiness score** (`lib/recovery.ts`): 0–100 score (low/moderate/good/high) from protein/calorie adherence, back-to-back training days, and recent RPE; per-muscle-group "days since last hit" status. Shown on Home for users who track workouts.
- **Nutrition stats aggregation** (`/api/stats`): rolling averages, target percentages, and day-highlight detection for the Stats page.
- **Frequent meals**: meals logged 2+ times in the last 60 days, cached per user for one-tap re-logging.

## Data model

Stored in Turso/libSQL. Two generations of tables coexist — newer features use per-user tables; some legacy tables were retrofitted with `user_id` rather than migrated.

**Per-user (current)**
- `user_profile` — one row per user: body metrics, computed goals, language
- `user_weight_log` — weight entries per user/date, optional note
- `user_coach_messages` — full coach chat thread per user
- `user_frequent_meals_cache` — cached frequent-meal list per user
- `push_subscriptions` — Web Push endpoints per user/device for the morning notification

**Legacy / shared (still in active use)**
- `meals` — every logged meal: date, description, macros, items, photo (Blob pathname) + thumbnail (base64), confidence, `user_id` (an unused legacy `ai_tip` column remains)
- `insights` — generated daily/weekly insights: type, for_date, headline, body, tags, `user_id`
- `workouts_cache` — cached Hevy workouts (raw JSON + extracted fields), scoped by `user_id`
- `profile`, `weight_log` — original single-row/shared versions, superseded by the per-user tables above
- `suggestions`, `user_suggestions` — tables for the removed next-meal-suggestion feature; kept in place but no longer read or written
- `zepp_cache` — schema exists, never populated

Full-size photos are stored in Vercel Blob (private — only readable through this app's own ownership-checked routes); the `meals` row keeps a short pathname instead of the image bytes. Thumbnails (~5-10KB) stay inline as base64, since they're shown for every meal in a list and aren't worth a separate round trip. Older rows created before this migration may still have the full photo as an inline base64 data URI — the photo route transparently handles both.

## External integrations

**Hevy** (workouts) — live integration. Pulls from the public Hevy REST API (`api.hevyapp.com/v1`, requires a Hevy PRO key) with local caching (refreshed if >10 min stale) and an optional full-history backfill. Read-only: no workout can be logged from this app.

**Zepp** (wearable: sleep, HR, steps) — not implemented. The page, env var, and a DB table exist, but there is no fetch logic. This is the most visible "coming soon" gap and would feed directly into the recovery score and insights if built.

## Multi-user model

Three user slots are hardcoded in `lib/user.ts`: **idan** (tracks workouts), **orly** and **eran** (nutrition-only). Identity is real Google sign-in (NextAuth + Google OAuth, `lib/auth.ts`) — a slot is only usable once its Google account email is set in `lib/user.ts`; sign-in attempts from any other email are rejected before a session is ever issued. `idan` is connected to `idanaviad10@gmail.com`; `orly`/`eran` have no email yet and can't sign in until one is added. Every DB query is scoped with `WHERE user_id = ?` (including `workouts_cache`), and `middleware.ts` requires a verified session for every route except the sign-in page itself.

## Known gaps / stubs

- **Zepp / wearable data** — not built (see above).
- **No workout logging** — Hevy is read-only from this app's perspective.
- **Only one background job** — the morning-insight cron. Workout sync and the frequent-meals cache are still refreshed by user action.
- **Meal timestamps are upload times** — the user batch-uploads photos, so `created_at` reflects when the meal was logged, not eaten. Meal *dates* are correct; time-of-day analysis is off the table (the coach is explicitly told not to reason about it).
- **No workout export** — meals and weight export as CSV; workout history lives in Hevy.
- **Two users have a narrower product** — orly/eran see no workouts, recovery score, or training-aware insight angles, by design (`hasWorkouts: false`).
- **Languages**: English and Hebrew only, but both are fully production-ready across UI and AI prompts (including RTL and Hebrew-specific nutrition framing).

## Development

```bash
npm install
cp .env.local.example .env.local   # set ANTHROPIC_API_KEY, HEVY_API_KEY, TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN if remote), and the Google/NextAuth vars below
npm run dev
# → http://localhost:3000
```

First visit redirects to `/signin`. Sign in with a Google account mapped in `lib/user.ts`; first sign-in for a slot with no profile yet routes to `/onboarding`.

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | All Claude-powered features |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | yes | Google OAuth sign-in (NextAuth) |
| `NEXTAUTH_SECRET` | yes | Signs/encrypts session tokens — generate with `openssl rand -base64 32` |
| `NEXTAUTH_URL` | yes in prod | Canonical URL of the deployed app |
| `TURSO_DATABASE_URL` | yes | Database connection (can be a local `file:` path or a remote Turso URL) |
| `TURSO_AUTH_TOKEN` | only if remote | Turso auth |
| `BLOB_READ_WRITE_TOKEN` | yes | Vercel Blob — stores meal photos (private, served only through this app's own auth-checked routes) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | for push | Web Push signing — generate with `npx web-push generate-vapid-keys` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | for push | Same value as `VAPID_PUBLIC_KEY`, exposed to the browser for subscribing |
| `CRON_SECRET` | recommended | Authorizes manual calls to `/api/cron/daily-insight` (Vercel's own cron header also works) |
| `HEVY_API_KEY` (/ `HEVY_API_KEY_ERAN`) | no | Per-user Hevy workout sync; features degrade gracefully without it |
| `ZEPP_API_KEY` | no | Checked but not yet wired to anything |
