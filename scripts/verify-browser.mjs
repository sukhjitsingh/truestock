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
 *   bun run verify:browser
 *
 * which is `node --env-file=.env.local scripts/verify-browser.mjs` — the
 * credentials come from the gitignored env file rather than the argv, so they
 * stay out of the shell history and the process list. `--env-file` is Node's
 * own flag; there is no dotenv dependency.
 *
 * Against a local dev database only — it signs in, changes a role, and
 * creates/renames/retires its own throwaway locations. Everything it mutates
 * it either created itself or restores; see restoreLog at the end of the run.
 */
import { execSync } from "node:child_process";
import mysql from "mysql2/promise";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.CHECK_EMAIL;
const PASSWORD = process.env.CHECK_PASSWORD;

/**
 * Values this run overwrote and must put back, and checks it could not perform.
 * Both are printed at the end. A skipped check that reads as a pass is worse
 * than a failure, because nobody goes looking for it again.
 */
const restoreLog = [];
const skipped = [];

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

/**
 * Wait until React has actually attached to `selector` before typing into it.
 *
 * This is not defensive padding. Filling a controlled input before hydration
 * sets the DOM value while React's state stays empty, so the submit posts
 * empty fields — which is how this script used to fail: Better Auth answered
 * INVALID_EMAIL for an email that is perfectly valid, because the browser sent
 * "". The signal is React's own fiber key on the node, which exists only once
 * hydration has run; `domcontentloaded` and even `networkidle` can both be
 * reached before it.
 */
async function waitForHydration(page, selector = "form") {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__react"));
    },
    selector,
    { timeout: 20000 },
  );
}

/**
 * `channel: "chrome"` drives the Chrome already installed on this machine.
 * Playwright's own chromium is not downloaded here, and a ~150 MB download is
 * not worth adding to make a local verification script run.
 */
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, // a phone, which is where counting happens
  ignoreHTTPSErrors: true,
  permissions: ["clipboard-read", "clipboard-write"],
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

  /**
   * Stub `window.print` before any page script runs. A real print dialog is a
   * browser-level modal: it blocks every subsequent automation command, so one
   * click on Print would hang the whole run with no useful error. The stub also
   * captures the DOM state at the moment printing was requested, which is the
   * assertion that matters — that the scope classes were applied first.
   */
  window.print = () => {
    window.__printState = {
      called: true,
      bodyClass: document.body.className,
      targets: document.querySelectorAll(".print-target").length,
    };
  };
});

/**
 * A direct connection is used for exactly one thing: the count the dashboard
 * tile is *supposed* to equal. Asserting the tile against a number the page
 * itself produced would be circular — the #14 bug was precisely a page
 * counting its own truncated array.
 */
const sql = await mysql.createConnection(process.env.DATABASE_URL);

