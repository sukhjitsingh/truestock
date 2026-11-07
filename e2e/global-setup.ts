/**
 * Runs once before any spec: proves the target is safe, waits for the app, and
 * signs each role in ONCE through the real login form.
 *
 * Order matters:
 *
 *  1. Target guard FIRST. Nothing below may touch a socket until the app and the
 *     database have been shown to be loopback and the database named `_e2e`.
 *  2. Stale session files are deleted before anything else can fail, so a run
 *     that dies half-way can never leave the next run "signed in" with cookies
 *     from a database that has since been reset.
 *  3. Wait for `/login` to answer 200 (the rig may still be starting).
 *  4. One sign-in per configured role, sequentially, with 429 backoff (see
 *     `support/auth.ts` for why specs never sign in themselves).
 *
 * A role without credentials gets an EMPTY state file plus a loud
 * "NOT VERIFIED" line. The file must exist so `test.use({ storageState })` in a
 * spec resolves; `hasAuth()` reads it back as "no session", and the spec skips.
 * Under `CI` or `E2E_REQUIRE_ALL=1` a missing role fails setup instead.
 *
 * Each sign-in must also add a `session` row to the guarded `_e2e` database. That
 * is the only check tying the app under test to the database the specs assert on.
 *
 * Errors name roles and statuses only. Credentials are never interpolated into
 * a message, a log line or a file name.
 */
import fs from "node:fs";
import { chromium } from "playwright/test";
import { signInWithRetry } from "./support/auth";
import { AUTH_DIR, authFile, baseUrl, browserChannel, credentialsFor, databaseUrl, notVerified, ROLES } from "./support/env";
import { closeDb, sessionCountFor } from "./support/db";
import { assertE2eTarget } from "./support/guard";

async function waitForApp(base: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  for (;;) {
    try {
      const res = await fetch(new URL("/login", base), { redirect: "manual" });
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : "request failed";
    }
    if (Date.now() >= deadline) {
      throw new Error(`e2e: ${base}/login did not return 200 within ${timeoutMs / 1000}s (last: ${last}). Is the e2e app container up?`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export default async function globalSetup(): Promise<void> {
  const base = baseUrl();
  const target = assertE2eTarget(databaseUrl(), base);
  console.log(`e2e target: app ${base}  db ${target.dbHost}:${target.dbPort}/${target.database}`);

  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  await waitForApp(base);

  const browser = await chromium.launch({ channel: browserChannel() });
  try {
    for (const role of ROLES) {
      const creds = credentialsFor(role);
      if (!creds) {
        if (process.env.CI || process.env.E2E_REQUIRE_ALL === "1") {
          // A pipeline with no secrets would otherwise be green with every
          // role-gated spec skipped, which reads as "tested".
          throw new Error(`e2e refused to run: ${notVerified(role)}, and CI / E2E_REQUIRE_ALL=1 is set, so a skipped role counts as a failure.`);
        }
        fs.writeFileSync(authFile(role), JSON.stringify({ cookies: [], origins: [] }));
        console.warn(notVerified(role));
        continue;
      }
      const sessionsBefore = await sessionCountFor(creds.email);
      const context = await browser.newContext({ baseURL: base });
      try {
        const page = await context.newPage();
        await signInWithRetry(page, creds, role);
        if ((await sessionCountFor(creds.email)) <= sessionsBefore) {
          throw new Error(
            `e2e refused to run: signing in ${role} wrote no session row to the ${target.database} database. ` +
              `The app at ${base} is using a different database than the one this suite resets and asserts against. ` +
              "Point E2E_BASE_URL at the e2e app container (scripts/e2e-rig.sh), not a dev server.",
          );
        }
        await context.storageState({ path: authFile(role) });
        console.log(`e2e: signed in ${role}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await closeDb();
  }
}
