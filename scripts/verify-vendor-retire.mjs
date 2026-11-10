/**
 * Browser proof for "retire a vendor" (open item #49, slices 2 + 3).
 *
 *   BASE_URL=http://localhost:3201 VERIFY_ALLOW_DB=127.0.0.1:3307/truestock \
 *     node --env-file=.env.local scripts/verify-vendor-retire.mjs
 *
 * Same guards and patterns as scripts/verify-browser.mjs: loopback-only
 * DATABASE_URL/BASE_URL, VERIFY_ALLOW_DB, hydration polled through
 * page.evaluate (CSP-safe), cleanup by recorded id + organization only.
 * Screenshots go to SHOTS_DIR (default below).
 */
import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mysql from "mysql2/promise";
import { chromium } from "playwright";
import { assertLocalTarget } from "./lib/assert-local-target.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS_DIR ?? path.join(os.tmpdir(), "truestock-vendor-retire-shots");
const OWNER = { email: process.env.CHECK_EMAIL, password: process.env.CHECK_PASSWORD };
const MANAGER = { email: process.env.CHECK_MANAGER_EMAIL, password: process.env.CHECK_MANAGER_PASSWORD };
if (!OWNER.email || !OWNER.password) {
  console.error("CHECK_EMAIL and CHECK_PASSWORD must be set (see verify-browser.mjs).");
  process.exit(2);
}
try {
  assertLocalTarget(process.env.DATABASE_URL, BASE);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitForHydration(page, selector = "form", timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__react"));
    }, selector);
    if (ok) return;
    if (Date.now() >= deadline) throw new Error(`"${selector}" never hydrated`);
    await page.waitForTimeout(100);
  }
}

// A button/body element hydrates too; use body children when no form exists.
async function waitForBodyHydration(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await page.evaluate(() => {
      const els = [...document.querySelectorAll("main button, main a, main input")];
      return els.some((el) => Object.keys(el).some((k) => k.startsWith("__react")));
    });
    if (ok) return;
    if (Date.now() >= deadline) throw new Error("page never hydrated");
    await page.waitForTimeout(100);
  }
}

async function signIn(page, { email, password }) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await waitForHydration(page, "form");
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
  shots.push(path.join(SHOTS, name));
}
const shots = [];

const FIXTURE_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
    "xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \n" +
    "trailer<</Size 4/Root 1 0 R>>\nstartxref\n160\n%%EOF\n",
);
const invoiceRoot = () => path.resolve((process.env.INVOICE_STORAGE_DIR ?? "").trim() || "./var/invoices");

await mkdir(SHOTS, { recursive: true });
const sql = await mysql.createConnection(process.env.DATABASE_URL);
const [[ownerRow]] = await sql.query("SELECT id, organization_id AS orgId FROM user WHERE email = ?", [OWNER.email]);
if (!ownerRow) {
  console.error("owner has no user row in this database");
  process.exit(2);
}
const orgId = ownerRow.orgId;
const runId = Date.now().toString(36);
const VENDOR_NAME = `Retire Test Vendor ${runId}`;
const PRODUCT_A = `Retire Test Product A ${runId}`;
const PRODUCT_B = `Retire Test Product B ${runId}`;

