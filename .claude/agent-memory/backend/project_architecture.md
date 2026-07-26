---
name: project-architecture
description: How the backend layer (auth, authz, domain, actions) is structured after the first backend build — read before touching lib/ or app/actions/
metadata:
  type: project
---

Backend built 2026-07-24 on top of the (already reviewed) db/schema.ts. Layout:

- `lib/auth.ts` — Better Auth instance. Requires `advanced.database.generateId:
  "serial"` (verified against installed `@better-auth/core@1.6.25` source, not
  assumed — see the file's header comment for the exact trail:
  `db/adapter/factory.mjs`, `db/adapter/get-id-field.mjs`). Drizzle adapter
  import path is `better-auth/adapters/drizzle` (re-exports
  `@better-auth/drizzle-adapter`), and must be given the *whole* schema
  module (`import * as schema`), not just `{ user }` — the adapter resolves
  `session`/`account`/`verification` by matching model names against keys on
  that object.
- No public self-signup: `emailAndPassword.disableSignUp: true`. The only
  account-creation path is `scripts/create-user.ts`, which goes around the
  `/sign-up/email` endpoint entirely via `(await auth.$context).internalAdapter
  .createUser(...)` + `.linkAccount(...)` + `ctx.password.hash(...)` — the
  same primitives the endpoint itself uses internally (confirmed by reading
  `node_modules/better-auth/dist/api/routes/sign-up.mjs`). This bypass is
  necessary because `disableSignUp` blocks the endpoint even for
  server-side `auth.api.signUpEmail` calls, and because `internalAdapter
  .createUser` (unlike the endpoint) doesn't filter out `role`/`active` via
  `additionalFields.input: false`.
- Inactive-user sign-in block: `databaseHooks.session.create.before` in
  `lib/auth.ts` re-loads `user.active` from the DB on every session creation
  and returns `false` if inactive — Better Auth turns that into a generic 401
  (`FAILED_TO_CREATE_SESSION`), confirmed by reading `sign-in.mjs`. This is
  belt; `lib/authz.ts`'s per-request fresh role/active reload is the
  suspenders (a session created before deactivation is still valid until the
  next request hits authz).
- `lib/authz.ts` — the single role-rules module. `requireSession()` /
  `requireRole(...)` always re-read role+active from the DB, never trust the
  session's role claim. `canSeeCost(role)` / `canManageCost(role)` (owner
  only) gate cost visibility everywhere.
- `lib/domain/*.ts` — pure business logic (catalog, counts, reports,
  valuation, errors). `app/actions/*.ts` ("use server") are thin: authorize,
  Zod-validate, call domain fn. `lib/validation/*.ts` holds the shared Zod
  schemas.
- Cost gating pattern used throughout: query functions take the caller's
  `Role` and select fewer columns entirely for non-owner callers (not just
  omit the field from the response afterward) — see `selectProducts` in
  `lib/domain/catalog.ts` and `toCountLineRow` in `lib/domain/counts.ts`.
- `lib/domain/db-errors.ts` — `isDuplicateKeyError(err)` (mysql2 code
  `ER_DUP_ENTRY`/1062), the single shared discriminator used everywhere a
  unique-constraint collision needs to be told apart from a real failure
  (catalog's `ConflictError` handling, counts' ledger-replay handling).
- Session lifetime is explicit in `lib/auth.ts`: 12h absolute expiry
  (`expiresIn` + `disableSessionRefresh: true`, no sliding renewal) — reasoned
  from the shared-Android-phone-on-a-bar-floor threat model, not the library
  default (7 days, sliding). Note for later: Better Auth's `rememberMe: false`
  on sign-in does NOT shorten this further, it hardcodes a *different* 1-day
  session — don't expose a "remember me" toggle on this app's login form.

See [[counts-increment-idempotency]] for the write-idempotency design
(now a `count_line_write` ledger table, not a column on `count_line` — this
was revised once already after review found a flaw, see that memory for the
full history), and [[valuation-nulls]] for how invariant 2's nullable
cost/case-size snapshot is handled in the math.

No MySQL server exists in this dev environment — nothing here has been run
against a live database, only `tsc`/`eslint`/`next build`. See the session's
final report (in conversation history) for the full list of what remains
unverified.
