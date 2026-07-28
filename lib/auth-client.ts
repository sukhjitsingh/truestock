"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Better Auth browser client. Same-origin, so no `baseURL` is needed — the
 * client defaults to the current origin's /api/auth, which is exactly where
 * app/api/auth/[...all]/route.ts serves from.
 *
 * Deliberately NOT exported: anything resembling a role. The client never
 * decides authorization. Role comes from the session on the server and is
 * re-read from the database on every server action (lib/authz.ts), and the
 * design system's binding rule is that column sets and whole sections are
 * built per role server-side rather than hidden client-side. A `useRole()`
 * hook here would be the first step toward exactly the client-side role state
 * that rule forbids.
 */
export const authClient = createAuthClient();

export const { signIn, signOut, useSession } = authClient;
