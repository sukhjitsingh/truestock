/**
 * Playwright test-runner configuration for the Truestock e2e suite.
 *
 * The suite drives a RUNNING PRODUCTION BUILD (see e2e/README.md) — this repo
 * cannot run the app natively on every contributor's machine (the dev box is an
 * Intel Mac and the app only runs in Docker), and a production build is the
 * thing that ships: it has the nonce CSP and the real hydration path that a dev
 * server papers over.
 *
 * Files are `*.e2e.ts`, never `*.spec.ts` / `*.test.ts`. `bun test` and
 * `scripts/run-tests.sh` glob those two suffixes, and a Playwright file loaded
 * by bun's runner fails at import. The distinct suffix is what keeps the two
 * runners out of each other's way.
 *
 * `workers: 1` and `fullyParallel: false` are not timidity: specs share one
 * database and `resetCounts()` deletes every count in it, so two specs running
 * at once would delete each other's fixtures.
 */
import { defineConfig, devices } from "playwright/test";
import { baseUrl, browserChannel, loadE2eEnv } from "./e2e/support/env";

// Must happen before anything below reads the environment, and only does
// anything when E2E_ENV_FILE is set. Variables already in the environment win.
loadE2eEnv();

const channel = browserChannel();

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL: baseUrl(), // E2E_BASE_URL, else http://localhost:3101
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(channel ? { channel } : {}),
  },
  projects: [
    {
      // The product is a phone app; this is the viewport it is built for.
      name: "mobile",
      // The back-office catalog table is a desk surface (see its spec header).
      testIgnore: ["**/office-catalog.e2e.ts"],
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        ...(channel ? { channel } : {}),
      },
    },
    {
      name: "desktop",
      // The counting screens are phone-only by design (one-handed, tab bar,
      // 56px targets); running them at 1280px would test a layout nobody uses
      // and double the database churn. Ignored here rather than skipped inside
      // the specs so the report never shows them as "skipped", which is
      // reserved for NOT VERIFIED.
      testIgnore: ["**/count-flow.e2e.ts", "**/phone-round2.e2e.ts"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, ...(channel ? { channel } : {}) },
    },
  ],
});