const count = async (table) =>
  (await sql.query(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE organization_id = ?`, [orgId]))[0][0].n;
const before = { vendor: await count("vendor"), product: await count("product"), invoice: await count("invoice") };

let vendorId = null;
const productIds = [];
let invoiceId = null;
let invoiceFileKey = null;
const extraVendorIds = [];

const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

try {
  // ---- seed ---------------------------------------------------------------
  const [[closed]] = await sql.query(
    "SELECT COUNT(*) AS n FROM `count` WHERE organization_id = ? AND status = 'closed'",
    [orgId],
  );
  record("precondition: a closed count exists (reorder needs one)", closed.n > 0, `${closed.n} closed`);

  const [v] = await sql.execute("INSERT INTO vendor (organization_id, name) VALUES (?, ?)", [orgId, VENDOR_NAME]);
  vendorId = v.insertId;
  for (const name of [PRODUCT_A, PRODUCT_B]) {
    const [p] = await sql.execute(
      "INSERT INTO product (organization_id, name, category, unit_type, size_ml, vendor_id, active) VALUES (?, ?, 'Spirits', 'bottle', 750, ?, 1)",
      [orgId, name, vendorId],
    );
    productIds.push(p.insertId);
    // Par 5 with no counted stock: on-hand 0 <= threshold, so it is short.
    await sql.execute(
      "INSERT INTO product_par (organization_id, product_id, location_id, par_level) VALUES (?, ?, NULL, 5)",
      [orgId, p.insertId],
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const retention = `${Number(today.slice(0, 4)) + 3}${today.slice(4)}`;
  const [inv] = await sql.execute(
    `INSERT INTO invoice (organization_id, vendor_id, status, source, file_sha256, file_size_bytes,
        invoice_date, invoice_number, total_gross, total_discount, total_net, currency, retention_until)
     VALUES (?, ?, 'needs_review', 'pdf', ?, 100, ?, ?, '100.00', '0.00', '100.00', 'USD', ?)`,
    [orgId, vendorId, "c".repeat(64), today, `RETIRE-${runId}`, retention],
  );
  invoiceId = inv.insertId;
  invoiceFileKey = path.posix.join(String(orgId), `${invoiceId}.pdf`);
  await mkdir(path.join(invoiceRoot(), String(orgId)), { recursive: true });
  await writeFile(path.join(invoiceRoot(), invoiceFileKey), FIXTURE_PDF);
  await sql.execute(
    "UPDATE invoice SET file_path = ?, file_sha256 = ?, file_size_bytes = ? WHERE id = ? AND organization_id = ?",
    [invoiceFileKey, createHash("sha256").update(FIXTURE_PDF).digest("hex"), FIXTURE_PDF.length, invoiceId, orgId],
  );
  await sql.execute(
    `INSERT INTO invoice_line (organization_id, invoice_id, line_number, line_type, vendor_item_code, description,
        quantity, uom, unit_cost, extended_cost, raw_gross, raw_discount, raw_net, exception_flags, matched_product_id, match_method)
     VALUES (?, ?, 1, 'product', ?, 'Retire test line', '12.000', 'each', '8.3300', '100.00', '100.00', '0.00', '100.00', NULL, ?, 'vendor_alias_code')`,
    [orgId, invoiceId, `RT-${runId}`, productIds[0]],
  );

  await signIn(page, OWNER);
  record("owner signs in", true, page.url());

  // ---- 2. vendors: arm / cancel / confirm ---------------------------------
  await page.goto(`${BASE}/office/vendors`, { waitUntil: "networkidle" });
  await waitForBodyHydration(page);
  const row = () => page.locator("tbody tr", { hasText: VENDOR_NAME }).first();
  await page.getByRole("button", { name: `Retire ${VENDOR_NAME}`, exact: true }).click();
  const warn = await row().innerText();
  await shot(page, "01-vendors-retire-armed.png");
  record("armed retire warning names '2 products'", /2 products still use this vendor/.test(warn), warn.replace(/\s+/g, " ").slice(-120));

  await page.getByRole("button", { name: `Cancel retiring ${VENDOR_NAME}`, exact: true }).click();
  await page.waitForTimeout(300);
  const [[vAfterCancel]] = await sql.query("SELECT active FROM vendor WHERE id = ?", [vendorId]);
  record(
    "Cancel changes nothing (still active, Retire button back)",
    vAfterCancel.active === 1 && (await page.getByRole("button", { name: `Retire ${VENDOR_NAME}`, exact: true }).count()) === 1,
  );

  await page.getByRole("button", { name: `Retire ${VENDOR_NAME}`, exact: true }).click();
  await page.getByRole("button", { name: `Confirm retiring ${VENDOR_NAME}`, exact: true }).click();
  await page.getByRole("button", { name: `Reactivate ${VENDOR_NAME}`, exact: true }).waitFor({ timeout: 20000 });
  await shot(page, "02-vendors-retired.png");
  const rowText = await row().innerText();
  record("retired: Retired badge shown", /Retired/i.test(rowText));
  record("retired: Reactivate button present", true);
  record("retired: no Edit button", (await page.getByRole("button", { name: `Edit ${VENDOR_NAME}`, exact: true }).count()) === 0);
  const [[vRetired]] = await sql.query("SELECT active FROM vendor WHERE id = ?", [vendorId]);
  record("DB: vendor.active = 0", vRetired.active === 0);

  // ---- 3. catalog ---------------------------------------------------------
  await page.goto(`${BASE}/office/catalog`, { waitUntil: "networkidle" });
  await waitForBodyHydration(page);
  console.log("catalog header:", (await page.locator("main").innerText()).match(/\d+ active products · \d+ need attention/)?.[0]);
  await page.getByLabel("Search catalog").fill(PRODUCT_A);
  await page.waitForTimeout(800);
  const catRow = page.locator("tbody tr", { hasText: PRODUCT_A }).first();
  await catRow.waitFor({ timeout: 10000 });
  await shot(page, "03-catalog-retired-marker.png");
  const catText = await catRow.innerText();
  record(
    "catalog: vendor name with Retired pill beside it",
    catText.toLowerCase().includes(VENDOR_NAME.toLowerCase()) && /retired/i.test(catText),
    catText.replace(/\s+/g, " ").slice(0, 160),
  );

  // ---- 4. product edit page ----------------------------------------------
  // A second retired vendor that must NOT show in the product's select.
  const [ov] = await sql.execute("INSERT INTO vendor (organization_id, name, active) VALUES (?, ?, 0)", [
    orgId,
    `Retire Test Other ${runId}`,
  ]);
  extraVendorIds.push(ov.insertId);
  await page.goto(`${BASE}/office/catalog/${productIds[0]}`, { waitUntil: "networkidle" });
  await waitForHydration(page, "form");
  const opts = await page.locator("select#vendor option").allInnerTexts();
  await page.locator("select#vendor").focus();
  await shot(page, "04-product-form-retired-option.png");
  record("product form: option '<name> (retired)' exists", opts.includes(`${VENDOR_NAME} (retired)`), `${opts.length} options`);
  const otherRetired = opts.filter((o) => /\(retired\)/.test(o) && o !== `${VENDOR_NAME} (retired)`);
  record("product form: no OTHER retired vendor offered", otherRetired.length === 0, otherRetired.join("; ") || "none");
  const selectedVal = await page.locator("select#vendor").inputValue();
  record("product form: retired vendor is the selected value", selectedVal === String(vendorId));
  await page.fill("#parLevel", "6");
  await page.getByRole("button", { name: "Save changes" }).click();
  const saved = await page.getByText("Saved.", { exact: true }).waitFor({ timeout: 20000 }).then(() => true, () => false);
  const errTxt = saved ? "" : await page.locator('[role="alert"]').allInnerTexts().then((t) => t.join(" | "), () => "");
  record("product form: par change saves with vendor untouched", saved, errTxt);
  const [[parRow]] = await sql.query(
    "SELECT par_level AS p FROM product_par WHERE product_id = ? AND organization_id = ? AND location_id IS NULL",
    [productIds[0], orgId],
  );
  const [[prodRow]] = await sql.query("SELECT vendor_id AS v FROM product WHERE id = ?", [productIds[0]]);
  record("DB: par is 6 and vendor unchanged", Number(parRow.p) === 6 && prodRow.v === vendorId);

  // ---- 5. reorder ---------------------------------------------------------
  await page.goto(`${BASE}/office/reorder`, { waitUntil: "networkidle" });
  await waitForBodyHydration(page);
  const sections = page.locator("main section");
  const firstSection = sections.first();
  const flagged = page.locator("section", { has: page.getByRole("heading", { name: VENDOR_NAME }) });
  await shot(page, "05-reorder-flagged-block.png");
  const firstHeading = (await firstSection.getByRole("heading").first().innerText().catch(() => "")).trim();
  record("reorder: flagged block is first", firstHeading.toLowerCase() === VENDOR_NAME.toLowerCase(), `first heading "${firstHeading}"`);
  const flagText = await flagged.innerText().catch(() => "");
  record("reorder: block says 'is retired'", /is retired|Retired vendor/i.test(flagText) && /is retired/i.test(await page.locator("main").innerText()), flagText.replace(/\s+/g, " ").slice(0, 160));
  record(
    "reorder: no Copy/Print buttons in flagged block",
    (await flagged.getByRole("button", { name: /copy|print/i }).count()) === 0,
  );

  // ---- 6. invoice review + upload picker ---------------------------------
  await page.goto(`${BASE}/office/invoices/${invoiceId}`, { waitUntil: "networkidle" });
  await waitForHydration(page, "form");
  await shot(page, "06-invoice-review-note.png");
  const noteLoc = page.getByText(`${VENDOR_NAME} is retired. You can still submit and approve this invoice`, { exact: false });
  record("invoice review: retired-vendor note shown", (await noteLoc.count()) > 0);
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  record("invoice review: Approve (submit) is enabled", (await approve.count()) > 0 && (await approve.first().isEnabled()));

  await page.goto(`${BASE}/office/invoices`, { waitUntil: "networkidle" });
  await waitForHydration(page, "form");
  const pickerOpts = await page.locator("select#invoice-vendor option").allInnerTexts();
  await page.locator("select#invoice-vendor").focus();
  await shot(page, "07-invoice-upload-picker.png");
  record("upload picker: retired test vendor NOT offered", !pickerOpts.some((o) => o.includes(VENDOR_NAME)), `${pickerOpts.length} options`);

  // ---- 7. reactivate ------------------------------------------------------
  await page.goto(`${BASE}/office/vendors`, { waitUntil: "networkidle" });
  await waitForBodyHydration(page);
  await page.getByRole("button", { name: `Reactivate ${VENDOR_NAME}`, exact: true }).click();
  const reWarn = await row().innerText();
  await shot(page, "08-vendors-reactivate-armed.png");
  record("reactivate armed warning mentions 2 products", /2 products/.test(reWarn), reWarn.replace(/\s+/g, " ").slice(-140));
  await page.getByRole("button", { name: `Confirm reactivating ${VENDOR_NAME}`, exact: true }).click();
  await page.getByRole("button", { name: `Retire ${VENDOR_NAME}`, exact: true }).waitFor({ timeout: 20000 });
  const reText = await row().innerText();
  record("reactivated: Active badge + Edit present", /Active/i.test(reText) && (await page.getByRole("button", { name: `Edit ${VENDOR_NAME}`, exact: true }).count()) === 1);

  // ---- 8. name taken ------------------------------------------------------
  await page.getByRole("button", { name: `Retire ${VENDOR_NAME}`, exact: true }).click();
  await page.getByRole("button", { name: `Confirm retiring ${VENDOR_NAME}`, exact: true }).click();
  await page.getByRole("button", { name: `Reactivate ${VENDOR_NAME}`, exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Create vendor", exact: true }).click();
  await waitForHydration(page, "form");
  await page.fill("#name", VENDOR_NAME);
  await page.getByRole("button", { name: /^(Create|Save|Add)/ }).last().click();
  const nameMsg = "A retired vendor already uses this name — reactivate it instead.";
  const msgSeen = await page.getByText(nameMsg, { exact: false }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  await shot(page, "09-vendor-name-taken.png");
  record("create with retired vendor's name shows the reactivate message", msgSeen);
  const [[dup]] = await sql.query("SELECT COUNT(*) AS n FROM vendor WHERE organization_id = ? AND name = ?", [orgId, VENDOR_NAME]);
  record("DB: no duplicate vendor created", dup.n === 1);

  // ---- 9. manager ---------------------------------------------------------
  if (!MANAGER.email || !MANAGER.password) {
    console.log("SKIP  manager checks — CHECK_MANAGER_EMAIL/_PASSWORD not set (not a pass)");
  } else {
    const mctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
    const mp = await mctx.newPage();
    await signIn(mp, MANAGER);
    await mp.goto(`${BASE}/office/vendors`, { waitUntil: "networkidle" });
    await waitForBodyHydration(mp);
    const hasRetire = (await mp.getByRole("button", { name: /^Retire |^Reactivate /i }).count()) > 0;
    await shot(mp, "10-manager-vendors.png");
    record("manager: /office/vendors loads with Retire/Reactivate buttons", hasRetire);
    for (const p of ["/office/reorder", "/office/catalog"]) {
      await mp.goto(`${BASE}${p}`, { waitUntil: "networkidle" });
      await waitForBodyHydration(mp);
      const html = await mp.content();
      const visible = await mp.locator("body").innerText();
      const dollars = (visible.match(/\$\s?\d[\d,]*(\.\d+)?/g) ?? []).slice(0, 3);
      record(`manager: no cost/$ figures on ${p}`, dollars.length === 0 && !html.includes("Unit cost for"), dollars.join(", ") || "none");
    }
    await mctx.close();
  }
} catch (err) {
  record("script ran to completion", false, String(err?.stack ?? err).split("\n").slice(0, 4).join(" / "));
  await shot(page, "zz-failure.png").catch(() => {});
} finally {
  // ---- 10. cleanup: only rows this run created, by id + organization -------
  try {
    if (invoiceId) {
      await sql.execute("DELETE FROM invoice_line WHERE invoice_id = ? AND organization_id = ?", [invoiceId, orgId]);
      await sql.execute("DELETE FROM invoice WHERE id = ? AND organization_id = ?", [invoiceId, orgId]);
    }
    if (invoiceFileKey) await unlink(path.join(invoiceRoot(), invoiceFileKey)).catch(() => {});
    for (const pid of productIds) {
      await sql.execute("DELETE FROM product_par WHERE product_id = ? AND organization_id = ?", [pid, orgId]);
      await sql.execute("DELETE FROM product WHERE id = ? AND organization_id = ?", [pid, orgId]);
    }
    for (const vid of [vendorId, ...extraVendorIds].filter(Boolean)) {
      await sql.execute("DELETE FROM vendor_alias WHERE vendor_id = ? AND organization_id = ?", [vid, orgId]);
      await sql.execute("DELETE FROM vendor WHERE id = ? AND organization_id = ?", [vid, orgId]);
    }
  } catch (err) {
    console.log(`CLEANUP ERROR: ${err.message}`);
  }
  const after = { vendor: await count("vendor"), product: await count("product"), invoice: await count("invoice") };
  console.log(`\ncleanup counts before -> after: vendor ${before.vendor}->${after.vendor}, product ${before.product}->${after.product}, invoice ${before.invoice}->${after.invoice}`);
  await browser.close();
  await sql.end();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  console.log("screenshots:\n" + shots.join("\n"));
  process.exit(failed.length ? 1 : 0);
}
