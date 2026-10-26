/**
 * Regressions for the three defects the 2026-10-25 phone test found (round 2).
 *
 * Each of these was invisible to every check that existed: the server rendered
 * correctly, every status was 200, and the unit tests were green. They only
 * show up in a browser driven the way a hand drives it, so they are pinned here
 * and each test says which source change makes it fail.
 *
 *   1. A stale hub after history Back — Next restores the cached RSC snapshot
 *      of the page you left, so the count hub read "0 lines" after you counted.
 *   2. Save re-enabled for a render after a successful save, previewing
 *      "10 ea → 20 ea" on a button that had just saved the 10.
 *   3. The enroll form's disabled Save with no stated reason, next to a grey
 *      placeholder that read as a pre-filled value.
 *
 * Mobile project only: these are phone behaviours (history Back is the Android
 * Back button; the enroll form is reached by the camera).
 */
import type { Page } from "playwright/test";
import { expect, requireRole, test } from "../support/fixtures";
import { authFile } from "../support/env";
import {
  UNKNOWN_UPC,
  addEaches,
  eachesField,
  installFakeCamera,
  legCard,
  pickLocation,
  quantitySave,
  searchAndOpen,
  startCount,
} from "../support/count";

test.use({ storageState: authFile("manager") });

test.beforeEach(async ({ db }) => {
  requireRole("manager");
  await db.resetCounts();
});

test.afterAll(async ({ db }) => {
  await db.resetCounts();
});

/** The hub's "Lines Counted" tile, as the person reads it ("2 lines"). */
function hubLines(page: Page) {
  return page.getByText("Lines Counted", { exact: true }).locator("..");
}

/** The count page's progress tile ("2" over "Lines counted"). */
function detailLines(page: Page) {
  return page.getByText("Lines counted", { exact: true }).locator("..");
}

