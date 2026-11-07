/**
 * Typed reads of the environment the e2e suite runs in.
 *
 * Everything is read LAZILY, inside functions, never at module load. The
 * config file calls `loadE2eEnv()` after its imports are evaluated, and an
 * import-time `process.env.X` read in here would run before that and see
 * nothing. (Playwright workers re-import this module, which is also why none of
 * this may carry state.)
 *
 * Variable names only — the values live in an env file outside the repo (see
 * `.env.e2e.example`). Nothing in this suite prints a credential, and nothing
 * here should ever be changed to.
 */
import fs from "node:fs";
import path from "node:path";

export type Role = "owner" | "manager" | "staff";
export const ROLES: readonly Role[] = ["owner", "manager", "staff"];

/** The production build served by the e2e rig (docs: e2e/README.md). */
export const DEFAULT_BASE_URL = "http://localhost:3101";

/**
 * Where each role's signed-in `storageState` is saved by global setup.
 * `__dirname` rather than `process.cwd()`: the suite must work when launched
 * from a subdirectory. (Playwright compiles TS to CommonJS here — this repo's
 * package.json has no `"type": "module"` — so `__dirname` exists.)
 */
export const AUTH_DIR = path.resolve(__dirname, "..", ".auth");

export function authFile(role: Role): string {
  return path.join(AUTH_DIR, `${role}.json`);
}

/**
 * True when global setup produced a real session for this role. This — not "are
 * the credentials in the environment" — is what specs consult, so a role whose
 * sign-in was never attempted and a role that was never configured are the same
 * thing to a spec: unavailable, and loudly skipped.
 *
 * Global setup writes a state file for EVERY role, an empty one for a role it
 * could not sign in. That is deliberate: specs bind `test.use({ storageState })`
 * at file load, and Playwright errors on a missing file before any `beforeEach`
 * could skip the test. An empty-but-valid file lets the skip happen where it
 * can be made loud. "Real session" therefore means "the file holds a cookie".
 */
export function hasAuth(role: Role): boolean {
  try {
    const state = JSON.parse(fs.readFileSync(authFile(role), "utf8")) as { cookies?: unknown[] };
    return Array.isArray(state.cookies) && state.cookies.length > 0;
  } catch {
    return false;
  }
}

/**
 * Loads `E2E_ENV_FILE` into `process.env` when it is set and exists.
 *
 * `node --env-file=...` cannot ride in `NODE_OPTIONS`, so there is no way to
 * hand Playwright's CLI an env file from the outside; Node 24's
 * `process.loadEnvFile` does it from inside. It never overrides a variable that
 * is already set, so an explicit `E2E_BASE_URL=... playwright test` still wins
 * over the file. Workers inherit the result.
 */
export function loadE2eEnv(): void {
  const file = process.env.E2E_ENV_FILE?.trim();
  if (!file) return;
  if (!fs.existsSync(file)) {
    throw new Error(`E2E_ENV_FILE is set but the file does not exist: ${file}`);
  }
  process.loadEnvFile(file);
}

export function baseUrl(): string {
  return process.env.E2E_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

/**
 * `E2E_DATABASE_URL` wins over `DATABASE_URL`: the latter is what the app and
 * most other tooling read, so a shell that happens to export it for another
 * database must not be what aims the e2e cleanup. Either way the guard in
 * `guard.ts` has the last word.
 */
export function databaseUrl(): string | undefined {
  return process.env.E2E_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || undefined;
}

export interface Credentials {
  email: string;
  password: string;
}

/** `E2E_<ROLE>_EMAIL` / `E2E_<ROLE>_PASSWORD`, or null when either is absent. */
export function credentialsFor(role: Role): Credentials | null {
  const prefix = `E2E_${role.toUpperCase()}`;
  const email = process.env[`${prefix}_EMAIL`]?.trim();
  const password = process.env[`${prefix}_PASSWORD`];
  return email && password ? { email, password } : null;
}

/** `E2E_CHANNEL=chrome` drives the locally installed Chrome instead of bundled Chromium. */
export function browserChannel(): string | undefined {
  return process.env.E2E_CHANNEL?.trim() || undefined;
}

/** The one sentence every skip for a missing role uses, so it is greppable in output. */
export function notVerified(role: Role): string {
  return `NOT VERIFIED: ${role} credentials absent (set E2E_${role.toUpperCase()}_EMAIL / E2E_${role.toUpperCase()}_PASSWORD)`;
}
