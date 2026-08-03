// NextAuth configuration — server-only. Google is the sole identity
// provider; access is restricted to the email addresses configured in
// lib/user.ts (USERS[*].email). Anyone signing in with an unrecognized
// Google account is denied at sign-in time, before any session/cookie
// is ever issued for them.

import type { AuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { authorizeSignIn, getActiveUserByEmail, type UserId } from "./user";

export const authOptions: AuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/signin",
    error: "/signin",
  },
  callbacks: {
    // Hard gate: only APPROVED (active) users in the roster may sign in.
    // Unknown Google accounts are recorded as 'pending' here so an admin can
    // approve them later, but are denied access until then.
    async signIn({ user }) {
      return authorizeSignIn({ email: user.email, name: user.name });
    },
    async jwt({ token }) {
      // Re-derive on every request rather than trusting a value cached at
      // sign-in time, so approving/revoking a user takes effect on their next
      // request instead of only after they re-login.
      const u = await getActiveUserByEmail(token.email as string | undefined);
      token.appUserId = u?.id ?? null;
      token.isAdmin = u?.isAdmin ?? false;
      return token;
    },
    async session({ session, token }) {
      (session as any).appUserId = token.appUserId as UserId | null;
      (session as any).isAdmin = (token.isAdmin as boolean) ?? false;
      return session;
    },
  },
};
