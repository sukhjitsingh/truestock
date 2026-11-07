/**
 * The back-office catalog table (TanStack Table): paging, sorting, and the
 * owner's inline cost edit.
 *
 * Desktop only. The back office is a desk surface; the phone counts. Ignored on
 * the mobile project in playwright.config.ts rather than skipped here, so the
 * report never shows it as "skipped" (reserved for NOT VERIFIED).
 *
 * The row names are read from each row's "Select <name>" checkbox label, which
 * is the table's one stable, per-row accessible name — a CSS path into the
 * product cell would break the next time the cell's markup is restyled.
 */
import type { Page } from "playwright/test";
import { expect, requireRole, test } from "../support/fixtures";
import { authFile } from "../support/env";
import { waitForHydration } from "../support/hydration";

const PAGE_SIZE = 20;

test.use({ storageState: authFile("owner") });

test.beforeEach(async ({ page }) => {
  requireRole("owner");
  await page.goto("/office/catalog");
  await expect(page.getByRole("heading", { level: 1, name: "Catalog" })).toBeVisible();
  // Paging and sorting are client state: a click before React attaches does nothing.
  await waitForHydration(page, "button[aria-label='Next page']");
});

/** Product names on the current page, in display order. */
async function pageNames(page: Page): Promise<string[]> {
  const labels = await page.locator("tbody tr").getByRole("checkbox").evaluateAll((boxes) =>
    boxes.map((box) => box.getAttribute("aria-label") ?? ""),
  );
  return labels.map((label) => label.replace(/^Select /, ""));
}

