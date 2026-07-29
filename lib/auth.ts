/**
 * Better Auth server instance.
 *
 * CRITICAL, verified against the installed source (not assumed) before writing
 * this file:
 *   - `advanced.database.generateId: "serial"` is required. Confirmed against
 *     @better-auth/core@1.6.25's `db/adapter/factory.mjs` and
 *     `db/adapter/get-id-field.mjs`: without it, the adapter generates its own
 *     string id client-side and tries to insert it into `user.id` /
 *     `session.id` / etc., which are plain MySQL `int AUTO_INCREMENT` columns
 *     in db/schema.ts. With "serial" set, id generation is skipped entirely
 *     and the adapter reads the inserted id back via `LAST_INSERT_ID()`
 *     (@better-auth/drizzle-adapter). See the long comment above `user` in
 *     db/schema.ts for the full trail.
 *   - The drizzle adapter is imported from `better-auth/adapters/drizzle`,
 *     which re-exports `@better-auth/drizzle-adapter` (confirmed by reading
 *     node_modules/better-auth/dist/adapters/drizzle-adapter/index.mjs).
 *
 * Table/field mapping: db/schema.ts's `user`/`session`/`account`/`verification`
 * tables use Better Auth's default JS property names (id, name, email,
 * emailVerified, ...), so the adapter needs the schema object and nothing
 * else — no field-name remapping.
 *
 * No public self-signup: `emailAndPassword.disableSignUp` is true, so the
 * `/sign-up/email` endpoint (reachable through the catch-all route) refuses
 * every request, including ones that would otherwise create an account with
 * the default "staff" role. The only way to create a user is
 * `scripts/create-user.ts`, which bypasses the public endpoint entirely by
 * calling the internal adapter directly (see that file for why that's safe).
 *
 * Inactive users can't sign in: `databaseHooks.session.create.before` loads
 * the target user's `active` flag fresh from the database on every session
 * creation (every sign-in) and refuses to create the session if the user is
 * missing or inactive. This is what the build brief calls out explicitly
 * ("Sign-in must be refused for active = false users") — it is enforced here,
 * at the point Better Auth creates a session, not left to the caller. It is
 * NOT a substitute for the fresh-role-check invariant that lib/authz.ts
 * enforces on every server action/route handler — a session created before a
 * user was deactivated is still a valid Better Auth session, and authz.ts is
 * what catches that on the next request (defence in depth, per CLAUDE.md
 * invariant 7 / spec §11).
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { user as userTable } from "@/db/schema";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "mysql",
    // The whole schema module, not just `user` — the adapter resolves
    // `session`/`account`/`verification` by matching Better Auth's model
    // names against keys on this object (they already match: db/schema.ts's
    // exports are named `user`, `session`, `account`, `verification`, per
    // the comment above `user` there). The extra non-auth tables
    // (product, count, ...) on `schema` are simply ignored by the adapter.
    schema,
  }),
  advanced: {
    database: {
      // Load-bearing — see the file-level comment above. Do not remove or
      // change without re-reading db/schema.ts's comment above `user`.
      generateId: "serial",
    },
  },
  /**
   * Better Auth refuses any state-changing request whose `Origin` header is not
   * a trusted origin, and by default the ONLY trusted origin is `baseURL`
   * (i.e. `BETTER_AUTH_URL`). That default is right, and production keeps it
   * untouched — this block only widens the list outside production.
   *
   * Why it needs widening in development: docker-compose publishes the app on
   * `127.0.0.1:3000` while `BETTER_AUTH_URL` is `http://localhost:3000`. Those
   * are the same server and two different origins as far as a browser is
   * concerned, so signing in from `http://127.0.0.1:3000` got a 403 — which the
   * login form correctly reports with its deliberately generic "check your email
   * and password" message, and which then bounces back to /login. The symptom is
   * indistinguishable from a wrong password, and the password is fine.
   *
   * Worth knowing how this hid: `curl` sends no `Origin` header unless told to,
   * so the sign-in endpoint returns 200 from a terminal and 403 from a browser.
   * A manual verification pass that used curl missed it entirely. Any future
   * check of this path must send `Origin`, or it is not testing what a browser
   * does.
   *
   * `DEV_LAN_ORIGIN` widens it once more, for the same reason and with the
   * same failure mode: counting on a real phone means loading the app from
   * http://192.168.x.x:3000, which is a third origin for the same server.
   * Without it, sign-in from the phone returns 403 and the login form says
   * "check your email and password" — so you retype a correct password on a
   * small keyboard in a dim bar and conclude the phone is broken. It is set
   * only by scripts/dev-lan.sh and is unreachable in production, both because
   * this whole block is skipped there and because nothing sets the variable.
   *
   * It is comma-separated because the phone has TWO origins, not one: plain
   * http on :3000, and https on :3443 through the TLS proxy that the camera
   * requires. Different scheme and different port both make a different
   * origin, so trusting one says nothing about the other.
   */
  ...(process.env.NODE_ENV === "production"
    ? {}
    : {
        trustedOrigins: [
          "http://localhost:3000",
          "http://127.0.0.1:3000",
          ...(process.env.DEV_LAN_ORIGIN ?? "")
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean),
        ],
      }),
  emailAndPassword: {
    enabled: true,
    // No public self-signup path (build brief, invariant: "no public
    // self-signup path that grants a role"). The only account creation path
    // is scripts/create-user.ts, which does not go through this endpoint.
    disableSignUp: true,
    minPasswordLength: 12,
  },
  /**
   * Session lifetime — set explicitly rather than accepting Better Auth's
   * default (7 days, sliding). Chosen for the actual device this app runs
   * on: a shared Android phone kept behind the bar, handed between
   * bartenders across shifts, that can be left unattended on a bar floor.
   * A 7-day sliding session on that device means a phone left open (or
   * lost, or picked up by the wrong person) stays a valid, signed-in
   * session for up to a week, refreshing indefinitely with any use.
   *
   * `expiresIn: 12h` + `disableSessionRefresh: true` together make this an
   * ABSOLUTE expiry, not a sliding one: the session dies 12 hours after
   * sign-in no matter how continuously it's used, which comfortably covers
   * one shift (including a double) without carrying a session over into the
   * next day unattended. `disableSessionRefresh` is what makes this
   * absolute — without it, Better Auth's default `updateAge` behavior would
   * push `expiresIn` forward on every active use, which is exactly the
   * "never really expires" property this is meant to avoid.
   *
   * Frontend note: Better Auth's email/password sign-in has a `rememberMe`
   * flag; passing `rememberMe: false` does NOT shorten this further — it
   * hardcodes a *different*, longer-than-nothing 1-day session
   * (node_modules/better-auth/dist/db/internal-adapter.mjs), which would
   * undermine the 12h policy here. Don't expose a "remember me" toggle on
   * this app's login form; let every sign-in use this default.
   */
  session: {
    expiresIn: 60 * 60 * 12, // 12 hours
    disableSessionRefresh: true,
  },
  user: {
    additionalFields: {
      // Truestock's own fields on top of Better Auth's core `user` schema
      // (db/schema.ts). `input: false` means these can never be set by a
      // caller through a public Better Auth endpoint (sign-up is disabled
      // anyway, but this is defence in depth against, e.g., a future profile
      // update endpoint being enabled) — they can only be set by
      // scripts/create-user.ts (which writes through the internal adapter,
      // bypassing endpoint-level input filtering) or a direct DB write from
      // trusted server code.
      role: {
        type: "string",
        required: true,
        input: false,
        defaultValue: "staff",
      },
      active: {
        type: "boolean",
        required: true,
        input: false,
        defaultValue: true,
      },
      // The tenant. `input: false` matters more here than anywhere else in
      // this block: a caller who could set their own `organizationId` through
      // any Better Auth endpoint would be choosing which tenant's data they
      // can read, which is the whole boundary. Deliberately has NO
      // defaultValue — unlike role/active there is no safe fallback tenant,
      // and a default would let an account be created that points at
      // somebody's data by accident. `scripts/create-user.ts` resolves and
      // passes it explicitly through the internal adapter.
      organizationId: {
        type: "number",
        required: true,
        input: false,
      },
    },
  },
  databaseHooks: {
    session: {
      create: {
        // Refuse to create a session (i.e., refuse sign-in) for an inactive
        // user. Runs on every session creation, so it covers every sign-in
        // method, not just email/password. Returning `false` here makes
        // Better Auth's internal `createSession` return null, which
        // sign-in.mjs turns into a generic 401 FAILED_TO_CREATE_SESSION —
        // deliberately generic so it doesn't confirm to a caller whether the
        // account exists vs. is disabled.
        before: async (session) => {
          const rows = await db
            .select({ active: userTable.active })
            .from(userTable)
            .where(eq(userTable.id, Number(session.userId)))
            .limit(1);
          const row = rows[0];
          if (!row || !row.active) {
            return false;
          }
          return true;
        },
      },
    },
  },
  plugins: [
    // Lets server actions that call auth.api.* methods directly (e.g. a
    // future sign-out action) have Set-Cookie headers applied automatically
    // in the Next.js App Router response. Recommended last in the plugin
    // list per Better Auth's own Next.js integration docs.
    nextCookies(),
  ],
});