test.describe("fix 1: no stale count hub after Back", () => {
  test("Back to the hub after starting a count shows the open count, not 'Start a count'", async ({ page, db }) => {
    // Mutation check: remove `<RefreshOnOpen />` from app/(count)/count/page.tsx
    // (or its `!activeCount ||` arm). The restored hub is the snapshot taken
    // BEFORE the count existed — "No Open Count" and a live Start button, so a
    // second tap opens a second draft — and the Resume assertion times out.
    const countId = await startCount(page);
    await page.goBack();

    await expect(page.getByRole("link", { name: `Resume Count #${countId} →` })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start a count" })).toHaveCount(0);
    await expect(hubLines(page)).toContainText("0 lines");
    expect(await db.openCountIds(), "no second draft was opened").toEqual([countId]);
  });

  test("history Back after counting shows the new line count on the hub, and it matches the database", async ({ page, db }) => {
    // Mutation check: remove `<RefreshOnOpen />` from app/(count)/count/page.tsx
    // and Back restores the hub as it was when you left it — "0 lines", the
    // phone-test symptom — so the "2 lines" assertion below fails.
    const countId = await startCount(page);
    await page.goBack();
    await expect(hubLines(page)).toContainText("0 lines");

    await page.getByRole("link", { name: `Resume Count #${countId} →` }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Which section?" })).toBeVisible();
    await pickLocation(page, "Storeroom");
    await addEaches(page, "Jameson", "Jameson", 10);
    await addEaches(page, "Tito", "Tito's", 5);

    // A real history navigation: popstate, so the router restores its cache.
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Floor Count" })).toBeVisible();
    await expect(hubLines(page)).toContainText("2 lines");

    const lines = await db.countLines(countId);
    expect(lines, "the database has what the hub says").toHaveLength(2);
    // The per-section row shows the same truth.
    await expect(page.getByText("2 lines", { exact: true }).first()).toBeVisible();
  });

  test("the picker's Back link and the count page's Back arrow show the new numbers", async ({ page, db }) => {
    // NOT A REGRESSION GUARD FOR ANY ONE FIX. This pins the user-visible outcome
    // (in-app Back links show the new numbers) and nothing narrower.
    //
    // Checked on a production build, 2026-10-26, each against this spec alone:
    //   - RefreshOnOpen made inert (refresh-on-open.tsx)        -> still passes
    //   - `prefetch={false}` deleted (location-picker.tsx)       -> still passes
    //   - both of the above at once                              -> still passes
    // (Tests 1, 2 and 4 above fail under the first and the third, which is what
    // guards RefreshOnOpen.)
    //
    // The reasoning for `prefetch={false}`, which stays unproven: the picker
    // mounts empty, so its "Back to Count #N" Link would prefetch /count/N while
    // it has 0 lines; counting happens on the SAME route (the leg is state, not
    // navigation), so that entry would still be inside its stale window when the
    // Link is tapped. This run did not reproduce a stale page even with the
    // attribute gone, so the flow here is either too slow to hit the window or
    // the router does not serve the prefetched entry as assumed. Do not cite
    // this spec as evidence for the prefetch fix.
    const countId = await startCount(page);
    await pickLocation(page, "Storeroom");
    await addEaches(page, "Jameson", "Jameson", 10);
    await addEaches(page, "Tito", "Tito's", 5);

    await page.getByRole("button", { name: "Finish section" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Which section?" })).toBeVisible();
    await page.getByRole("link", { name: `Back to Count #${countId}` }).click();

    await expect(page.getByRole("heading", { level: 1, name: `Count #${countId}` })).toBeVisible();
    await expect(detailLines(page)).toContainText("2");
    await expect(page.locator("article")).toHaveCount(2);

    await page.getByRole("link", { name: "Back to counts" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Floor Count" })).toBeVisible();
    await expect(hubLines(page)).toContainText("2 lines");
    expect(await db.countLines(countId)).toHaveLength(2);
  });

  test("history Back to the count page after counting shows the new line count", async ({ page, db }) => {
    // Mutation check: remove `{writable ? <RefreshOnOpen /> : null}` from
    // app/(count)/count/[countId]/page.tsx and history Back restores this page
    // as it was when you left it: "0" lines, with the Submit button beside it.
    // The count page is opened by URL on purpose, not through the hub, so this
    // test depends on the DETAIL page's refresh and not on the hub's.
    // Proven only with the component inert for BOTH pages at once (the mutation
    // edits refresh-on-open.tsx); removing it from this page alone was not run.
    const countId = await startCount(page);
    await page.goto(`/count/${countId}`);
    await expect(page.getByRole("heading", { level: 1, name: `Count #${countId}` })).toBeVisible();
    await expect(detailLines(page)).toContainText("0");

    await page.getByRole("button", { name: "Keep counting" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Which section?" })).toBeVisible();
    await pickLocation(page, "Storeroom");
    await addEaches(page, "Jameson", "Jameson", 10);

    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: `Count #${countId}` })).toBeVisible();
    await expect(detailLines(page)).toContainText("1");
    await expect(page.locator("article")).toHaveCount(1);
    expect(await db.countLines(countId)).toHaveLength(1);
  });
});

test.describe("fix 2: Save stays disabled once tapped", () => {
  test("Save never re-enables between the accepted write and leaving the entry screen", async ({ page, db }) => {
    // NOT VERIFIED AS A REGRESSION GUARD. This pins the CONTRACT (Save is never
    // observed enabled again after the tap, until the entry screen is gone, and
    // the ledger holds one row per accepted tap), but it has no proven teeth.
    //
    // The mutation was tried: in components/count/count-leg.tsx, make runWrite
    // clear `busy` on success again (drop the `holdBusyOnOk && result.ok` guard
    // so it always calls setBusy(false)). This spec STILL PASSED against that
    // mutation in headless Chromium, on a dev server. On the phone the bug was a
    // render landing between two microtasks, after the write was accepted and
    // before the entry screen closed; headless Chromium on this machine did not
    // reproduce that interleaving, so the MutationObserver below saw no flip.
    // Do not read a green run as proof the fix holds; the phone is the evidence
    // (docs/open-items.md tracks it). Trying a production build with CPU
    // throttling is the next thing to attempt before trusting this spec.
    const countId = await startCount(page);
    await pickLocation(page, "Storeroom");
    await addEaches(page, "Jameson", "Jameson", 10);

    await searchAndOpen(page, "Jameson", "Jameson");
    await eachesField(page).fill("10");
    const save = quantitySave(page);
    await expect(save).toContainText("10 ea → 20 ea");
    await expect(save).toBeEnabled();

    const handle = await save.elementHandle();
    if (!handle) throw new Error("Save button vanished before the observer was attached");
    await handle.evaluate((el) => {
      const w = window as unknown as { __saveLog: { disabled: boolean; connected: boolean }[] };
      w.__saveLog = [];
      new MutationObserver(() => {
        w.__saveLog.push({ disabled: el.hasAttribute("disabled"), connected: el.isConnected });
      }).observe(el, { attributes: true, attributeFilter: ["disabled"] });
    });

    // A double tap, on purpose: the second click must land on a disabled button.
    await save.dblclick();
    await expect(page.getByRole("heading", { level: 1, name: "Jameson", exact: true })).toBeHidden();
    await expect(legCard(page, "Jameson")).toContainText("20 ea");

    const log = await page.evaluate(() => (window as unknown as { __saveLog: { disabled: boolean; connected: boolean }[] }).__saveLog);
    const firstDisabled = log.findIndex((entry) => entry.disabled);
    expect(firstDisabled, "the tap disabled Save (positive control: the observer saw something)").toBeGreaterThanOrEqual(0);
    const reEnabled = log.slice(firstDisabled + 1).filter((entry) => !entry.disabled);
    expect(reEnabled, "Save was re-enabled while the entry screen was still up").toEqual([]);

    // And the database agrees there was exactly one new write.
    const [line] = await db.countLines(countId);
    expect(line.sealedEachQty).toBe(20);
    const ledger = await db.ledgerRows({ countLineId: line.id });
    expect(ledger.map((r) => r.sealedEachDelta), "one ledger row per accepted tap, not per click").toEqual([10, 10]);
  });
});

test.describe("fix 3: the enroll form says why Save is off", () => {
  test("the empty-name state names its reason, the placeholder reads as an example, typing clears both", async ({ page, db }) => {
    // Mutation check A: delete the `hint={nameMissing ? "Enter a name to save" : undefined}`
    // prop in components/count/enroll-form.tsx (or its `aria-describedby`
    // wiring) and the reason text / accessible description assertions fail.
    // Mutation check B: change the placeholder back to a bare product name, or
    // drop `placeholder:italic`, and the "e.g." / italic assertions fail.
    expect(await db.barcodeExists(UNKNOWN_UPC), `${UNKNOWN_UPC} must not already be enrolled`).toBe(false);
    const productsBefore = await db.activeProductCount();

    await installFakeCamera(page, UNKNOWN_UPC);
    await startCount(page);
    await pickLocation(page, "Storeroom");

    await page.getByRole("button", { name: "Scan barcode" }).click();
    // The fake detector reports the unknown code on the first frame; the app
    // looks it up, finds nothing, and opens the enroll flow (search-first).
    await expect(page.getByRole("heading", { level: 1, name: "Which bottle is this?" })).toBeVisible();
    await page.getByRole("button", { name: "Add it as a new product" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "New product" })).toBeVisible();
    await expect(page.getByText(UNKNOWN_UPC)).toBeVisible();

    const name = page.getByRole("textbox", { name: "Name" });
    const saveAndCount = page.getByRole("button", { name: "Save and count" });
    const reason = page.getByText("Enter a name to save", { exact: true });

    // Empty: Save is off, and the screen says why.
    await expect(saveAndCount).toBeDisabled();
    await expect(reason).toBeVisible();
    // The reason is bound to the field it explains (not just sitting near it).
    await expect(name).toHaveAccessibleDescription("Enter a name to save");

    // The placeholder is an example, not a value: empty, "e.g.", italic.
    expect(await name.inputValue()).toBe("");
    await expect(name).toHaveAttribute("placeholder", /^e\.g\. /);
    const placeholderStyle = await name.evaluate((el) => getComputedStyle(el, "::placeholder").fontStyle);
    expect(placeholderStyle).toBe("italic");

    // Typing a name turns Save on and takes the reason away.
    await name.fill("E2E probe - not saved");
    await expect(saveAndCount).toBeEnabled();
    await expect(reason).toHaveCount(0);
    await expect(name).not.toHaveAttribute("aria-describedby", /./);

    // Clearing it brings the reason back — the state follows the field, not a one-shot.
    await name.fill("");
    await expect(saveAndCount).toBeDisabled();
    await expect(reason).toBeVisible();

    // Leave without enrolling anything: this spec must not mutate the catalog.
    await page.getByRole("button", { name: "Back to search" }).click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByLabel("Current location for this leg: Storeroom")).toBeVisible();
    expect(await db.barcodeExists(UNKNOWN_UPC)).toBe(false);
    expect(await db.activeProductCount(), "no product was created").toBe(productsBefore);
  });
});
