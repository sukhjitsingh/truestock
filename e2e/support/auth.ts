/**
 * Signing in through the real login form.
 *
 * Specs never sign in; global setup does it once per role and saves the cookies
 * (`storageState`). The reason is the server, not tidiness: Better Auth
 * rate-limits `POST /api/auth/sign-in/email` hard in production (its default
 * rule is 3 requests per 10 seconds), so a spec that signed itself in would turn
 * a fast suite into a 429 lottery. This module is therefore used in exactly two
 * places — global setup, and the smoke spec that tests the login page itself.
 *
 * It drives the actual UI, not `request.post`. The form is part of what is
 * under test: the hydrated-submit gate and the generic error are product
 * behaviour, and a sign-in that bypassed them would leave the login page
 * unexercised on every run.
 */
import type { Page } from "playwright/test";
import { baseUrl, type Credentials } from "./env";
import { waitForHydration } from "./hydration";

export type LoginOutcome =
  | { outcome: "signed-in" }
  | { outcome: "rejected"; status: number }
  | { outcome: "rate-limited"; retryAfterSeconds: number };

const SIGN_IN_PATH = "/api/auth/sign-in/email";

/**
 * Fills and submits the login form that is already on screen and reports what
 * the server said. Does not retry — see `submitLoginUntilAnswered` for that.
 */
export async function submitLogin(page: Page, creds: Credentials): Promise<LoginOutcome> {
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);

  const response = page.waitForResponse((r) => r.url().includes(SIGN_IN_PATH) && r.request().method() === "POST", {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Sign in" }).click();
  const res = await response;

  if (res.status() === 429) {
    const header = res.headers()["x-retry-after"] ?? res.headers()["retry-after"];
    const seconds = Number(header);
    return { outcome: "rate-limited", retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 10 };
  }
  if (!res.ok()) return { outcome: "rejected", status: res.status() };

  // The form calls router.replace("/") + refresh(); the server then redirects
  // by role. Leaving /login is the signal the session cookie really took.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  return { outcome: "signed-in" };
}

/**
 * Submits the login form on screen, waiting out 429s, and returns the first
 * non-429 answer. The form stays usable after a failed attempt (the page does
 * not navigate), so the retry reuses it — no reload, no second page load.
 *
 * A full run makes more sign-ins than the 3-per-10s window allows (3 in global
 * setup, then the smoke spec's own). Browsers also log every 429 as a console
 * error, so a test that goes through here must `problems.allow(/status of 429/)`.
 */
export async function submitLoginUntilAnswered(
  page: Page,
  creds: Credentials,
): Promise<Exclude<LoginOutcome, { outcome: "rate-limited" }>> {
  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await submitLogin(page, creds);
    if (result.outcome !== "rate-limited") return result;
    // +1s of slack: the window is measured from the server's clock.
    await page.waitForTimeout((result.retryAfterSeconds + 1) * 1000);
  }
  throw new Error(`e2e sign-in stayed rate-limited after ${MAX_ATTEMPTS} attempts.`);
}

/**
 * Open /login, sign in, wait for the redirect. Throws on a rejected credential
 * — the message carries the role label and HTTP status only, never the email or
 * password.
 */
export async function signInWithRetry(page: Page, creds: Credentials, label: string): Promise<void> {
  await page.goto(new URL("/login", baseUrl()).toString());
  await waitForHydration(page, "form");
  const result = await submitLoginUntilAnswered(page, creds);
  if (result.outcome === "rejected") {
    throw new Error(
      `e2e sign-in for ${label} was rejected by the server (HTTP ${result.status}). Check E2E_${label.toUpperCase()}_EMAIL / _PASSWORD.`,
    );
  }
}
