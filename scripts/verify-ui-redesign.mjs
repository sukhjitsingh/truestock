/**
 * Browser verification for the UI/UX redesign (docs/plans/ui-ux-redesign/).
 *
 * Follows the same pattern as scripts/verify-browser.mjs: real Chrome through
 * Playwright, hydration confirmed before any interaction, ground truth read
 * back from the database where a page makes a claim about stored data.
 * AGENTS.md: a 200 is not evidence a page works. Server-rendered HTML and
 * status codes passed on the CSP hydration break while nothing was
 * interactive.
 *
 * Run against a PRODUCTION build (`next build && next start`), not `next dev`:
 * the nonce CSP differs between the two ('unsafe-eval' is dev-only), and the
 * production policy is the one that has broken hydration before.
 *
 *   node scripts/verify-ui-redesign.mjs
 *
 * BASE_URL defaults to http://localhost:3011 — `localhost`, not 127.0.0.1:
 * in production Better Auth trusts only BETTER_AUTH_URL as an origin, so
 * signing in from the other spelling of the same server is a 403 that looks
 * exactly like a wrong password.
 *
 * Output: PASS / FAIL / NOTRUN lines, a JSON results file and screenshots under
 * SHOT_DIR (default ./var/ui-redesign-shots). NOTRUN is a check that could not
 * be exercised (no data to open); it is never counted as a pass.
 *
 * Two sections:
 *
 *   1. Unauthenticated: always runs, needs only the server.
 *   2. Authenticated: runs only when CHECK_EMAIL and CHECK_PASSWORD are set,
 *      and needs DATABASE_URL (ground truth is read back from the database, as
 *      scripts/verify-browser.mjs does). The credentials come from the
 *      environment and have no default; this script never creates an account
 *      and never writes a password anywhere. Use an OWNER account, the office
 *      routes bounce other roles. Against a local dev database only:
 *
 *        CHECK_EMAIL=... CHECK_PASSWORD=... \
 *          VERIFY_ALLOW_DB=127.0.0.1:3310/truestock \
 *          node --env-file=.env.local scripts/verify-ui-redesign.mjs
 *
 *      It signs in once and reuses that browser context for everything (the
 *      viewport is switched per page), which keeps it to one /sign-in request
 *      against Better Auth's rate limit. It may leave an open, tagged test
 *      count behind and one test count line; it deletes nothing.
 *
 *      It refuses to run the authenticated section (before signing in or
 *      opening the database) unless DATABASE_URL and BASE_URL are both
 *      loopback (127.0.0.1, localhost or ::1; a docker service name does not
 *      count) AND VERIFY_ALLOW_DB is set to exactly `<host>:<port>/<database>`
 *      of that DATABASE_URL, as in the example above. The opt-in is per run on
 *      purpose: a stale DATABASE_URL in the shell must not be able to aim this
 *      script's count writes at real data. The refusal prints the exact value
 *      to export. See scripts/lib/assert-local-target.mjs. The unauthenticated
 *      section only issues GETs and an empty form submit, writes nothing, and
 *      stays available without any of this.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import { chromium } from "playwright";
import { assertLocalTarget } from "./lib/assert-local-target.mjs";

export const BASE = process.env.BASE_URL ?? "http://localhost:3011";
export const SHOT_DIR = process.env.SHOT_DIR ?? "var/ui-redesign-shots";

export const results = [];
export function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * A check that could not be exercised here (no invoice in the DB, an earlier
 * step it depends on failed). It is recorded, printed with a distinct NOTRUN
 * prefix and counted on its own line in the summary, but `ok` is null: it is
 * neither a pass nor a failure. A skipped check that reads as a pass is worse
 * than a failure, because nobody goes looking for it again.
 */
export function notRun(name, detail = "") {
  const full = name.startsWith("NOTRUN") ? name : `NOTRUN ${name}`;
  results.push({ name: full, ok: null, notRun: true, detail });
  console.log(`${full}${detail ? ` — ${detail}` : ""}`);
}

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const firstLine = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 300);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Poll `fn` from Node until it returns something truthy; returns the last value either way. */
async function pollUntil(fn, timeoutMs = 10000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value || Date.now() >= deadline) return value;
    await sleep(intervalMs);
  }
}

/** Run one check body returning `{ ok, detail }`; a thrown locator timeout becomes a FAIL, not a crash. */
async function check(name, fn) {
  try {
    const r = await fn();
    record(name, r.ok, r.detail ?? "");
    return r.ok;
  } catch (e) {
    record(name, false, `threw: ${firstLine(e)}`);
    return false;
  }
}

/** Same polling approach as verify-browser.mjs; see its comment for why this is not waitForFunction. */
export async function waitForHydration(page, selector = "form", timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hydrated = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__react"));
    }, selector);
    if (hydrated) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(100);
  }
}

/**
 * Installed with addInitScript, which bypasses the page's own CSP. Collects the
 * browser's `securitypolicyviolation` events — the channel Chrome actually
 * reports CSP blocks on. The absence of a console message proves nothing.
 */
