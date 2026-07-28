/**
 * Better Auth's catch-all route handler. Every Better Auth endpoint
 * (/api/auth/sign-in/email, /api/auth/get-session, /api/auth/sign-out, ...)
 * is served through here — this file has no business logic of its own.
 *
 * Note that /api/auth/sign-up/email is reachable through this same catch-all,
 * but `emailAndPassword.disableSignUp: true` in lib/auth.ts makes it refuse
 * every request. There is deliberately no separate carve-out here.
 */
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const { GET, POST } = toNextJsHandler(auth);
