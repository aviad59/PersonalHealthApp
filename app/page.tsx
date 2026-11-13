// Server entry for the home page.
//
// Deliberately a static shell: no session lookup, no DB reads. The page
// used to be force-dynamic and resolve the session, user config and profile
// before returning any HTML, so every cold open and every tap on the Today
// tab waited on a serverless function. Now it's prerendered at build time
// and served straight from the CDN (the middleware still enforces sign-in).
// HomeClient paints from its localStorage snapshot, reads the user's name
// and workouts flag from the session, and sends users without a profile to
// onboarding once /api/today answers.

import HomeClient from "./HomeClient";

export default function HomePage() {
  return <HomeClient />;
}
