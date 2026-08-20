/**
 * Browser verification for Phase 2.5 Slice 4 ("Cost Flow + Alerts",
 * docs/plans/phase-2.5-invoice-automation/04-slices.md).
 *
 * A short, one-off companion to scripts/verify-browser.mjs, following the
 * SAME pattern (real Chrome via Playwright, hydration-checked before any
 * interaction, ground truth read back with a direct mysql2 connection —
 * never asserting a page against its own claim) rather than extending that
 * 1300+ line file, per this project's own "verify in a browser, not curl"
 * rule (AGENTS.md).
 *
 * What this proves that tests/invoice-approval-path.test.ts (which already
 * proves approveInvoice's transaction/CAS/rollback logic directly, against
 * real MariaDB) cannot:
 *   A. The "Approve & post costs" button exists on a `reviewed` invoice's
 *      REAL review screen and is ABSENT on a `needs_review` one — a real
 *      DOM assertion, not a call to the domain function.
 *   B. Clicking it drives the real `approveInvoiceAction` server action and
 *      the resulting `product.current_unit_cost` is visible on the real
 *      catalog edit screen afterward — not just correct in the database.
 *   C. The `discount > 50%` badge is computed CLIENT-SIDE, live, as a human
 *      types into the Discount field on a `needs_review` invoice — before
 *      Approve is ever pressed, with no server round trip.
 *
 * Run:
 *   node --env-file=.env.local scripts/verify-browser-slice4.mjs
 *
 * Against the isolated Slice 4 worktree stack
 * (docker-compose.worktree-test.yml, project `truestock-slice4-test`) only.
 * Creates one throwaway product and two throwaway invoices (with one line
 * each) in that stack's `truestock` database; see the cleanup pass at the
 * end for exactly what is removed vs. deliberately left behind as evidence.
 */
import { chromium } from "playwright";
import mysql from "mysql2/promise";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.CHECK_EMAIL;
const PASSWORD = process.env.CHECK_PASSWORD;

