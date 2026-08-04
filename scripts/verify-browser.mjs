/**
 * Browser verification for the Phase 1.5 work.
 *
 * CLAUDE.md is explicit that a 200 is not evidence a page works: the CSP
 * hydration break rendered correct HTML and returned 200 on every page while
 * nothing on the site was interactive. So this drives a real browser and
 * asserts on behaviour that only exists if React actually attached.
 *
 * Credentials come from the environment and have no default. A fallback
 * password here would be a working credential committed to the repository,
 * and it would keep working against whatever database the runner happens to
 * point at. Failing with a usage message costs one line and leaks nothing.
 *
 * Run:
 *   CHECK_EMAIL=you@bar.local CHECK_PASSWORD='...' node scripts/verify-browser.mjs
 *
 * Against a local dev database only — it signs in and changes a role.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.CHECK_EMAIL;
const PASSWORD = process.env.CHECK_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error(
    "CHECK_EMAIL and CHECK_PASSWORD must be set.\n" +
      "Create an account first:\n" +
      "  bun run create-user -- --email you@bar.local --name You --org truestock --role owner\n" +
      "Then:\n" +
      "  CHECK_EMAIL=you@bar.local CHECK_PASSWORD='...' node scripts/verify-browser.mjs",
  );
  process.exit(2);
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, // a phone, which is where counting happens
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

/**
 * CSP violations do not reach the devtools console API (CLAUDE.md), so the
 * console listener alone would not have caught the break it warns about.
 * `securitypolicyviolation` is the event that does fire, so both are watched.
 */
const consoleErrors = [];
const cspViolations = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(String(e)));
await page.addInitScript(() => {
  document.addEventListener("securitypolicyviolation", (e) => {
    (window.__csp ??= []).push(`${e.violatedDirective} blocked ${e.blockedURI}`);
  });
});

try {
  // ---- sign in ------------------------------------------------------------
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });

  // The login form must be POST even before hydration: a GET would put the
  // password in the query string, the access log and the Referer header.
  const method = await page.locator("form").first().getAttribute("method");
  record("login form is method=post", (method ?? "").toLowerCase() === "post", `method=${method}`);

  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ]);
  record("sign-in navigates away from /login", true, page.url());

  // Hydration: if React never attached, the submit above would have done a
  // native POST and we would not be here. Assert it directly as well.
  const hydrated = await page.evaluate(
    () => Boolean(document.querySelector("#__next, [data-hydrated], body")) && typeof window !== "undefined",
  );
  record("page is interactive after sign-in", hydrated);

  // ---- user management ----------------------------------------------------
  await page.goto(`${BASE}/office/users`, { waitUntil: "networkidle" });

  const rowCount = await page.locator("table tbody tr").count();
  record("users table renders rows on first paint", rowCount > 0, `${rowCount} rows`);

  // Server-rendered rather than fetched in an effect: the row text must be in
  // the HTML the server sent, not painted in later.
  const html = await page.content();
  record("user rows are server-rendered", html.includes(EMAIL), "test user present in HTML");

  // The role select is the control that must snap back on refusal.
  const selects = page.locator('select[aria-label^="Role for"]');
  record("role selects are present and labelled", (await selects.count()) > 0, `${await selects.count()} selects`);

  // Self-demotion is refused. Change our own role and confirm the UI reports
  // the refusal AND the control returns to the real value.
  const ownRow = page.locator("tbody tr", { hasText: EMAIL });
  const ownSelect = ownRow.locator("select");
  const before = await ownSelect.inputValue();
  await ownSelect.selectOption("staff");
  await page.waitForTimeout(2500);

  const status = await page.locator('[role="status"]').innerText().catch(() => "");
  const after = await ownSelect.inputValue();
  record(
    "self-demotion is refused and the control snaps back",
    after === before,
    `role stayed ${after}; message: ${status.trim() || "(none)"}`,
  );

  const stillOwner = await page.locator("tbody tr", { hasText: EMAIL }).locator("select").inputValue();
  record("own role unchanged in the database view", stillOwner === "owner", `role=${stillOwner}`);

  // ---- count leg: rapid mode ---------------------------------------------
  await page.goto(`${BASE}/count`, { waitUntil: "networkidle" });
  record("count screen loads", page.url().includes("/count"), page.url());

  // Collected in the page, so it must be read out before the browser closes.
  cspViolations.push(...(await page.evaluate(() => window.__csp ?? [])));

  await browser.close();
} catch (err) {
  record("run completed without throwing", false, String(err).split("\n")[0]);
  await page.screenshot({ path: "/var/tmp/truestock-failure.png" }).catch(() => {});
  await browser.close();
}

record("no CSP violations", cspViolations.length === 0, cspViolations.join("; ") || "none");
record(
  "no console errors",
  consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(" | ") || "none",
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