export async function installDiagnostics(context) {
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || "inline"}`);
    });
  });
}

/** Console errors, uncaught page errors and failed same-origin requests for one page. */
export function watchPage(page) {
  const seen = { console: [], pageerror: [], failed: [] };
  page.on("console", (m) => {
    if (m.type() === "error") seen.console.push(m.text());
  });
  page.on("pageerror", (e) => seen.pageerror.push(String(e)));
  page.on("response", (r) => {
    if (r.url().startsWith(BASE) && r.status() >= 500) seen.failed.push(`${r.status()} ${r.url()}`);
  });
  return seen;
}

export async function shot(page, name) {
  await mkdir(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/** True when the page scrolls sideways — the classic phone-width regression. */
export async function hasHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

export async function cspViolations(page) {
  return page.evaluate(() => window.__csp ?? []);
}

async function unauthenticated(browser) {
  for (const [label, viewport] of [
    ["phone", { width: 390, height: 844 }],
    ["desktop", { width: 1280, height: 800 }],
  ]) {
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
    await installDiagnostics(context);
    const page = await context.newPage();
    const seen = watchPage(page);

    const res = await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    record(`[${label}] /login responds 200`, res?.status() === 200, `status ${res?.status()}`);

    const hydrated = await waitForHydration(page, "form");
    record(`[${label}] /login hydrates under the production CSP`, hydrated);

    await page.waitForLoadState("networkidle");
    const violations = await cspViolations(page);
    record(`[${label}] /login raises no CSP violations`, violations.length === 0, violations.join("; "));
    record(
      `[${label}] /login has no console errors or page errors`,
      seen.console.length === 0 && seen.pageerror.length === 0,
      [...seen.console, ...seen.pageerror].join(" | "),
    );
    record(`[${label}] /login does not scroll sideways`, !(await hasHorizontalOverflow(page)));

    // AGENTS.md: every JS-submitted form carries method="post".
    const method = await page.locator("form").first().getAttribute("method");
    record(`[${label}] login form is method="post"`, method?.toLowerCase() === "post", `method=${method}`);

    // Hydrated submit with empty fields must not navigate or put anything in the URL.
    const before = page.url();
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(400);
    record(
      `[${label}] empty submit leaves credentials out of the URL`,
      page.url() === before && !page.url().includes("password"),
      page.url(),
    );

    await shot(page, `unauth-${label}-login`);
    await context.close();
  }

  // Unauthenticated users are bounced from both shells.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  for (const p of ["/office", "/office/invoices", "/count", "/count/catalog"]) {
    await page.goto(`${BASE}${p}`, { waitUntil: "domcontentloaded" });
    record(`unauthenticated ${p} redirects to /login`, new URL(page.url()).pathname === "/login", page.url());
  }

  // Framing headers: relaxed for the numeric invoice-file path only.
  const framed = await page.request.get(`${BASE}/api/invoices/1/file`);
  const framedH = framed.headers();
  record(
    "invoice file route allows same-origin framing (X-Frame-Options + CSP)",
    framedH["x-frame-options"] === "SAMEORIGIN" && /frame-ancestors 'self'/.test(framedH["content-security-policy"] ?? ""),
    `status ${framed.status()} xfo=${framedH["x-frame-options"]}`,
  );
  const notFramed = await page.request.get(`${BASE}/api/invoices/abc/file`);
  const notFramedH = notFramed.headers();
  record(
    "a non-numeric invoice path keeps DENY / frame-ancestors 'none'",
    notFramedH["x-frame-options"] === "DENY" && /frame-ancestors 'none'/.test(notFramedH["content-security-policy"] ?? ""),
    `xfo=${notFramedH["x-frame-options"]}`,
  );
  const login = await page.request.get(`${BASE}/login`);
  record(
    "every other page keeps DENY",
    login.headers()["x-frame-options"] === "DENY",
    `xfo=${login.headers()["x-frame-options"]}`,
  );
  await context.close();
}

// ---------------------------------------------------------------------------
// Authenticated section
// ---------------------------------------------------------------------------

/**
 * Sign in through the real login form. Uses the form's own field ids
 * (components/login-form.tsx: #email, #password) and the submit button, which
 * is disabled until the form hydrates, so hydration is confirmed first: typing
 * into a controlled input before React attaches submits empty fields and the
 * server blames the data instead of the timing.
 *
 * Success is polled off `page.url()` from Node. `waitForFunction` and friends
 * evaluate a string in the page, which the production nonce CSP forbids in the
 * second and later contexts (see waitForHydration in verify-browser.mjs).
 *
 * Reads CHECK_EMAIL / CHECK_PASSWORD from the environment and puts neither in
 * any output. Records PASS or FAIL and returns a boolean; never throws.
 */
export async function signIn(context) {
  const name = "sign in with CHECK_EMAIL / CHECK_PASSWORD leaves /login";
  const page = await context.newPage();
  const authErrors = [];
  page.on("response", (r) => {
    if (!r.url().startsWith(BASE)) return;
    const p = new URL(r.url()).pathname;
    if (p.startsWith("/api/auth/") && r.status() >= 400) authErrors.push(`${r.status()} ${p}`);
  });
  try {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    if (!(await waitForHydration(page, "form"))) {
      record(name, false, "login form never hydrated; refusing to type into it");
      return false;
    }
    await page.fill("#email", process.env.CHECK_EMAIL ?? "");
    await page.fill("#password", process.env.CHECK_PASSWORD ?? "");
    await page.click('button[type="submit"]');
    const left = await pollUntil(async () => !new URL(page.url()).pathname.startsWith("/login"), 20000, 200);
    if (left) {
      record(name, true, `landed on ${new URL(page.url()).pathname}`);
      return true;
    }
    const alertText = await page
      .locator('[role="alert"]')
      .first()
      .innerText({ timeout: 1000 })
      .catch(() => "");
    record(
      name,
      false,
      `still on /login after 20s${authErrors.length ? `; auth responses: ${authErrors.join(", ")}` : ""}${
        alertText ? `; page says: ${alertText.slice(0, 120)}` : ""
      }. Skipping the rest of the authenticated checks`,
    );
    return false;
  } catch (e) {
    record(name, false, `threw: ${firstLine(e)}. Skipping the rest of the authenticated checks`);
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

/** The first selector in `candidates` that currently matches something. */
async function firstPresent(page, candidates) {
  for (const sel of candidates) {
    if ((await page.locator(sel).count()) > 0) return sel;
  }
  return null;
}

/**
 * Discover every static and dynamic page route under app/(office) and
 * app/(count) by walking the filesystem, so a route added later is swept
 * without anyone editing this list. Route groups "(x)" vanish from the URL;
 * "_private" folders and "@slot" folders are not routes. app/login and app/page
 * sit outside both groups and are covered by the unauthenticated section.
 */
export async function discoverRoutes() {
  const appDir = new URL("../app/", import.meta.url);
  const found = [];
  async function walk(dirUrl, segs) {
    const entries = await readdir(dirUrl, { withFileTypes: true });
    if (segs.length && entries.some((e) => e.isFile() && /^page\.(tsx|ts|jsx|js)$/.test(e.name))) {
      found.push(`/${segs.join("/")}`);
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith("_") || e.name.startsWith("@")) continue;
      const isGroup = /^\((?!\.)[^)]+\)$/.test(e.name);
      await walk(new URL(`${e.name}/`, dirUrl), isGroup ? segs : [...segs, e.name]);
    }
  }
  for (const group of ["(office)", "(count)"]) await walk(new URL(`${group}/`, appDir), []);
  return found.sort();
}

/** Org-scoped fallbacks when a list page has no link to follow. Keyed by the [param] name. */
const PARAM_FALLBACK_SQL = {
  productId: "SELECT id FROM product WHERE organization_id = ? ORDER BY id LIMIT 1",
  countId: "SELECT id FROM `count` WHERE organization_id = ? ORDER BY id DESC LIMIT 1",
  invoiceId: "SELECT id FROM invoice WHERE organization_id = ? ORDER BY id LIMIT 1",
};

/**
 * Turn a route template like /office/catalog/[productId] into a concrete path.
 * For each [param], first follow the first matching link on the parent list
 * page (what a user would click); failing that, ask the database. Returns
 * `{ path }` or `{ path: null, why }`.
 */
async function resolveTemplate(context, sql, ctx, template) {
  const segs = template.split("/").filter(Boolean);
  let resolved = "";
  for (const seg of segs) {
    const m = /^\[(\w+)\]$/.exec(seg);
    if (!m) {
      resolved += `/${seg}`;
      continue;
    }
    const param = m[1];
    let id = null;

    // The count shell's [countId] routes need a WRITABLE count: the scan page
    // redirects submitted/reviewed/closed counts to /count/<id>, and the list
    // page only links "Review Count" for those.
    if (resolved === "/count" && param === "countId") {
      id =
        ctx.countId ??
        (
          await sql.query(
            "SELECT id FROM `count` WHERE organization_id = ? AND status IN ('draft','in_progress') ORDER BY started_at DESC, id DESC LIMIT 1",
            [ctx.orgId],
          )
        )[0][0]?.id ??
        null;
    } else {
      const listPath = resolved || "/";
      const page = await context.newPage();
      try {
        await page.setViewportSize(resolved.startsWith("/count") ? PHONE : DESKTOP);
        await page.goto(`${BASE}${listPath}`, { waitUntil: "domcontentloaded" });
        await waitForHydration(page, resolved.startsWith("/count") ? 'nav[aria-label="Primary"]' : "main", 15000);
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        const re = `^${escapeRegExp(listPath)}/(\\d+)(?:[/?#]|$)`;
        id = await page.evaluate((src) => {
          const rx = new RegExp(src);
          for (const a of document.querySelectorAll("a[href]")) {
            const hit = rx.exec(a.getAttribute("href") ?? "");
            if (hit) return hit[1];
          }
          return null;
        }, re);
      } catch {
        id = null;
      } finally {
        await page.close().catch(() => {});
      }
      if (id == null && PARAM_FALLBACK_SQL[param]) {
        id = (await sql.query(PARAM_FALLBACK_SQL[param], [ctx.orgId]))[0][0]?.id ?? null;
      }
    }
    if (id == null) return { path: null, why: `no [${param}] found: no link on ${resolved || "/"} and no row in the DB` };
    resolved += `/${id}`;
  }
  return { path: resolved };
}