if (!EMAIL || !PASSWORD || !process.env.DATABASE_URL) {
  console.error(
    "CHECK_EMAIL, CHECK_PASSWORD and DATABASE_URL must be set (see .env.local).",
  );
  process.exit(2);
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Same reasoning and same implementation as scripts/verify-browser.mjs's own
// waitForHydration — see that file's header comment for why this polls
// page.evaluate rather than page.waitForFunction (CSP 'unsafe-eval').
async function waitForHydration(page, selector = "form", timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hydrated = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__react"));
    }, selector);
    if (hydrated) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitForHydration: "${selector}" never hydrated within ${timeoutMs}ms`);
    }
    await page.waitForTimeout(100);
  }
}

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const sql = await mysql.createConnection(process.env.DATABASE_URL);

let createdProductId = null;
let reviewedInvoiceId = null;
let needsReviewInvoiceId = null;

try {
  console.log(`\ntarget: ${BASE}\n`);

  // ---- sign in --------------------------------------------------------
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await waitForHydration(page, "form");

  const authFailure = [];
  page.on("response", async (res) => {
    if (!res.url().includes("/api/auth/") || res.status() < 400) return;
    authFailure.push(`${res.status()} ${new URL(res.url()).pathname}: ${await res.text().catch(() => "(no body)")}`);
  });

  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  const signedIn = await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }).then(() => true, () => false),
    page.click('button[type="submit"]'),
  ]).then(([ok]) => ok);

  if (!signedIn) {
    record("sign-in succeeds", false, authFailure.join(" | ") || "no session, no auth error captured");
    throw new Error("cannot verify anything else without a session");
  }
  record("sign-in succeeds", true, page.url());

  // ---- fixtures ---------------------------------------------------------
  const [[ownerRow]] = await sql.query(
    "SELECT id, organization_id AS organizationId FROM user WHERE email = ?",
    [EMAIL],
  );
  if (!ownerRow) throw new Error(`no user row for ${EMAIL} — sign-in above should have failed already`);
  const orgId = ownerRow.organizationId;
  const ownerId = ownerRow.id;

  const [productInsert] = await sql.execute(
    `INSERT INTO product (organization_id, name, category, unit_type, size_ml, active)
     VALUES (?, ?, 'Spirits', 'bottle', 750, 1)`,
    [orgId, `Verify Slice 4 Product ${Date.now()}`],
  );
  createdProductId = productInsert.insertId;

  const [[productBefore]] = await sql.query(
    "SELECT current_unit_cost AS cost FROM product WHERE id = ?",
    [createdProductId],
  );
  record(
    "fixture product starts with no cost",
    productBefore.cost === null,
    `current_unit_cost=${productBefore.cost}`,
  );

  const today = new Date().toISOString().slice(0, 10);
  const retentionUntil = `${Number(today.slice(0, 4)) + 3}${today.slice(4)}`;

  async function insertInvoice(status, totals) {
    const [ins] = await sql.execute(
      `INSERT INTO invoice
         (organization_id, status, source, file_sha256, file_size_bytes,
          invoice_date, invoice_number, total_gross, total_discount, total_net,
          currency, retention_until)
       VALUES (?, ?, 'pdf', ?, 100, ?, ?, ?, ?, ?, 'USD', ?)`,
      [
        orgId,
        status,
        Math.random().toString(16).slice(2).padEnd(64, "0").slice(0, 64),
        today,
        `VERIFY-SLICE4-${status.toUpperCase()}-${Date.now()}`,
        totals.gross,
        totals.discount,
        totals.net,
        retentionUntil,
      ],
    );
    return ins.insertId;
  }

  // Invoice R — already "reviewed", one product line matched to the fixture
  // product. raw_net (96.00) / quantity (12) / pack_size (1) = 8.0000 — a
  // clean number, easy to eyeball on screen. raw_discount/raw_gross =
  // 104/200 = 0.52, so this line ALSO exercises the persisted (non-editable)
  // branch of the discount>50% badge, independent of the live-typing check
  // invoice N does below.
  reviewedInvoiceId = await insertInvoice("reviewed", { gross: "200.0000", discount: "104.0000", net: "96.0000" });
  const [reviewedLineInsert] = await sql.execute(
    `INSERT INTO invoice_line
       (organization_id, invoice_id, line_number, line_type, description,
        quantity, uom, pack_size, raw_gross, raw_discount, raw_net,
        matched_product_id, match_method)
     VALUES (?, ?, 1, 'product', 'Verify Slice 4 — priceable line', '12.000', 'each', 1,
             '200.00', '104.00', '96.00', ?, 'manual')`,
    [orgId, reviewedInvoiceId, createdProductId],
  );
  const reviewedLineId = reviewedLineInsert.insertId;

  // Invoice N — "needs_review", one UNMATCHED product line at 20% discount
  // (no badge at load) so the live-typing check below starts from "no
  // alert" and can prove the badge appears reactively rather than having
  // been there from page load.
  needsReviewInvoiceId = await insertInvoice("needs_review", { gross: "100.0000", discount: "20.0000", net: "80.0000" });
  const [needsReviewLineInsert] = await sql.execute(
    `INSERT INTO invoice_line
       (organization_id, invoice_id, line_number, line_type, description,
        quantity, uom, pack_size, raw_gross, raw_discount, raw_net, match_method)
     VALUES (?, ?, 1, 'product', 'Verify Slice 4 — discount badge line', '6.000', 'each', 1,
             '100.00', '20.00', '80.00', 'unmatched')`,
    [orgId, needsReviewInvoiceId],
  );
  const needsReviewLineId = needsReviewLineInsert.insertId;

  // ---- B: needs_review invoice — no "Approve & post costs", live badge --
  await page.goto(`${BASE}/office/invoices/${needsReviewInvoiceId}`, { waitUntil: "networkidle" });
  await waitForHydration(page, "form");

  const approveCostsOnNeedsReview = await page
    .getByRole("button", { name: "Approve & post costs" })
    .count();
  record(
    '"Approve & post costs" is NOT offered on a needs_review invoice',
    approveCostsOnNeedsReview === 0,
    `button count=${approveCostsOnNeedsReview}`,
  );

  const badgeBeforeTyping = await page.getByText("Discount > 50%", { exact: true }).count();
  record(
    "discount>50% badge absent at load (20% discount)",
    badgeBeforeTyping === 0,
    `badge count=${badgeBeforeTyping}`,
  );

  const discountInput = page.locator(`#line-${needsReviewLineId}-discount`);
  await discountInput.fill("60.00");
  // No submit, no navigation — computeLineAlerts runs on React state alone.
  const badgeAppeared = await page
    .getByText("Discount > 50%", { exact: true })
    .first()
    .waitFor({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  record(
    "discount>50% badge appears LIVE after typing, before Approve is pressed",
    badgeAppeared,
    badgeAppeared ? "badge rendered from client-side state alone" : "badge never appeared",
  );

  // Type it back down — the only mutation this invoice's ROW would have had
  // if submitted, and it was never submitted, so nothing to restore here
  // beyond letting this throwaway invoice get deleted below.
  await discountInput.fill("20.00");

  // ---- A + B: reviewed invoice — button present, approve, cost flows ----
  await page.goto(`${BASE}/office/invoices/${reviewedInvoiceId}`, { waitUntil: "networkidle" });
  await waitForHydration(page, "form");

  const approveCostsButton = page.getByRole("button", { name: "Approve & post costs" });
  record(
    '"Approve & post costs" IS offered on a reviewed invoice',
    (await approveCostsButton.count()) === 1,
    `button count=${await approveCostsButton.count()}`,
  );

  const badgeOnReviewed = await page.getByText("Discount > 50%", { exact: true }).count();
  record(
    "discount>50% badge shows on a reviewed (read-only) line from persisted values (52% discount)",
    badgeOnReviewed === 1,
    `badge count=${badgeOnReviewed}`,
  );

  await approveCostsButton.click();
  const approvedBanner = await page
    .getByText(/Approved\. This is a permanent record/i)
    .first()
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  record(
    "clicking Approve & post costs transitions the invoice to approved (banner)",
    approvedBanner,
  );

  const actionsGoneAfterApproval = await page
    .getByRole("button", { name: /Approve|Return/ })
    .count();
  record(
    "approved is terminal — no action buttons remain",
    actionsGoneAfterApproval === 0,
    `remaining action buttons=${actionsGoneAfterApproval}`,
  );

  // ---- ground truth: DB ---------------------------------------------------
  const [[invoiceRow]] = await sql.query(
    "SELECT status, approved_at AS approvedAt, approved_by AS approvedBy FROM invoice WHERE id = ?",
    [reviewedInvoiceId],
  );
  record(
    "invoice.status is approved in the database, stamped by this owner",
    invoiceRow.status === "approved" && invoiceRow.approvedAt != null && invoiceRow.approvedBy === ownerId,
    `status=${invoiceRow.status} approvedAt=${invoiceRow.approvedAt} approvedBy=${invoiceRow.approvedBy}`,
  );

  const [[productAfter]] = await sql.query(
    "SELECT current_unit_cost AS cost FROM product WHERE id = ?",
    [createdProductId],
  );
  record(
    "product.current_unit_cost updated to the derived value (200's line: 96/12/1 = 8.0000)",
    productAfter.cost === "8.0000",
    `current_unit_cost=${productAfter.cost}`,
  );

  const [historyRows] = await sql.query(
    `SELECT unit_cost AS unitCost, previous_unit_cost AS previousUnitCost, created_by AS createdBy
     FROM product_cost_history WHERE source_invoice_line_id = ?`,
    [reviewedLineId],
  );
  record(
    "exactly one product_cost_history row was appended for this line",
    historyRows.length === 1 &&
      historyRows[0].unitCost === "8.0000" &&
      historyRows[0].previousUnitCost === null &&
      historyRows[0].createdBy === ownerId,
    historyRows.length === 1
      ? `unit_cost=${historyRows[0].unitCost} previous_unit_cost=${historyRows[0].previousUnitCost} created_by=${historyRows[0].createdBy}`
      : `expected 1 row, found ${historyRows.length}`,
  );

  // ---- ground truth: the catalog edit screen, in the browser -------------
  await page.goto(`${BASE}/office/catalog/${createdProductId}`, { waitUntil: "networkidle" });
  await waitForHydration(page, "form");
  const costFieldValue = await page.locator("#cost").inputValue();
  record(
    "the product's catalog edit screen shows the new non-null cost (8.00)",
    costFieldValue === "8.00",
    `#cost input value="${costFieldValue}"`,
  );
} catch (err) {
  record("verification run completed without throwing", false, String(err));
} finally {
  // ---- cleanup -------------------------------------------------------
  // Invoice N (the discount-badge scratch invoice) was never submitted —
  // its row is pure fixture noise with no evidentiary value, so it is
  // deleted outright.
  //
  // Invoice R (the approved invoice), its line, its product_cost_history
  // row, and the fixture product are DELIBERATELY LEFT IN PLACE — real,
  // inspectable evidence that Slice 4's cost flow ran end to end against
  // this database, same reasoning scripts/verify-browser.mjs uses when it
  // notes what it leaves behind. Nothing pre-existing was mutated (the
  // product was created by this run, not a real catalog item), so there is
  // nothing to restore for it.
  try {
    if (needsReviewInvoiceId) {
      await sql.execute("DELETE FROM invoice_line WHERE invoice_id = ?", [needsReviewInvoiceId]);
      await sql.execute("DELETE FROM invoice WHERE id = ?", [needsReviewInvoiceId]);
    }
    console.log(
      `\nleft in place as evidence: product #${createdProductId} (current_unit_cost now set), ` +
        `invoice #${reviewedInvoiceId} (status=approved) and its product_cost_history row.`,
    );
    console.log(`removed: throwaway needs_review invoice #${needsReviewInvoiceId} and its line.`);
  } catch (cleanupErr) {
    console.error("CLEANUP FAILED — manual cleanup needed:", cleanupErr);
  }
  await sql.end();
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
