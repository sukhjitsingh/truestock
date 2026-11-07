/**
 * The `test` every spec imports (never `playwright/test` directly).
 *
 * It adds two things on top of Playwright's own:
 *
 *  - `problems` — an AUTOMATIC fixture, so no spec can forget it. It attaches a
 *    collector for console errors / uncaught exceptions / CSP violations / 5xx
 *    to the page, and after the test body FAILS the test if any were seen that
 *    the test did not explicitly allow. See `problems.ts` for why a clean
 *    browser is part of "passes" in this project.
 *  - `db` — the guarded ground-truth handle (`db.ts`).
 *
 * Plus `requireRole`, the one way a spec says "I need this role's session":
 * when global setup could not sign that role in it skips LOUDLY — a line on
 * stdout and the skip reason in the report — because a silent skip reads as a
 * pass and nobody looks for it again.
 */
import { expect, test as base } from "playwright/test";
import { credentialsFor, hasAuth, notVerified, type Credentials, type Role } from "./env";
import { dbApi, type Db } from "./db";
import { attachProblemCollector, describeProblems, type ProblemCollector } from "./problems";

interface Fixtures {
  problems: ProblemCollector;
}

interface WorkerFixtures {
  db: Db;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  problems: [
    async ({ page }, use, testInfo) => {
      const collector = await attachProblemCollector(page);
      await use(collector);

      const bad = collector.unexpected();
      if (bad.length === 0) return;
      const lines = describeProblems(bad);
      if (testInfo.status === testInfo.expectedStatus) {
        // The test body was happy; the browser was not. That is the failure
        // this fixture exists to produce.
        expect(lines, "the page reported errors the test did not allow-list").toEqual([]);
      } else {
        // Already failing for another reason — keep the extra evidence without
        // burying the real assertion under a second error.
        await testInfo.attach("page-problems", { body: lines.join("\n"), contentType: "text/plain" });
      }
    },
    { auto: true },
  ],

  // Worker-scoped so the pool is opened once per worker and CLOSED when the
  // worker ends — an open mysql2 pool keeps a Node process alive.
  // (`{}` is not decoration: Playwright reads the destructuring to learn a fixture's dependencies.)
  db: [async ({}, use) => {
    await use(dbApi);
    await dbApi.closeDb();
  }, { scope: "worker" }],
});

export { expect };

/**
 * Skip the current test (loudly) unless global setup signed this role in.
 * Call from `test.beforeEach` or at the top of a test.
 */
export function requireRole(role: Role): void {
  const missing = !hasAuth(role);
  if (missing) console.warn(notVerified(role));
  test.skip(missing, notVerified(role));
}

/**
 * For the few tests that sign in themselves (they exercise the login form):
 * returns the role's credentials, or skips loudly. Never logs the values.
 */
export function requireCredentials(role: Role): Credentials {
  const creds = credentialsFor(role);
  if (!creds) {
    console.warn(notVerified(role));
    test.skip(true, notVerified(role));
  }
  return creds as Credentials;
}