/** One route at one viewport: loads, hydrates, and raises nothing. */
async function checkRoute(context, label, viewport, route) {
  const name = `[${label}] ${route} renders, hydrates and is clean`;
  const page = await context.newPage();
  try {
    await page.setViewportSize(viewport);
    const seen = watchPage(page);
    const res = await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
    const problems = [];
    const status = res?.status() ?? 0;
    const finalPath = new URL(page.url()).pathname;
    if (status >= 400 || status === 0) problems.push(`status ${status}`);
    if (finalPath !== route) {
      problems.push(`ended on ${finalPath} (a redirect: is CHECK_EMAIL an owner, and is the session carried?)`);
    }

    // The office layout has <main>; the count shell has none, only its bottom
    // tab bar, so it anchors on that (a client component), then on an <h1>.
    const anchor = await firstPresent(
      page,
      route.startsWith("/office") ? ["main"] : ['nav[aria-label="Primary"]', "h1"],
    );
    if (!anchor) problems.push("no hydration anchor element in the DOM");
    else if (!(await waitForHydration(page, anchor))) problems.push(`"${anchor}" never hydrated`);

    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    const csp = await cspViolations(page);
    if (csp.length) problems.push(`CSP: ${csp.join("; ")}`);
    const noisy = [...seen.console, ...seen.pageerror];
    if (noisy.length) problems.push(`console/page errors: ${noisy.join(" | ").slice(0, 400)}`);
    if (seen.failed.length) problems.push(`5xx: ${seen.failed.join(", ")}`);
    // Document-level only: a wide table scrolling inside its own container is fine.
    if (await hasHorizontalOverflow(page)) problems.push("document scrolls sideways");

    await shot(page, `auth-${label}-${route.replace(/^\//, "").replace(/\//g, "-")}`).catch(() => {});
    record(name, problems.length === 0, problems.length ? problems.join("; ") : `status ${status}, anchor ${anchor}`);
  } catch (e) {
    record(name, false, `threw: ${firstLine(e)}`);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Every page route, at both viewports for the back office, at phone only for
 * the count shell. docs/plans/ui-ux-redesign/00-status.md splits the work into
 * a "Mobile Floor App (app/(count))" and a "Desktop Back-Office (app/(office))"
 * and lists the mobile counting loop and the dim-room phone tap targets as the
 * unproven parts. The count shell is an always-dark phone app used one-handed
 * (AGENTS.md), so a desktop-width pass over it would pass without saying
 * anything about how it is used. The office is the one that must hold at both.
 */
async function routeSweep(context, sql, ctx) {
  console.log("\n--- route sweep ---");
  const templates = await discoverRoutes();
  record(
    "route discovery finds the page routes under app/(office) and app/(count)",
    templates.length > 0,
    `${templates.length}: ${templates.join(" ")}`,
  );
  for (const template of templates) {
    const resolved = template.includes("[") ? await resolveTemplate(context, sql, ctx, template) : { path: template };
    if (!resolved.path) {
      notRun(`${template}: no id to open`, resolved.why);
      continue;
    }
    const viewports = template.startsWith("/count")
      ? [["phone", PHONE]]
      : [
          ["phone", PHONE],
          ["desktop", DESKTOP],
        ];
    for (const [label, viewport] of viewports) await checkRoute(context, label, viewport, resolved.path);
  }
}

/** Parse count_line.partial_fills whichever way the driver hands it back (MariaDB JSON is longtext). */
function parseFills(v) {
  let x = v;
  if (x == null) return [];
  if (Buffer.isBuffer(x)) x = x.toString("utf8");
  if (typeof x === "string") {
    try {
      x = JSON.parse(x);
    } catch {
      return null;
    }
  }
  return Array.isArray(x) ? x.map(Number) : null;
}
const sameFills = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const showFills = (a) => (Array.isArray(a) ? `[${a.join(", ")}]` : String(a));

async function readLine(sql, ctx, productId, locationId) {
  const [rows] = await sql.query(
    "SELECT id, partial_fills AS pf FROM count_line WHERE organization_id = ? AND count_id = ? AND product_id = ? AND location_id = ?",
    [ctx.orgId, ctx.countId, productId, locationId],
  );
  return rows.length ? { id: Number(rows[0].id), fills: parseFills(rows[0].pf) } : null;
}

/**
 * Count flow at phone width, with the database as ground truth for what was
 * saved. Everything here is optimistic UI: the screen updates at once and the
 * write lands in the background, so each save is awaited by polling the row,
 * not by trusting the screen.
 */
async function countFlow(context, sql, ctx) {
  console.log("\n--- count flow (phone) ---");
  const page = await context.newPage();
  await page.setViewportSize(PHONE);
  const seen = watchPage(page);
  const searchInput = page.locator('input[type="search"]');
  let startedByRun = false;

  /** Search the catalog (no barcode) and open the product's entry screen. */
  async function openProduct(name) {
    await searchInput.fill(name);
    const exact = new RegExp(`^${escapeRegExp(name)}$`);
    await page
      .getByRole("button")
      .filter({ has: page.locator("p").filter({ hasText: exact }) })
      .first()
      .click({ timeout: 10000 });
    await page.getByRole("heading", { level: 1, name, exact: true }).waitFor({ timeout: 10000 });
  }

  /** Save from the fill editor, return to the counting screen, wait for the DB row to change. */
  async function saveFills(productId, previous) {
    const key = (r) => (r ? JSON.stringify(r.fills) : "none");
    await page.getByRole("button", { name: "Save fill levels" }).click();
    await searchInput.waitFor({ state: "visible", timeout: 10000 });
    await pollUntil(async () => key(await readLine(sql, ctx, productId, ctx.active.id)) !== key(previous), 12000, 250);
    await page
      .getByText("Synced", { exact: true })
      .waitFor({ timeout: 8000 })
      .catch(() => {});
    await sleep(300);
    return readLine(sql, ctx, productId, ctx.active.id);
  }

  try {
    // (a) start or resume a count, enter a tenths location
    const okA = await check("(a) start or resume a count and enter a tenths location", async () => {
      await page.goto(`${BASE}/count`, { waitUntil: "domcontentloaded" });
      if (!(await waitForHydration(page, 'nav[aria-label="Primary"]'))) return { ok: false, detail: "/count never hydrated" };
      const resume = page.getByRole("link", { name: /Resume Count #\d+/ });
      const start = page.getByRole("button", { name: "Start a count" });
      if ((await resume.count()) > 0) {
        await resume.first().click();
      } else if ((await start.count()) > 0) {
        startedByRun = true;
        await start.first().click();
      } else {
        const review = await page.getByRole("link", { name: /Review Count #\d+/ }).count();
        return {
          ok: false,
          detail: review
            ? "the latest open count is submitted/reviewed (only 'Review Count' is offered) so there is no writable count and no Start button"
            : "neither 'Resume Count' nor 'Start a count' is on /count",
        };
      }
      const reached = await pollUntil(async () => /^\/count\/\d+\/scan$/.test(new URL(page.url()).pathname), 20000, 200);
      if (!reached) return { ok: false, detail: `did not reach /count/<id>/scan; at ${new URL(page.url()).pathname}` };
      ctx.countId = Number(/^\/count\/(\d+)\/scan$/.exec(new URL(page.url()).pathname)[1]);

      // Tag a count THIS run opened so it is identifiable; never touch one that already existed.
      if (startedByRun) {
        await sql.query(
          "UPDATE `count` SET notes = ? WHERE id = ? AND organization_id = ? AND (notes IS NULL OR notes = '')",
          [`[verify-ui-redesign ${new Date().toISOString()}]`, ctx.countId, ctx.orgId],
        );
      }

      const [locs] = await sql.query(
        "SELECT id, name, count_mode AS mode FROM location WHERE organization_id = ? AND active = 1 ORDER BY sort_order, id",
        [ctx.orgId],
      );
      ctx.locations = locs;
      const tenths =
        locs.find((l) => l.name === "Speed Rail" && l.mode === "tenths") ??
        locs.find((l) => l.name === "Back Bar" && l.mode === "tenths") ??
        locs.find((l) => l.mode === "tenths");
      if (!tenths) return { ok: false, detail: "no active tenths location in the DB" };
      ctx.active = tenths;

      await page.getByRole("heading", { name: "Which section?" }).waitFor({ timeout: 15000 });
      await shot(page, "auth-phone-flow-location-picker").catch(() => {});
      await page
        .locator("button")
        .filter({ has: page.getByText(tenths.name, { exact: true }) })
        .first()
        .click();
      await page.getByLabel(`Current location for this leg: ${tenths.name}`, { exact: true }).waitFor({ timeout: 10000 });
      return {
        ok: true,
        detail: `count #${ctx.countId} ${startedByRun ? "started by this run (left open, notes tagged)" : "resumed (pre-existing)"}; location ${tenths.name} (tenths)`,
      };
    });

    if (okA) {
      // (f) the active location is locked: no free-switch dropdown
      await check("(f) active location is locked: no location dropdown on the scan screen", async () => {
        const selects = await page.locator("select").count();
        const combos = await page.getByRole("combobox").count();
        const picker = await page.getByRole("heading", { name: "Which section?" }).count();
        const pill = await page
          .getByLabel(`Current location for this leg: ${ctx.active.name}`, { exact: true })
          .isVisible();
        const finish = await page.getByText("Finish section").count();
        const ok = selects === 0 && combos === 0 && picker === 0 && pill && finish > 0;
        return {
          ok,
          detail: `select=${selects}, combobox=${combos}, picker heading=${picker}, locked pill visible=${pill}, 'Finish section'=${finish}`,
        };
      });

      // (d) stray-bottle modal: no preselected destination, excludes the locked location
      await check("(d) stray-bottle modal preselects no destination and omits the active location", async () => {
        await page.getByRole("button", { name: "Count a stray bottle elsewhere" }).click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor({ timeout: 5000 });
        const prompt = await dialog.getByText("Pick a destination section first", { exact: false }).isVisible();
        const selected = await dialog.locator("button").evaluateAll(
          (els) => els.filter((e) => /(^|\s)bg-accent(\s|$)/.test(e.className)).length,
        );
        const activeListed = await dialog.getByRole("button", { name: ctx.active.name, exact: true }).count();
        const others = ctx.locations.filter((l) => l.id !== ctx.active.id);
        let pills = 0;
        for (const l of others) pills += (await dialog.getByRole("button", { name: l.name, exact: true }).count()) > 0 ? 1 : 0;
        await shot(page, "auth-phone-flow-stray-modal").catch(() => {});
        await dialog.getByRole("button", { name: "Close modal" }).click();
        await dialog.waitFor({ state: "hidden", timeout: 5000 });
        const ok = prompt && selected === 0 && activeListed === 0 && others.length > 0 && pills === others.length;
        return {
          ok,
          detail: `'Pick a destination' prompt=${prompt}, selected pills=${selected}, ${ctx.active.name} offered=${activeListed}, other sections offered=${pills}/${others.length}`,
        };
      });
    } else {
      notRun("(f) active location is locked", "not reached: (a) failed");
      notRun("(d) stray-bottle modal", "not reached: (a) failed");
    }

    // (b) the no-double-count regression (commit 40e20e3, lib/fill-save.ts planFillSave)
    let product = null;
    let lineAfterB1 = null;
    let okB1 = false;
    let okB2 = false;
    if (okA) {
      const [usedRows] = await sql.query("SELECT product_id AS pid FROM count_line WHERE organization_id = ? AND count_id = ?", [
        ctx.orgId,
        ctx.countId,
      ]);
      const used = new Set(usedRows.map((r) => Number(r.pid)));
      const [all] = await sql.query("SELECT id, name, brand, subcategory, category, unit_type AS ut, active FROM product WHERE organization_id = ?", [
        ctx.orgId,
      ]);
      const lc = (s) => (s ?? "").toLowerCase();
      product =
        all
          .filter((p) => p.active && p.ut === "bottle" && lc(p.category) !== "beer" && !used.has(Number(p.id)))
          .filter((p) => all.filter((o) => lc(o.name) === lc(p.name)).length === 1)
          .find(
            (p) =>
              all.filter((o) => [o.name, o.brand, o.subcategory].some((f) => lc(f).includes(lc(p.name)))).length <= 15,
          ) ?? null;
    }

    if (okA && product) {
      product = { id: Number(product.id), name: product.name };
      okB1 = await check(`(b1) fill 0.3 via catalog search saves exactly [0.3] (${product.name})`, async () => {
        await openProduct(product.name);
        await page.getByRole("button", { name: "30 percent full", exact: true }).click();
        await page.getByRole("button", { name: /^\+ Add bottle to line/ }).click();
        await shot(page, "auth-phone-flow-fill-entry").catch(() => {});
        const line = await saveFills(product.id, null);
        lineAfterB1 = line;
        return {
          ok: Boolean(line) && sameFills(line.fills, [0.3]),
          detail: line ? `count_line #${line.id} (count #${ctx.countId}) partial_fills=${showFills(line.fills)}` : "no count_line row was written",
        };
      });

      if (okB1) {
        okB2 = await check("(b2) reopen and add 0.8 saves [0.3, 0.8], not [0.3, 0.3, 0.8]", async () => {
          await openProduct(product.name);
          await page.getByRole("button", { name: "Inspect bottle 1: 30 percent full", exact: true }).waitFor({ timeout: 5000 });
          await page.getByRole("button", { name: "80 percent full", exact: true }).click();
          await page.getByRole("button", { name: /^\+ Add bottle to line/ }).click();
          const line = await saveFills(product.id, lineAfterB1);
          const dbl = line && sameFills(line.fills, [0.3, 0.3, 0.8]);
          return {
            ok: Boolean(line) && sameFills(line.fills, [0.3, 0.8]),
            detail: line
              ? `partial_fills=${showFills(line.fills)}${dbl ? " (existing fills were re-sent through the append path: 40e20e3 has regressed)" : ""}`
              : "count_line row vanished",
          };
        });
      } else {
        notRun("(b2) add 0.8 to an existing fill", "not reached: (b1) failed");
      }

      if (okB2) {
        await check("(b3) editing an existing fill replaces it: [0.3, 0.8] becomes [0.7, 0.8]", async () => {
          await openProduct(product.name);
          await page.getByRole("button", { name: "Inspect bottle 1: 30 percent full", exact: true }).click();
          await page.getByRole("button", { name: "70 percent full", exact: true }).click();
          await page.getByRole("button", { name: "Update bottle #1" }).click();
          const before = await readLine(sql, ctx, product.id, ctx.active.id);
          const line = await saveFills(product.id, before);
          const blocked = await page.getByText("hasn't finished syncing").count();
          return {
            ok: Boolean(line) && sameFills(line.fills, [0.7, 0.8]),
            detail: line
              ? `partial_fills=${showFills(line.fills)}${blocked ? "; UI refused: 'line hasn't finished syncing' (lineId never adopted)" : ""}`
              : "count_line row vanished",
          };
        });
      } else {
        notRun("(b3) edit an existing fill (replace path)", "not reached: (b2) failed");
      }
    } else {
      const why = okA ? "no active, uniquely named, non-beer bottle product without a line in this count was found" : "not reached: (a) failed";
      if (okA) record("(b) a catalog product is available for the fill regression", false, why);
      else notRun("(b) no-double-count regression", why);
    }

    // (c) sealed entry reachable from a tenths location; SET button shows before/after live
    if (okB1) {
      await check("(c) sealed entry is reachable in a tenths location and the SET button shows was/delta live", async () => {
        await openProduct(product.name);
        const sealedLabel = await page.getByText("Sealed bottles here", { exact: true }).isVisible();
        const tablist = page.getByRole("tablist", { name: "Entry mode" });
        const tabShown = (await tablist.count()) > 0;
        if (!tabShown) {
          return { ok: false, detail: `'Sealed bottles here'=${sealedLabel}; no 'Entry mode' tablist although the line exists (canSet needs a server lineId)` };
        }
        await tablist.getByRole("tab", { name: "Set exact count (=)" }).click();
        const eaches = page.locator('input[aria-label="Eaches"]');
        const cur = Number(await eaches.inputValue());
        const button = page.getByRole("button", { name: /Save correction/ });
        const before = (await button.innerText()).replace(/\s+/g, " ").trim();
        await eaches.fill(String(cur + 3));
        const after = (await button.innerText()).replace(/\s+/g, " ").trim();
        const wantDelta = new RegExp(`was\\s+${cur}\\s*ea\\s*·\\s*\\+3`, "i");
        await shot(page, "auth-phone-flow-sealed-set").catch(() => {});
        // Nothing saved: leave without tapping Save correction. The typed value is unsaved, so
        // Back must ask first (inline row, not a modal) — Keep editing must preserve what was
        // typed, and only Discard may actually leave.
        const back = page.getByRole("button", { name: `Back to ${ctx.active.name}` });
        const prompt = page.getByRole("group", { name: "Discard unsaved entry?" });
        await back.click();
        const askedToDiscard = await prompt.isVisible().catch(() => false);
        let keptValue = false;
        if (askedToDiscard) {
          await prompt.getByRole("button", { name: "Keep editing" }).click();
          keptValue = (await eaches.inputValue()) === String(cur + 3);
          await back.click();
          await prompt.getByRole("button", { name: "Discard" }).click();
        }
        const left = askedToDiscard
          ? await tablist.waitFor({ state: "hidden", timeout: 3000 }).then(() => true, () => false)
          : false;
        return {
          ok: sealedLabel && before !== after && wantDelta.test(after) && askedToDiscard && keptValue && left,
          detail:
            `'Sealed bottles here'=${sealedLabel}; button "${before}" -> "${after}"; ` +
            `discard row shown=${askedToDiscard}; typed value kept after Keep editing=${keptValue}; left after Discard=${left}`,
        };
      });
    } else {
      notRun("(c) sealed entry / SET button consequence", okA ? "not reached: (b1) failed, so there is no line to correct" : "not reached: (a) failed");
    }

    // (e) catalog lookup: no enroll button, has a scan affordance
    await check("(e) catalog search has no 'Add new product to catalog' and has 'Scan barcode to find product'", async () => {
      const catalog = await context.newPage();
      try {
        await catalog.setViewportSize(PHONE);
        await catalog.goto(`${BASE}/count/catalog`, { waitUntil: "domcontentloaded" });
        if (!(await waitForHydration(catalog, 'input[type="search"]'))) return { ok: false, detail: "/count/catalog never hydrated" };
        const addText = await catalog.getByText(/add new product/i).count();
        const addLabel = await catalog.locator('[aria-label*="add new product" i]').count();
        const scan = await catalog.locator('[aria-label="Scan barcode to find product"]').count();
        await shot(catalog, "auth-phone-flow-catalog-lookup").catch(() => {});
        return { ok: addText === 0 && addLabel === 0 && scan === 1, detail: `'add new product' text=${addText}, aria-label=${addLabel}; scan affordance=${scan}` };
      } finally {
        await catalog.close().catch(() => {});
      }
    });

    // The whole flow, taken together: nothing may have thrown, been blocked by CSP, or 5xx'd.
    if (okA) {
      const csp = await cspViolations(page);
      const noisy = [...seen.console, ...seen.pageerror];
      record(
        "count flow raises no CSP violations, console/page errors or 5xx",
        csp.length === 0 && noisy.length === 0 && seen.failed.length === 0,
        [...csp, ...noisy, ...seen.failed].join(" | ").slice(0, 500),
      );
    }
    if (okA) {
      console.log(
        `  note: test data left behind, nothing deleted: count #${ctx.countId} (${startedByRun ? "opened by this run, tagged in notes" : "pre-existing, resumed"})` +
          `${product ? `; one count_line for "${product.name}" in ${ctx.active.name}` : ""}`,
      );
    }
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Row edit must be a real <button>, never an onClick on the <tr> (AGENTS.md
 * "Row-level edit"). React handlers are not DOM attributes, so `tr[onclick]`
 * can never match; the handler is read off the node's React props instead,
 * which only exist once the row is hydrated (an un-hydrated row is reported as
 * inconclusive rather than clean). The Edit form is opened but never saved.
 */
async function officeEditChecks(context, route, noun) {
  const label = `[desktop] ${route}`;
  const page = await context.newPage();
  try {
    await page.setViewportSize(DESKTOP);
    const seen = watchPage(page);
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
    if (!(await waitForHydration(page, "main"))) {
      record(`${label} edit affordance checks`, false, "main never hydrated");
      return;
    }
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll("tbody tr")].map((tr) => {
        const propsKey = Object.keys(tr).find((k) => k.startsWith("__reactProps"));
        return {
          hydrated: Boolean(propsKey),
          onClick: propsKey ? typeof tr[propsKey]?.onClick === "function" : false,
          tabindex: tr.getAttribute("tabindex"),
          editButtons: [...tr.querySelectorAll("button")]
            .map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "")
            .filter((t) => /^Edit\b/.test(t)),
        };
      }),
    );
    const withEdit = rows.filter((r) => r.editButtons.length > 0);
    if (rows.length === 0 || withEdit.length === 0) {
      notRun(`${label} edit affordance checks`, `no ${noun} rows with an Edit control to inspect (${rows.length} table rows)`);
      return;
    }
    const unhydrated = rows.filter((r) => !r.hydrated).length;
    const rowClick = rows.filter((r) => r.onClick).length;
    const rowTab = rows.filter((r) => r.tabindex !== null).length;
    record(
      `${label} every ${noun} row's edit affordance is a real <button>, not a <tr onClick> / tabIndex row`,
      unhydrated === 0 && rowClick === 0 && rowTab === 0,
      `${withEdit.length}/${rows.length} rows have an Edit <button>; tr onClick=${rowClick}, tr tabindex=${rowTab}, unhydrated rows (inconclusive)=${unhydrated}`,
    );

    const editButton = page.locator("tbody").getByRole("button", { name: /^Edit\b/ }).first();
    const aria = (await editButton.getAttribute("aria-label")) ?? "";
    const subject = aria.replace(/^Edit\s+/, "").trim();
    await editButton.click();
    let headingOk = false;
    try {
      await page.getByRole("heading", { name: `Edit ${subject}`, exact: true }).waitFor({ state: "visible", timeout: 5000 });
      headingOk = subject.length > 0;
    } catch {
      headingOk = false;
    }
    record(
      `${label} edit form heading names its subject ("Edit <${noun} name>")`,
      headingOk,
      headingOk ? `heading "Edit ${subject}"` : `no heading "Edit ${subject}" after clicking "${aria}"`,
    );
    await sleep(300);
    await shot(page, `auth-desktop-${route.replace(/^\//, "").replace(/\//g, "-")}-edit`).catch(() => {});
    const csp = await cspViolations(page);
    const noisy = [...seen.console, ...seen.pageerror];
    record(
      `${label} opening the edit form raises no CSP violations, console errors or 5xx`,
      csp.length === 0 && noisy.length === 0 && seen.failed.length === 0,
      [...csp, ...noisy, ...seen.failed].join(" | ").slice(0, 400),
    );
  } catch (e) {
    record(`${label} edit affordance checks`, false, `threw: ${firstLine(e)}`);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * The invoice review page embeds the source PDF in an <iframe> at
 * /api/invoices/<id>/file, which needs three things to line up: the page must
 * render the frame, the file route must answer 200 with Content-Disposition:
 * inline (an `attachment` would download instead of preview), and neither the
 * page CSP nor X-Frame-Options may block the frame.
 *
 * Deliberately NOT `SELECT id FROM invoice ORDER BY id LIMIT 1`: the invoice
 * page renders the review form (and so the iframe) only for statuses other than
 * uploaded/processing, and the query is scoped to the signed-in organization.
 */
async function invoicePreview(context, sql, ctx) {
  console.log("\n--- invoice preview (desktop) ---");
  const [rows] = await sql.query(
    "SELECT id, status FROM invoice WHERE organization_id = ? AND status NOT IN ('uploaded','processing') ORDER BY id LIMIT 1",
    [ctx.orgId],
  );
  if (rows.length === 0) {
    const [[{ n }]] = await sql.query("SELECT COUNT(*) AS n FROM invoice WHERE organization_id = ?", [ctx.orgId]);
    if (Number(n) === 0) {
      notRun("invoice preview: no invoice in DB, not exercised", "the invoice table is empty for this organization; the iframe and Content-Disposition were NOT checked");
    } else {
      notRun(
        "invoice preview: no reviewable invoice in DB, not exercised",
        `${n} invoice(s) exist but all are uploaded/processing, which render no review form or iframe; the iframe and Content-Disposition were NOT checked`,
      );
    }
    return;
  }
  const id = Number(rows[0].id);
  const filePath = `/api/invoices/${id}/file`;
  const page = await context.newPage();
  try {
    await page.setViewportSize(DESKTOP);
    const seen = watchPage(page);
    let frameDoc = null;
    page.on("response", (r) => {
      if (r.url().startsWith(BASE) && new URL(r.url()).pathname === filePath && r.request().resourceType() === "document") {
        frameDoc = { status: r.status(), disposition: r.headers()["content-disposition"] ?? "" };
      }
    });
    await page.goto(`${BASE}/office/invoices/${id}`, { waitUntil: "domcontentloaded" });
    await waitForHydration(page, "main");
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    const frame = page.locator(`iframe[src="${filePath}"], object[data="${filePath}"]`);
    const frames = await frame.count();
    const tag = frames ? await frame.first().evaluate((el) => el.tagName.toLowerCase()) : "none";
    record(
      `invoice #${id} (${rows[0].status}) review page embeds the source file in an <iframe>/<object> -> ${filePath}`,
      frames > 0,
      `${frames} match(es), element <${tag}>`,
    );

    const fetched = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: "same-origin" });
      const out = { status: r.status, disposition: r.headers.get("content-disposition") ?? "", type: r.headers.get("content-type") ?? "" };
      await r.body?.cancel();
      return out;
    }, filePath);
    record(
      `invoice #${id} file: same-origin fetch is 200 with Content-Disposition inline`,
      fetched.status === 200 && /^inline/i.test(fetched.disposition),
      `fetch status ${fetched.status}, disposition "${fetched.disposition.slice(0, 80)}", type ${fetched.type}; the frame's own request: ${
        frameDoc ? `${frameDoc.status} ${frameDoc.disposition.slice(0, 40)}` : "not observed"
      }`,
    );

    await sleep(300);
    const csp = await cspViolations(page);
    const noisy = [...seen.console, ...seen.pageerror];
    record(
      `invoice #${id} preview raises no CSP/frame violations, console errors or 5xx`,
      csp.length === 0 && noisy.length === 0 && seen.failed.length === 0,
      [...csp, ...noisy, ...seen.failed].join(" | ").slice(0, 400),
    );
  } catch (e) {
    record(`invoice #${id} preview checks`, false, `threw: ${firstLine(e)}`);
  } finally {
    await page.close().catch(() => {});
  }
}

async function authenticated(browser) {
  if (!process.env.CHECK_EMAIL || !process.env.CHECK_PASSWORD) {
    console.log("\nSKIP authenticated checks: CHECK_EMAIL / CHECK_PASSWORD not set");
    return;
  }
  console.log("\n--- authenticated checks ---");
  if (!process.env.DATABASE_URL) {
    record(
      "authenticated checks have a database to read ground truth from",
      false,
      "DATABASE_URL is not set (run with node --env-file=.env.local); the authenticated checks need it, so none were run",
    );
    return;
  }
  // Before the sign-in (which writes a session row to the app's database) and
  // before this script's own connection: both must be aimed at a local target
  // the operator named for this run.
  try {
    assertLocalTarget(process.env.DATABASE_URL, BASE);
  } catch (e) {
    console.error(`\n${e.message}\n`);
    record(
      "authenticated checks run against an explicitly allowed local target",
      false,
      "refused (see the message above); none of the authenticated checks were run",
    );
    return;
  }

  // One context, one sign-in: the viewport is switched per page. Several
  // contexts would each need a /sign-in call, and Better Auth rate-limits it.
  const context = await browser.newContext({ viewport: PHONE, ignoreHTTPSErrors: true });
  await installDiagnostics(context);
  let sql = null;
  try {
    if (!(await signIn(context))) return;

    sql = await mysql.createConnection(process.env.DATABASE_URL);
    const [users] = await sql.query("SELECT id, role, active, organization_id AS orgId FROM `user` WHERE email = ?", [
      process.env.CHECK_EMAIL,
    ]);
    const who = users[0];
    record(
      "the signed-in account exists in the database these checks read from",
      Boolean(who) && Boolean(who.active),
      who ? `role ${who.role}, organization ${who.orgId}${who.role === "owner" ? "" : " (not an owner: office routes may redirect)"}` : "not found; DATABASE_URL may point at a different database than the server",
    );
    if (!who || !who.active) return;
    const ctx = { orgId: Number(who.orgId), countId: null, active: null, locations: [] };

    await countFlow(context, sql, ctx);
    await routeSweep(context, sql, ctx);
    console.log("\n--- office edit affordances (desktop) ---");
    await officeEditChecks(context, "/office/locations", "location");
    await officeEditChecks(context, "/office/vendors", "vendor");
    await invoicePreview(context, sql, ctx);
  } catch (e) {
    record("authenticated section ran to completion", false, `threw: ${firstLine(e)}`);
  } finally {
    await sql?.end().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    await unauthenticated(browser);
    await authenticated(browser);
  } finally {
    await browser.close();
  }
  const passed = results.filter((r) => r.ok && !r.notRun);
  const failed = results.filter((r) => !r.ok && !r.notRun);
  const skipped = results.filter((r) => r.notRun);
  await mkdir(SHOT_DIR, { recursive: true });
  await writeFile(path.join(SHOT_DIR, "results.json"), JSON.stringify(results, null, 2));
  console.log(`\n${passed.length} passed, ${failed.length} failed, ${skipped.length} not run`);
  process.exit(failed.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
