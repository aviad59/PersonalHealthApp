// NextAuth configuration — server-only. Google is the sole identity
// provider; access is restricted to the email addresses configured in
// lib/user.ts (USERS[*].email). Anyone signing in with an unrecognized
// Google account is denied at sign-in time, before any session/cookie
// is ever issued for them.

import type { AuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { getUserIdByEmail, type UserId } from "./user";

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
    // Hard gate: only emails mapped in lib/user.ts may sign in at all.
    async signIn({ user }) {
      return getUserIdByEmail(user.email) !== null;
    },
    async jwt({ token }) {
      // Re-derive on every request rather than trusting a value cached at
      // sign-in time, so revoking/changing an email mapping takes effect
      // on the user's next request instead of only after they re-login.
      token.appUserId = getUserIdByEmail(token.email as string | undefined);
      return token;
    },
    async session({ session, token }) {
      (session as any).appUserId = token.appUserId as UserId | null;
      return session;
    },
  },
};
