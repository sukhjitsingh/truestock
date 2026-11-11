/**
 * Retire and reactivate a vendor (open item 49): the owner's two-tap flows on
 * /office/vendors, and what a retired vendor does to the places that offer one.
 *
 * Desktop only. The vendors table is a back-office desk surface; it is ignored
 * on the mobile project in playwright.config.ts rather than skipped here, so
 * the report never shows it as "skipped" (reserved for NOT VERIFIED).
 *
 * The tests are one story over one throwaway vendor with two products, so they
 * run serially: retire -> name refused -> picker omits it -> reactivate.
 * Vendors and products are never hard-deleted by the app, so the fixture is
 * seeded and removed directly in the database (by id + organization).
 *
 * Mutation checks:
 *  - make listVendorsAction return retired vendors too: the picker test is red.
 *  - drop the retired-name branch of the create-vendor guard: the refusal test
 *    is red (the second vendor is created, or a different message shows).
 *  - make Retire a one-tap action: the first test is red (the first tap
 *    retires, so Cancel is never offered).
 */
import type { Page } from "playwright/test";
import { expect, requireRole, test } from "../support/fixtures";
import { authFile } from "../support/env";
import { waitForHydration, waitForLocatorHydration } from "../support/hydration";

test.use({ storageState: authFile("owner") });
test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);
const NAME = `E2E Retire Vendor ${RUN}`;
const NAME_TAKEN = "A retired vendor already uses this name — reactivate it instead.";

let vendorId = 0;
let productIds: number[] = [];

test.beforeAll(async ({ db }) => {
  const seeded = await db.seedVendorWithProducts(NAME, 2);
  vendorId = seeded.vendorId;
  productIds = seeded.productIds;
});

test.afterAll(async ({ db }) => {
  if (vendorId) await db.deleteVendorFixture(vendorId, productIds);
});

test.beforeEach(async ({ page }) => {
  requireRole("owner");
  await page.goto("/office/vendors");
  await expect(page.getByRole("heading", { level: 1, name: "Vendors" })).toBeVisible();
  // The Retire button is client state: a tap before React attaches does nothing.
  await waitForLocatorHydration(page.getByRole("button", { name: "Create vendor", exact: true }));
});

const row = (page: Page) => page.locator("tbody tr", { hasText: NAME }).first();

test("owner retires a vendor in two taps: armed row warns with the product count and focuses Cancel", async ({ page, db }) => {
  await page.getByRole("button", { name: `Retire ${NAME}`, exact: true }).click();

  // Armed: nothing has been written yet.
  await expect(row(page)).toContainText("2 products still use this vendor.");
  const cancel = page.getByRole("button", { name: `Cancel retiring ${NAME}`, exact: true });
  await expect(cancel, "a stray second tap must cancel, not confirm").toBeFocused();
  expect((await db.vendorByName(NAME))[0].active, "one tap alone retires nothing").toBe(true);

  // Cancel puts the Retire button back and changes nothing.
  await cancel.click();
  await expect(page.getByRole("button", { name: `Retire ${NAME}`, exact: true })).toBeVisible();
  expect((await db.vendorByName(NAME))[0].active).toBe(true);

  // Second tap confirms.
  await page.getByRole("button", { name: `Retire ${NAME}`, exact: true }).click();
  await page.getByRole("button", { name: `Confirm retiring ${NAME}`, exact: true }).click();
  await expect(page.getByRole("button", { name: `Reactivate ${NAME}`, exact: true })).toBeVisible();

  await expect(row(page).getByText("Retired", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Edit ${NAME}`, exact: true }), "a retired vendor has no Edit").toHaveCount(0);
  await expect.poll(async () => (await db.vendorByName(NAME))[0].active, "vendor.active in the database").toBe(false);
});

test("creating a vendor with a retired vendor's name is refused with the reactivate message", async ({ page, db }) => {
  await page.getByRole("button", { name: "Create vendor", exact: true }).click();
  await waitForHydration(page, "form");
  await page.locator("#name").fill(NAME);
  await page.getByRole("button", { name: "Create vendor", exact: true }).click();

  await expect(page.getByText(NAME_TAKEN, { exact: false }).first()).toBeVisible();
  expect(await db.vendorByName(NAME), "no duplicate vendor row").toHaveLength(1);
});

test("the invoice upload vendor picker does not list the retired vendor", async ({ page }) => {
  await page.goto("/office/invoices");
  await waitForHydration(page, "form");
  const options = await page.locator("select#invoice-vendor option").allInnerTexts();
  expect(options.length, "the picker rendered its options").toBeGreaterThan(0);
  expect(options.filter((o) => o.includes(NAME)), "retired vendor must not be offered").toEqual([]);
});

test("owner reactivates the vendor in two taps and it is active again", async ({ page, db }) => {
  await page.getByRole("button", { name: `Reactivate ${NAME}`, exact: true }).click();
  await expect(row(page)).toContainText("2 products");
  await expect(page.getByRole("button", { name: `Cancel reactivating ${NAME}`, exact: true })).toBeFocused();
  await page.getByRole("button", { name: `Confirm reactivating ${NAME}`, exact: true }).click();

  await expect(page.getByRole("button", { name: `Retire ${NAME}`, exact: true })).toBeVisible();
  await expect(row(page).getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Edit ${NAME}`, exact: true })).toBeVisible();
  await expect.poll(async () => (await db.vendorByName(NAME))[0].active, "vendor.active in the database").toBe(true);

  // And it is offered by the upload picker again.
  await page.goto("/office/invoices");
  await waitForHydration(page, "form");
  await expect(page.locator("select#invoice-vendor option", { hasText: NAME })).toHaveCount(1);
});