test("renders 20 of N rows, and Next pages to 21-40", async ({ page, db }) => {
  const total = await db.activeProductCount();
  expect(total, "the e2e catalog has more than one page of products").toBeGreaterThan(PAGE_SIZE);

  // Mutation check: change `pageSize: 20` in components/office/catalog-table.tsx
  // (or break the range maths) and the row count or the label below is wrong.
  await expect(page.getByText(`Showing 1–${PAGE_SIZE} of ${total}`, { exact: true })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(PAGE_SIZE);
  await expect(page.getByText(`Page 1 of ${Math.ceil(total / PAGE_SIZE)}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();

  const firstPage = await pageNames(page);
  await page.getByRole("button", { name: "Next page" }).click();

  const lastOfSecond = Math.min(total, PAGE_SIZE * 2);
  await expect(page.getByText(`Showing ${PAGE_SIZE + 1}–${lastOfSecond} of ${total}`, { exact: true })).toBeVisible();
  const secondPage = await pageNames(page);
  expect(secondPage, "page 2 holds different products from page 1").not.toEqual(firstPage);
  expect(secondPage.filter((name) => firstPage.includes(name)), "no product is on both pages").toEqual([]);

  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(page.getByText(`Showing 1–${PAGE_SIZE} of ${total}`, { exact: true })).toBeVisible();
  expect(await pageNames(page)).toEqual(firstPage);
});

test("the Product header sorts, flips aria-sort and reorders the rows", async ({ page }) => {
  const header = page.getByRole("columnheader", { name: "Product", exact: true });
  await expect(header).toHaveAttribute("aria-sort", "none");
  const unsorted = await pageNames(page);

  // Mutation check: drop `aria-sort` from the <th> in SortableTableHead
  // (components/ui/table.tsx), or detach `onSort`, and the attribute or the
  // order below does not change.
  await header.getByRole("button").click();
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  const ascending = await pageNames(page);
  expect(ascending, "ascending order differs from the server's order").not.toEqual(unsorted);

  await header.getByRole("button").click();
  await expect(header).toHaveAttribute("aria-sort", "descending");
  const descending = await pageNames(page);
  expect(descending, "descending order differs from ascending").not.toEqual(ascending);
  // The strongest comparator-free proof that the order really flipped: with more
  // than two pages of products, the first 20 rows of an ascending sort and the
  // first 20 of the same sort descending share no product. (A string
  // comparison here would be wrong — the table uses TanStack's alphanumeric
  // sort, which puts "1800 Silver" last ascending, not first.)
  expect(
    descending.filter((name) => ascending.includes(name)),
    "ascending and descending first pages overlap",
  ).toEqual([]);

  // Third click clears the sort again; aria-sort goes back to "none".
  await header.getByRole("button").click();
  await expect(header).toHaveAttribute("aria-sort", "none");
  expect(await pageNames(page)).toEqual(unsorted);
});

/**
 * Narrows the table to one product (server-side search) so its cost cell is on
 * screen whatever page it would have been on, and returns that cell.
 */
async function costCellFor(page: Page, name: string, total: number) {
  await page.getByLabel("Search catalog").fill(name);
  // The search is debounced and server-side; wait until the table has actually
  // shrunk, or the cell below could be the pre-search one about to be replaced.
  await expect(page.locator("caption")).not.toContainText(`Catalog, ${total} products`);
  const cell = page.getByLabel(`Unit cost for ${name}`, { exact: true });
  await expect(cell).toBeVisible();
  return cell;
}

test("the owner edits a cost cell inline; the database reflects it; it is restored", async ({ page, db }) => {
  const [target] = await db.pricedProducts();
  if (!target || target.currentUnitCost === null) {
    const why = "NOT VERIFIED: owner inline cost edit (the e2e database has no priced product)";
    console.warn(why);
    test.skip(true, why);
    return;
  }
  const original = target.currentUnitCost; // as the driver returns it, e.g. "82.0000"
  const edited = (Number(original) + 1).toFixed(2);
  const total = await db.activeProductCount();

  try {
    const cell = await costCellFor(page, target.name, total);
    await cell.fill(edited);
    await expect(page.getByText("Unsaved", { exact: true })).toBeVisible();

    // Mutation check: remove the `onBlur={commit}` / updateProductAction call in
    // EditableProductCell (components/office/catalog-table.tsx), or make the
    // action drop `currentUnitCost` for the owner, and the database never
    // changes — the poll below times out. The DB read is the proof; nothing
    // on screen is trusted for it (see the known-defect test for why).
    await cell.press("Enter");
    await expect
      .poll(async () => Number((await db.productById(target.id)).currentUnitCost), "unit cost in the database")
      .toBe(Number(edited));

    // And it survives a reload: the screen is showing the stored value, not local state.
    await page.reload();
    await waitForHydration(page, "button[aria-label='Next page']");
    const reloaded = await costCellFor(page, target.name, total);
    await expect(reloaded).toHaveValue(edited);
  } finally {
    await db.setProductCost(target.id, original);
  }
  expect((await db.productById(target.id)).currentUnitCost, "the original cost is restored exactly").toBe(original);
});

test("KNOWN DEFECT: the inline cost cell never shows its 'Saved' confirmation", async ({ page, db }) => {
  // Pins a defect that exists today, WITHOUT test.fail(): that wrapper counts ANY
  // failure as the expected one, so a changed selector, a timeout or a DB error
  // would keep this green for the wrong reason. Instead the save is first PROVEN
  // (the database holds the new value), and only then is the absence of "Saved"
  // asserted. A setup problem fails the first expect; the defect being fixed fails
  // the last one.
  //
  // Observed 2026-10-26 on the production build: the status goes "Unsaved" ->
  // "Saving…" -> nothing, and the <input> element is a different DOM node after the
  // save. EditableProductCell is DESIGNED to set status "saved" for two seconds.
  // Cause (by reading, not yet proven by a fix): a successful save calls
  // `patchRow`, which changes `rows`, which re-derives `visibleIds`, which rebuilds
  // the memoized `columns` array; every cell renderer is then a new function,
  // TanStack's `flexRender` mounts a function as a COMPONENT, so React sees a new
  // component type and remounts the cell, taking its "saved" state with it. The
  // value itself persists (the first cost test proves that); only the
  // confirmation is lost.
  //
  // When the cell is fixed the final expect fails: change `toBe(false)` to
  // `toBe(true)` and rename the test.
  const [target] = await db.pricedProducts();
  if (!target || target.currentUnitCost === null) {
    const why = "NOT VERIFIED: cost cell 'Saved' confirmation (the e2e database has no priced product)";
    console.warn(why);
    test.skip(true, why);
    return;
  }
  const original = target.currentUnitCost;
  const edited = (Number(original) + 1).toFixed(2);
  const total = await db.activeProductCount();
  try {
    const cell = await costCellFor(page, target.name, total);
    await cell.fill(edited);
    await cell.press("Enter");
    await expect
      .poll(async () => Number((await db.productById(target.id)).currentUnitCost), "the save really reached the database")
      .toBe(Number(edited));
    const sawSaved = await page
      .getByText("Saved", { exact: true })
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(
        () => true,
        () => false,
      );
    expect(sawSaved, "KNOWN DEFECT: 'Saved' is expected to be absent today; if it appeared, the cell is fixed - flip this assertion").toBe(false);
  } finally {
    await db.setProductCost(target.id, original);
  }
});
