/**
 * Waiting for React to attach.
 *
 * This is the helper every spec depends on, and the reason it exists is a
 * Playwright sharp edge specific to this app (see `playwright-fill-before-
 * hydration-lies` in the project notes): server-rendered HTML is typeable
 * before React has attached. A controlled input filled in that window shows the
 * text, but React then resets the field from its own state, so the form submits
 * blanks — and the server blames the data instead of the timing.
 *
 * It also doubles as the CSP canary. A static CSP that blocks Next's inline
 * scripts leaves every page rendering correctly with HTTP 200 and nothing
 * hydrating at all (AGENTS.md, "Config that must not drift"). Waiting for
 * hydration turns that silent break into a 20-second timeout with a name.
 *
 * ## Why polling `page.evaluate` and not `page.waitForFunction`
 *
 * `waitForFunction` evaluates a function it serialises to a string, and the
 * production CSP has no `'unsafe-eval'` — correctly, that is the point of it.
 * `page.evaluate` calls a function on an existing handle, which is not
 * affected, so polling it from Node is CSP-safe in both builds. Ported from
 * `waitForHydration` in `scripts/verify-browser.mjs`.
 *
 * "Hydrated" means the element carries a `__react*` key (React stores its fiber
 * on the DOM node as `__reactFiber$…` / `__reactProps$…`, and only after it has
 * attached to that node).
 */
import type { Locator, Page } from "playwright/test";

/**
 * Same wait, aimed at a Playwright locator instead of a CSS selector — for the
 * places where the element worth waiting on is only addressable by role/name
 * (the hub's "Start a count" button). Resolved fresh on every poll, so a node
 * React replaced between polls is picked up rather than read stale.
 */
export async function waitForLocatorHydration(locator: Locator, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let hydrated = false;
    try {
      hydrated = await locator.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__react")), undefined, {
        timeout: 1_000,
      });
    } catch {
      // Not in the DOM yet, or a navigation landed between polls. Poll again.
    }
    if (hydrated) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitForLocatorHydration: ${locator.toString()} never hydrated within ${timeoutMs}ms`);
    }
    await locator.page().waitForTimeout(100);
  }
}

export async function waitForHydration(page: Page, selector = "form", timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let hydrated = false;
    try {
      hydrated = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return Boolean(el) && Object.keys(el as Element).some((k) => k.startsWith("__react"));
      }, selector);
    } catch {
      // "Execution context was destroyed": a navigation landed between polls
      // (a sign-in redirect, a router.refresh() hard-fallback). That is not a
      // failure of hydration — poll the new document.
    }
    if (hydrated) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitForHydration: "${selector}" never hydrated within ${timeoutMs}ms (${page.url()})`);
    }
    await page.waitForTimeout(100);
  }
}
