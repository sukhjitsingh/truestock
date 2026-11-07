/**
 * Role boundaries, checked from the outside the way a browser meets them.
 *
 * AGENTS.md invariant 8: cost and margin data is gated by role, and "assume the
 * server already filtered it; do not rely on client-side hiding as the
 * control". So the cost checks here look at what the SERVER SENT (the HTML and
 * the streamed RSC payload that rides inside it), not only at what ended up
 * visible — a column hidden by CSS would pass a visibility check and still be a
 * leak. Invariant 7 (authorization in every route handler, not only
 * middleware) is the other half: the invoice-file route must answer 403 to a
 * manager, not serve bytes and rely on the page that links to it being hidden.
 *
 * Positive controls matter as much as the negatives. "The manager sees no cost"
 * proves nothing if the check cannot see cost on the owner's page, so each
 * negative has an owner-side twin that must DETECT what the negative says is
 * absent.
 */
import { expect, requireRole, test } from "../support/fixtures";
import { authFile } from "../support/env";

const SIGNED_OUT = { cookies: [], origins: [] };

/**
 * Cost strings as the DB holds them ("144.0000"), plus the JSON key the catalog
 * table's props carry. Either appearing in a non-owner's payload is a leak.
 */
async function costNeedles(db: { pricedProducts(): Promise<{ currentUnitCost: string | null }[]> }): Promise<string[]> {
  const priced = await db.pricedProducts();
  const values = priced.map((p) => p.currentUnitCost).filter((v): v is string => v !== null);
  return ["currentUnitCost", ...values];
}

test.describe("staff", () => {
  test.use({ storageState: authFile("staff") });
  test.beforeEach(() => requireRole("staff"));

  for (const path of ["/office", "/office/catalog", "/office/locations", "/office/users", "/office/invoices"]) {
    test(`${path} sends staff to the counting app`, async ({ page }) => {
      // Mutation check: delete the `role === "staff"` redirect in
      // `requireOfficeUser` (lib/current-user.ts) and the office layout renders
      // for staff, so this URL assertion fails.
      await page.goto(path);
      await expect(page).toHaveURL(/\/count\/?$/);
      await expect(page.getByRole("link", { name: "Locations" })).toHaveCount(0);
    });
  }

  test("the counting app shows staff no cost data", async ({ page, request, db }) => {
    const needles = await costNeedles(db);
    expect(needles.length, "positive control: the e2e database has priced products to look for").toBeGreaterThan(1);

    for (const path of ["/count", "/count/catalog"]) {
      // Server side: the raw document, flight payload included.
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      const html = await res.text();
      for (const needle of needles) {
        expect(html.includes(needle), `${path} payload for staff contains "${needle}"`).toBe(false);
      }

      // Client side: what a person would read.
      await page.goto(path);
      const text = await page.locator("body").innerText();
      expect(text, `${path} shows a price`).not.toMatch(/\$\s?\d/);
      expect(text, `${path} mentions unit cost`).not.toMatch(/unit cost|margin/i);
    }
  });
});

test.describe("manager", () => {
  test.use({ storageState: authFile("manager") });
  test.beforeEach(() => requireRole("manager"));

  test("the catalog carries no cost column or cost data", async ({ page, request, db }) => {
    const needles = await costNeedles(db);
    expect(needles.length, "positive control: the e2e database has priced products to look for").toBeGreaterThan(1);

    // Mutation check: set `canSeeCost` true for managers where the catalog page
    // builds its props and the `currentUnitCost` key (and every cost value)
    // appears in this payload, failing the first loop below.
    const res = await request.get("/office/catalog");
    expect(res.status()).toBe(200);
    const html = await res.text();
    for (const needle of needles) {
      expect(html.includes(needle), `manager payload contains "${needle}"`).toBe(false);
    }

    await page.goto("/office/catalog");
    await expect(page.getByRole("heading", { level: 1, name: "Catalog" })).toBeVisible();
    // A real table rendered — otherwise "no cost column" is vacuous.
    await expect(page.getByRole("columnheader", { name: "Product", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /unit cost/i })).toHaveCount(0);
    await expect(page.getByLabel(/Unit cost for/)).toHaveCount(0);
    expect(await page.content()).not.toContain("Unit cost for");
  });

  test("the invoice file route refuses a manager with 403", async ({ request, db }) => {
    // The role gate runs before the invoice is looked up, so a real id is not
    // required for this to be a valid test — but with one, a 403 cannot be
    // mistaken for "no such invoice".
    const [realId] = await db.invoiceIds();
    const id = realId ?? 999_999;
    // Mutation check: change `requireRole("owner")` in the GET handler of
    // app/api/invoices/[id]/file/route.ts to allow managers and this returns
    // 200 (bytes) or 404 instead of 403.
    const res = await request.get(`/api/invoices/${id}/file`);
    expect(res.status()).toBe(403);
    expect((await res.body()).byteLength, "a 403 must not carry file bytes").toBeLessThan(1024);
  });
});

test.describe("owner", () => {
  test.use({ storageState: authFile("owner") });
  test.beforeEach(() => requireRole("owner"));

  test("positive control: the owner's catalog does carry cost", async ({ request, db }) => {
    // If this fails the manager/staff negatives above are asserting against a
    // probe that cannot see cost at all.
    const needles = await costNeedles(db);
    const res = await request.get("/office/catalog");
    const html = await res.text();
    expect(html).toContain("currentUnitCost");
    expect(html).toContain(needles[1]);
    expect(html).toContain("Unit cost for");
  });

  test("the invoice file route answers the owner 200, or 404 for a missing file — never 403", async ({ request, db }) => {
    const [id] = await db.invoiceIds();
    if (id === undefined) {
      console.warn("NOT VERIFIED: owner invoice-file access (the e2e database has no invoices)");
      test.skip(true, "NOT VERIFIED: owner invoice-file access (the e2e database has no invoices)");
      return;
    }
    const res = await request.get(`/api/invoices/${id}/file`);
    // 404 is legitimate here: the row exists but its file may not be on this
    // rig's disk (INVOICE_STORAGE_DIR differs between harness and app).
    expect([200, 404], `GET /api/invoices/${id}/file`).toContain(res.status());
  });
});

test.describe("signed out", () => {
  test.use({ storageState: SIGNED_OUT });

  test("the invoice file route answers 401, not bytes", async ({ request }) => {
    const res = await request.get("/api/invoices/1/file");
    expect(res.status()).toBe(401);
  });
});
