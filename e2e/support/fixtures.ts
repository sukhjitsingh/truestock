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
import { expect, test as base, type Browser } from "playwright/test";
import { credentialsFor, hasAuth, notVerified, type Credentials, type Role } from "./env";
import { dbApi, type Db } from "./db";
import { attachProblemCollector, describeProblems, type ProblemCollector } from "./problems";

interface Fixtures {
  problems: ProblemCollector;
}

interface WorkerFixtures {
  db: Db;
  browser: Browser;
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

  // `phone` project only: stop the soft keyboard from panning the viewport.
  //
  // On a real Android Chrome, focusing a text field opens the keyboard, and
  // Chrome then scrolls the VISUAL viewport (measured on the Pixel, 2026-11-10:
  // visualViewport.offsetTop 0 -> 236 px, height 849 -> 461) while the layout
  // viewport stays put. Playwright computes click points from layout geometry
  // and, over CDP to a real device, does not correct for that pan - so the
  // first click after a `fill` lands ~236 px off target (the trace shows the
  // Password label or the email field "intercepting" the Sign in button).
  // Setting the VirtualKeyboard API's `overlaysContent` makes the keyboard draw
  // over the page instead of panning it, so the two viewports agree again. It
  // changes no app code or app behaviour; a person tapping the button they see
  // was never affected.
  // (Array form like the others: a bare method named `context` that calls
  // `use` trips eslint's react-hooks rule.)
  context: [
    async ({ context }, use, testInfo) => {
      if (testInfo.project.name === "phone") {
        await context.addInitScript(() => {
          const vk = (navigator as Navigator & { virtualKeyboard?: { overlaysContent: boolean } }).virtualKeyboard;
          if (vk) vk.overlaysContent = true;
        });
      }
      await use(context);
    },
    { scope: "test" },
  ],

  // The `browser` every test context hangs off.
  //
  // `phone` project: attach to the real phone's Chrome over CDP
  // (E2E_PHONE_CDP, normally the adb-forwarded http://127.0.0.1:9333) instead of
  // launching one. Android Chrome refuses Browser.setWindowBounds, which
  // Playwright calls for any context with a viewport, so every context opened on
  // it must use `viewport: null` (the phone's own screen) - the phone project's
  // `use` sets that. For a CDP connection `close()` only disconnects; it never
  // quits the phone's Chrome.
  //
  // Every other project: what Playwright's built-in fixture does when there is
  // no `connectOptions` - `<browserName>.launch()`, picking up headless/channel/
  // launchOptions from the auto `_browserOptions` fixture, which sets the
  // browser type's default launch options before this runs.
  browser: [async ({ playwright, browserName }, use, workerInfo) => {
    let browser: Browser;
    if (workerInfo.project.name === "phone") {
      const endpoint = process.env.E2E_PHONE_CDP?.trim();
      if (!endpoint) throw new Error("the phone project needs E2E_PHONE_CDP (e.g. http://127.0.0.1:9333)");
      browser = await playwright.chromium.connectOverCDP(endpoint);
    } else {
      browser = await playwright[browserName].launch();
    }
    await use(browser);
    await browser.close();
  }, { scope: "worker", timeout: 0 }],

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