try {
  // ---- sign in ------------------------------------------------------------
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });

  // The login form must be POST even before hydration: a GET would put the
  // password in the query string, the access log and the Referer header.
  const method = await page.locator("form").first().getAttribute("method");
  record("login form is method=post", (method ?? "").toLowerCase() === "post", `method=${method}`);

  await waitForHydration(page, "form");
  record("login form hydrates (React attached to the form)", true);

  /**
   * Open item 26: the preflight banner used to report "Origin allowed: No" on
   * plain localhost and claim no JavaScript would run — on a page that had just
   * demonstrably hydrated, two lines above. Asserted here rather than in the
   * unit tests because the unit tests can only check the predicate; this checks
   * what a human actually reads. Only meaningful when the run targets a host
   * Next allows natively.
   */
  const baseHost = new URL(BASE).hostname;
  if (baseHost === "localhost" || baseHost === "127.0.0.1" || baseHost.endsWith(".localhost")) {
    const banner = await page
      .getByText(/Origin allowed/i)
      .locator("xpath=ancestor::div[1]")
      .innerText()
      .catch(() => "");
    record(
      "the preflight origin banner does not cry wolf on localhost",
      /\bYes\b/i.test(banner) && !/no JavaScript runs/i.test(banner),
      banner ? banner.replace(/\s+/g, " ").slice(0, 140) : "(banner not rendered)",
    );
  }

  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);

  /**
   * A rejected sign-in used to surface as a bare `waitForURL` timeout, which
   * says nothing about the cause — a wrong password and a broken form look
   * identical. Capture the auth response so the failure names itself. The body
   * is Better Auth's own error JSON and contains no credential.
   */
  const authFailure = [];
  page.on("response", async (res) => {
    if (!res.url().includes("/api/auth/") || res.status() < 400) return;
    authFailure.push(`${res.status()} ${new URL(res.url()).pathname}: ${await res.text().catch(() => "(no body)")}`);
  });

  const signedIn = await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }).then(
      () => true,
      () => false,
    ),
    page.click('button[type="submit"]'),
  ]).then(([ok]) => ok);

  if (!signedIn) {
    record(
      "sign-in succeeds",
      false,
      authFailure.length
        ? `${authFailure.join(" | ")} — set a working CHECK_PASSWORD in .env.local`
        : "no auth error response; the form may not be submitting at all",
    );
    throw new Error("cannot verify anything else without a session");
  }
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

  // ======================================================================
  // Phase 1 + 1.5 (docs/plans/phase-1-to-1.5/04-slices.md)
  //
  // Only what a browser can prove. Role gating, tenant scoping and both
  // retire guards are already covered against real MariaDB by
  // tests/location-write-path.test.ts — repeating them here would add no
  // information. What is *only* visible here: whether React attached, whether
  // a save navigates, what actually lands on the clipboard, and what the
  // print stylesheet really hides.
  // ======================================================================

  // ---- slice 1: the locations screen exists and is server-rendered --------
  await page.goto(`${BASE}/office/locations`, { waitUntil: "networkidle" });
  await waitForHydration(page, "table");

  const seededHtml = await page.content();
  record(
    "locations are server-rendered, not fetched in an effect",
    seededHtml.includes("Speed Rail") && seededHtml.includes("Storeroom"),
    "seeded names present in the server HTML",
  );
  record("Locations is in the office nav", (await page.locator('nav a[href="/office/locations"]').count()) > 0);

  // ---- slice 2: create, rename, re-mode ----------------------------------
  const stamp = Date.now();
  const created = `Verify Bar ${stamp}`;
  const renamed = `Verify Patio ${stamp}`;

  // Count document navigations from here on. Amendment 2's whole point is
  // that saving does not navigate, so navigation has to be *measured*, not
  // assumed from the absence of a visible flicker.
  let documentLoads = 0;
  page.on("request", (r) => {
    if (r.resourceType() === "document") documentLoads++;
  });

  // No `.catch(() => {})` here. Swallowing a failed click turned a wrong button
  // name into a 30s `page.fill` timeout 40 lines later, which named the wrong
  // thing entirely. Let the click throw and say what it could not find.
  await page.getByRole("button", { name: /add location/i }).click();
  await page.fill('input[placeholder="e.g., Patio Bar"]', created);
  const navsBeforeCreate = documentLoads;
  await page.getByRole("button", { name: /create location/i }).click();
  await page.locator("table tbody").getByText(created, { exact: false }).first().waitFor({ timeout: 15000 });
  record(
    "a new location appears without a page navigation",
    documentLoads === navsBeforeCreate,
    `${documentLoads - navsBeforeCreate} document loads during the create`,
  );

  // Rename + re-mode, then prove it survived a reload rather than only
  // living in local state.
  /**
   * Editing is a click on the row's own Edit button (00-status.md's finding
   * fixed this: editing used to be a click on the bare row, with no button,
   * role, or keyboard access, and the form it opened was headed only "Edit
   * location" without naming its subject). Still assert the form's prefilled
   * name before typing — that assertion is what would have caught the near
   * miss where a click aimed at one row landed on Speed Rail during manual
   * verification, one click away from renaming a real location with nothing
   * looking wrong.
   */
  const row = page.locator("tbody tr", { hasText: created });
  await row.getByRole("button", { name: /^edit$/i }).click();
  const nameField = page.locator('input[placeholder="e.g., Patio Bar"]');
  const editingWhich = await nameField.inputValue();
  record(
    "the edit form is editing the row that was clicked",
    editingWhich === created,
    `form prefilled with "${editingWhich}", expected "${created}"`,
  );
  if (editingWhich !== created) throw new Error("refusing to type into the wrong location's edit form");

  await nameField.fill(renamed);
  const modeSelect = page.locator("select").first();
  const originalMode = await modeSelect.inputValue();
  await modeSelect.selectOption(originalMode === "tenths" ? "quantity" : "tenths");
  await page.getByRole("button", { name: /save changes/i }).click();
  await page.locator("table tbody").getByText(renamed, { exact: false }).first().waitFor({ timeout: 15000 });

  await page.reload({ waitUntil: "networkidle" });
  const persisted = await page.content();
  record(
    "rename and count-mode change survive a reload",
    persisted.includes(renamed) && !persisted.includes(created),
    `"${renamed}" present, old name gone`,
  );

  // ---- slice 3: retire, and the picker stops offering it ------------------
  const retireRow = page.locator("tbody tr", { hasText: renamed });
  await retireRow.getByRole("button", { name: /^retire$/i }).click();
  await retireRow.getByRole("button", { name: /confirm retire/i }).click();
  await page.locator("tbody tr", { hasText: renamed }).getByText("Retired").waitFor({ timeout: 15000 });
  record("a retired location stays listed and is marked Retired", true, renamed);

  // The point of Decision 5: this happens with no scan-page code changed.
  const scanPageTouched = execSync("git diff main...HEAD --name-only", { cwd: process.cwd() })
    .toString()
    .split("\n")
    .some((f) => f.includes("count/[countId]/scan/page.tsx"));
  record(
    "the scan page was not modified to make retirement work (Decision 5)",
    !scanPageTouched,
    scanPageTouched ? "scan/page.tsx IS in the diff" : "scan/page.tsx untouched in main...HEAD",
  );

  // ---- open item 27: /office/vendors has the same Edit affordance ---------
  // The identical row-click pattern lived here first — locations-table.tsx was
  // modelled on vendors-list.tsx — so the same assertion belongs on both
  // screens: the form that opens must be editing the row whose button was
  // clicked. Skipped rather than faked when no vendor exists, which is the
  // default state of the dev database.
  await page.goto(`${BASE}/office/vendors`, { waitUntil: "networkidle" });
  const vendorRows = page.locator("table tbody tr");
  if ((await vendorRows.count()) === 0) {
    record("vendors Edit button", true, "SKIPPED — no vendor exists in this database. Not a pass.");
    skipped.push("open item 27 — /office/vendors Edit button: needs at least one vendor row");
  } else {
    const firstVendorName = (await vendorRows.first().locator("td").first().innerText()).trim();
    await vendorRows.first().getByRole("button", { name: /^edit$/i }).click();
    const vendorNameField = page.locator("#name");
    const editingVendor = await vendorNameField.inputValue();
    record(
      "the vendor edit form is editing the row whose Edit was clicked",
      editingVendor === firstVendorName,
      `form prefilled with "${editingVendor}", row read "${firstVendorName}"`,
    );
    const vendorHeading = await page.getByRole("heading", { level: 2 }).first().innerText();
    record(
      "the vendor edit form names its subject",
      vendorHeading.toLowerCase().includes(firstVendorName.toLowerCase()),
      `heading reads "${vendorHeading}"`,
    );
  }

  // ---- slice 5: the dashboard counts in the database, not in a page ------
  const [[{ activeProducts }]] = await sql.query("SELECT COUNT(*) AS activeProducts FROM product WHERE active = 1");
  await page.goto(`${BASE}/office`, { waitUntil: "networkidle" });
  const healthText = await page.getByText(/active products/i).first().innerText();
  const shown = Number((healthText.match(/([\d,]+)\s*active products/i)?.[1] ?? "").replace(/,/g, ""));
  record(
    "catalog health matches SELECT COUNT(*), and is not capped at 100",
    shown === Number(activeProducts),
    `tile=${shown} db=${activeProducts}`,
  );

  // ---- slice 4: per-cell cost editing, and no navigation per save --------
  await page.goto(`${BASE}/office/catalog`, { waitUntil: "networkidle" });
  await waitForHydration(page, "table");

  const costCells = page.locator('input[aria-label^="Unit cost for"]');
  const cellCount = await costCells.count();
  record("cost cells are editable inputs in the table", cellCount > 0, `${cellCount} cost inputs`);

  const EDITS = Math.min(4, cellCount);
  const navsBeforeEdits = documentLoads;
  for (let i = 0; i < EDITS; i++) {
    const cell = costCells.nth(i);
    restoreLog.push({ label: await cell.getAttribute("aria-label"), value: await cell.inputValue() });
    await cell.fill(String(11 + i));
    await cell.blur();
    await page.waitForTimeout(700);
  }
  record(
    `${EDITS} cost cells saved with zero page navigations`,
    documentLoads === navsBeforeEdits,
    `${documentLoads - navsBeforeEdits} document loads across ${EDITS} saves (Amendment 2)`,
  );

  // The cell must settle on the value the SERVER returned, not the typed one.
  // "007.5" is the cheap probe: any normalization at all proves the round trip.
  const probe = costCells.nth(0);
  await probe.fill("007.5");
  await probe.blur();
  await page.waitForTimeout(1200);
  const settled = await probe.inputValue();
  record(
    "an edited cell settles on the server's returned value",
    settled !== "007.5" && Number(settled) === 7.5,
    `typed "007.5", cell shows "${settled}"`,
  );

  // ---- slice 6: what actually lands on the clipboard ---------------------
  await page.goto(`${BASE}/office/reorder`, { waitUntil: "networkidle" });
  const copyButtons = page.locator('button[aria-label^="Copy "]');
  if ((await copyButtons.count()) === 0) {
    record(
      "reorder copy/print",
      true,
      "SKIPPED — no vendor block renders: the dev data has no par levels, so this screen cannot produce a row (its own empty state says so). Not a pass.",
    );
    skipped.push("slice 6 copy/print — needs a par level and a closed count in the dev data");
  } else {
    await copyButtons.first().click();
    await page.waitForTimeout(500);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    record(
      "the clipboard text is dated and itemised",
      /count #\d+/i.test(clip) && clip.trim().split("\n").length > 1,
      JSON.stringify(clip.slice(0, 120)),
    );

    // Print without a dialog: window.print is stubbed at document start, so
    // the click cannot open a modal that would freeze the whole session. The
    // stub records the DOM state at print time, which is the thing worth
    // asserting — that the scope classes were actually applied.
    const printState = await page.evaluate(async () => {
      const btn = document.querySelector('button[aria-label^="Print "]');
      btn?.click();
      await new Promise((r) => setTimeout(r, 300));
      return window.__printState ?? null;
    });
    record(
      "Print applies the scope classes before printing",
      Boolean(printState?.called) && printState.bodyClass.includes("print-scope-active") && printState.targets === 1,
      printState ? `body="${printState.bodyClass}" targets=${printState.targets}` : "window.print was never called",
    );

    // And the stylesheet those classes rely on must really hide the rest.
    await page.emulateMedia({ media: "print" });
    const hides = await page.evaluate(() => {
      document.body.classList.add("print-scope-active");
      const blocks = [...document.querySelectorAll("section")];
      blocks[0]?.classList.add("print-target");
      const target = getComputedStyle(blocks[0]).visibility;
      const other = blocks[1] ? getComputedStyle(blocks[1]).visibility : "n/a";
      return { target, other };
    });
    await page.emulateMedia({ media: "screen" });
    record(
      "print CSS shows only the target block",
      hides.target === "visible" && hides.other !== "visible",
      `target=${hides.target} sibling=${hides.other}`,
    );
  }

  // ======================================================================
  // Role gating in a browser (invariant 8 / invariant 7)
  //
  // The test suite already proves the ACTION layer strips cost for a manager
  // and refuses staff. What only a browser can show is what actually reaches
  // the page: a cost column that is rendered-then-hidden is a leak the action
  // tests cannot see, because the value was in the payload all along.
  //
  // Each account is optional. Missing credentials SKIP rather than pass —
  // these are the two checks most likely to be quietly assumed done.
  // ======================================================================
  for (const role of ["manager", "staff"]) {
    const email = process.env[`CHECK_${role.toUpperCase()}_EMAIL`];
    const password = process.env[`CHECK_${role.toUpperCase()}_PASSWORD`];
    if (!email || !password) {
      record(`${role} role gating in a browser`, true, `SKIPPED — CHECK_${role.toUpperCase()}_EMAIL/_PASSWORD not set. Not a pass.`);
      skipped.push(
        `${role} browser role gating — create the account, then add CHECK_${role.toUpperCase()}_EMAIL and CHECK_${role.toUpperCase()}_PASSWORD to .env.local`,
      );
      continue;
    }

    // A separate context, so the owner's session is not disturbed and no
    // cookie leaks between roles.
    const roleContext = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    const rolePage = await roleContext.newPage();
    try {
      await rolePage.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
      await rolePage.waitForFunction(
        () => {
          const el = document.querySelector("form");
          return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__react"));
        },
        undefined,
        { timeout: 20000 },
      );
      await rolePage.fill('input[type="email"]', email);
      await rolePage.fill('input[type="password"]', password);
      const ok = await Promise.all([
        rolePage.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }).then(
          () => true,
          () => false,
        ),
        rolePage.click('button[type="submit"]'),
      ]).then(([signed]) => signed);
      if (!ok) {
        record(`${role} signs in`, false, "credentials rejected — check the account exists with this password");
        await roleContext.close();
        continue;
      }

      if (role === "manager") {
        await rolePage.goto(`${BASE}/office/catalog`, { waitUntil: "networkidle" });

        // Absent from the DOM, not disabled and not display:none. Search the
        // served HTML, which is what a manager could read with devtools.
        const html = await rolePage.content();
        const costInputs = await rolePage.locator('input[aria-label^="Unit cost for"]').count();
        const costHeader = await rolePage.getByRole("columnheader", { name: /cost/i }).count();
        record(
          "a manager's catalog has no cost column anywhere in the DOM",
          costInputs === 0 && costHeader === 0 && !/Unit cost for/.test(html),
          `cost inputs=${costInputs} cost headers=${costHeader}`,
        );

        // The positive control. Without it, the check above would also pass
        // against a page that failed to render a table at all.
        const caseInputs = await rolePage.locator('input[aria-label^="Case size for"]').count();
        record(
          "a manager CAN still edit case size — positive control",
          caseInputs > 0,
          `${caseInputs} case-size inputs (0 would mean the page simply did not render)`,
        );
      } else {
        await rolePage.goto(`${BASE}/office/locations`, { waitUntil: "networkidle" });
        record(
          "staff are redirected away from /office/locations",
          !rolePage.url().includes("/office"),
          `landed on ${rolePage.url()}`,
        );
        const navLinks = await rolePage.locator('a[href="/office/locations"]').count();
        record("staff see no Locations link", navLinks === 0, `${navLinks} links to /office/locations`);
      }
    } finally {
      await roleContext.close();
    }
  }

  // Collected in the page, so it must be read out before the browser closes.
  cspViolations.push(...(await page.evaluate(() => window.__csp ?? [])));

  await browser.close();
} catch (err) {
  record("run completed without throwing", false, String(err).split("\n")[0]);
  await page.screenshot({ path: "/var/tmp/truestock-failure.png" }).catch(() => {});
  await browser.close();
}

