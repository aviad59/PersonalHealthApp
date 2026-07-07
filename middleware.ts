// Central auth gate. Every route is protected by default — only the
// NextAuth machinery, the sign-in page, and static/PWA assets are
// excluded via the matcher below. This is the single enforcement point:
// route handlers and pages no longer need their own per-request auth
// checks, and a client can no longer "become" a user just by setting a
// cookie (the old cowork_user picker model).
import { withAuth } from "next-auth/middleware";

export default withAuth({
  pages: { signIn: "/signin" },
  callbacks: {
    // Require not just a valid signed session, but one that resolved to
    // a known app user (see lib/auth.ts jwt callback) — belt-and-suspenders
    // against a token that's validly signed but maps to no one (e.g. an
    // email mapping removed after the token was issued).
    authorized: ({ token }) => !!token?.appUserId,
  },
});

export const config = {
  matcher: [
    // api/cron is excluded because Vercel's scheduler calls it with no
    // session cookie — the middleware would bounce it to /signin before
    // the route ever ran. The cron route enforces its own auth
    // (CRON_SECRET bearer / vercel-cron user-agent).
    "/((?!api/auth|api/cron|signin|_next/static|_next/image|favicon.ico|manifest.webmanifest|icons|widget-templates|sw.js).*)",
  ],
};
