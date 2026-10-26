/**
 * Smoke: does the production build serve a working, hydrating app at all?
 *
 * This is the cheapest spec and the one that would have caught the two worst
 * bugs this project has shipped. Both returned 200 and rendered correct HTML:
 *   - a static CSP that blocked Next's inline scripts, so NOTHING hydrated;
 *   - a login form that fell back to a native GET and wrote the password into
 *     the query string.
 * Every assertion below therefore waits for hydration or inspects the form's
 * method, and the `problems` fixture (automatic, see support/fixtures.ts) fails
 * the test on any console error, uncaught exception or CSP violation.
 */
import { expect, requireCredentials, requireRole, test } from "../support/fixtures";
import { signInWithRetry, submitLoginUntilAnswered } from "../support/auth";
import { authFile } from "../support/env";
import { waitForHydration } from "../support/hydration";

const SIGNED_OUT = { cookies: [], origins: [] };

test.describe("login page", () => {
  test.use({ storageState: SIGNED_OUT });

  test("renders a POST form that hydrates", async ({ page }) => {
    await page.goto("/login");
    // Mutation check: delete `method="post"` from components/login-form.tsx and
    // this fails (the attribute reads back as "get"). The browser default is
    // GET, which is how a plaintext password reached the server log.
    await expect(page.locator("form")).toHaveAttribute("method", /^post$/i);
    // Mutation check: put a static CSP back in next.config.ts and the form never
    // gets a __react key, so this times out by name instead of passing a 200.
    await waitForHydration(page, "form");
    // The submit is inert until hydrated (useHydrated); once it is, it is live.
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  test("a wrong password shows the generic error and stays on /login", async ({ page, problems }) => {
    // The sign-in endpoint answers 401 and Chrome logs that as a console error.
    // It is the behaviour under test, so it is allowed here and nowhere else. A
    // 429 may precede it (3 sign-ins per 10s; see support/auth.ts) and is waited out.
    problems.allow(/status of (401|429)/);

    await page.goto("/login");
    await waitForHydration(page, "form");
    // A non-existent address, not the owner's: this never counts a failed attempt
    // against a real account, and the app must answer identically either way
    // (components/login-form.tsx: deliberately generic, no account enumeration).
    const result = await submitLoginUntilAnswered(page, { email: "nobody@example.test", password: "not-the-password" });

    expect(result).toEqual({ outcome: "rejected", status: 401 });
    await expect(page.getByText("Sign-in failed. Check your email and password.")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    // And the password is not in the URL (the GET-submit failure mode).
    expect(page.url()).not.toContain("password");
  });

  test("the owner can sign in through the form", async ({ page, problems }) => {
    problems.allow(/status of 429/); // rate-limit backoff, handled by signInWithRetry
    const creds = requireCredentials("owner");
    await signInWithRetry(page, creds, "owner");
    // Owners land in the back office (app/page.tsx routes by role).
    await expect(page).toHaveURL(/\/office/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});

test.describe("signed-out access", () => {
  test.use({ storageState: SIGNED_OUT });

  for (const path of ["/count", "/office/catalog"]) {
    test(`${path} redirects to /login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
      await waitForHydration(page, "form");
    });
  }
});

test.describe("office sweep (owner)", () => {
  test.use({ storageState: authFile("owner") });
  // Runs on both viewports: the back office is a desk surface, but "renders and
  // is clean at 390px" is still worth knowing and costs ~0.5s a page.
  test.beforeEach(() => requireRole("owner"));

  const ROUTES: { path: string; title: string }[] = [
    { path: "/office/catalog", title: "Catalog" },
    { path: "/office/counts", title: "Counts" },
    { path: "/office/invoices", title: "Invoices" },
    { path: "/office/locations", title: "Locations" },
    { path: "/office/reorder", title: "Reorder" },
    { path: "/office/users", title: "Users" },
    { path: "/office/vendors", title: "Vendors" },
    { path: "/office/invoices/audit-packet", title: "Audit Packet" },
  ];

  for (const { path, title } of ROUTES) {
    test(`${path} renders, hydrates, and is clean`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      // The rail is the layout's client component; a __react key on it proves
      // the page's bundle executed (the CSP canary), which a 200 never does.
      await waitForHydration(page, 'nav[aria-label="Back office"] button');
    });
  }
});