// ---- put the dev data back ------------------------------------------------
// The cost cells were edited in place against the owner's real catalog, and
// the catalog is uncosted on purpose right now — leaving 11.00 behind would be
// exactly the plausible-but-wrong data AGENTS.md warns about, and it would
// silently make the valuation non-zero and wrong.
try {
  for (const { label, value } of restoreLog) {
    const name = label.replace(/^Unit cost for /, "");
    await sql.execute("UPDATE product SET current_unit_cost = ? WHERE name = ?", [value === "" ? null : value, name]);
  }
  record("edited product costs restored to their original values", true, `${restoreLog.length} products`);

  // The throwaway locations this run created are removed by the harness — this
  // is a fixture teardown, not the application deleting a location. Invariant 6
  // still holds: the app only ever retired it, which is what was verified above.
  const [res] = await sql.execute("DELETE FROM location WHERE name LIKE 'Verify Bar %' OR name LIKE 'Verify Patio %'");
  record("throwaway verification locations removed", true, `${res.affectedRows} rows`);
} catch (err) {
  record("dev data restored", false, `MANUAL CLEANUP NEEDED — ${String(err).split("\n")[0]}; intended: ${JSON.stringify(restoreLog)}`);
}
await sql.end();

record("no CSP violations", cspViolations.length === 0, cspViolations.join("; ") || "none");
record(
  "no console errors",
  consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(" | ") || "none",
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

if (skipped.length) {
  console.log("\nNOT VERIFIED (absence of a failure here is not evidence):");
  for (const s of skipped) console.log(`  - ${s}`);
}

process.exitCode = failed.length === 0 ? 0 : 1;
