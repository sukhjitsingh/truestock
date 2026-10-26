/**
 * The counting loop, end to end, minus the camera.
 *
 * start a count -> pick a section -> find the bottle with the SEARCH picker ->
 * enter a quantity (or a fill) -> Save -> next. The camera is the only
 * thing left out (headless Chromium has none); the search picker is the other
 * way into exactly the same entry screen, and AGENTS.md requires it to sit
 * beside the scan button, so a test that goes through it is a test of the
 * product's real second front door, not a workaround.
 *
 * Every test ends at the DATABASE. The card on screen is the optimistic row: it
 * appears before the server has said anything and would look identical if the
 * write were lost, duplicated, or filed under a second row. Invariant 3
 * (UNIQUE count_id+product_id+location_id: a re-add increments, never inserts)
 * and invariant 5 (one fresh client_line_id per write attempt, one append-only
 * ledger row each) are only visible there.
 *
 * Each test starts from `resetCounts()`: no counts at all, so "Start a count" is
 * exercised rather than a leftover being resumed, and one test cannot pass on
 * another's rows. The suite is serial (workers: 1) so this is safe.
 */
import { expect, requireRole, test } from "../support/fixtures";
import { authFile } from "../support/env";
import {
  addEaches,
  eachesField,
  fillSave,
  legCard,
  pickLocation,
  quantitySave,
  searchAndOpen,
  startCount,
  syncChip,
} from "../support/count";

test.use({ storageState: authFile("manager") });

test.beforeEach(async ({ db }) => {
  requireRole("manager");
  await db.resetCounts();
});

test.afterAll(async ({ db }) => {
  // Leave the e2e database as the suite found the user's world: with no
  // half-finished count a later manual run would trip over.
  await db.resetCounts();
});

test("start, pick Storeroom, search, quantity, Save: one line and one ledger row", async ({ page, db }) => {
  const countId = await startCount(page);
  await pickLocation(page, "Storeroom");

  await searchAndOpen(page, "Jameson", "Jameson");
  // Nothing typed yet: Save must not be live, or a stray tap writes a zero line.
  await expect(quantitySave(page)).toBeDisabled();
  await eachesField(page).fill("10");
  // The consequence is stated on the button before the tap (AGENTS.md).
  await expect(quantitySave(page)).toContainText("0 ea → 10 ea");
  await quantitySave(page).click();

  // Back on the leg, the line is there and the queue is drained.
  await expect(legCard(page, "Jameson")).toContainText("10 ea");
  await expect(page.getByText("1 in Storeroom")).toBeVisible();
  await expect(syncChip(page)).toHaveText("Synced");

  // Ground truth. This test saves once, so it cannot see invariant 3 (the UNIQUE
  // (count_id, product_id, location_id) index / upsert) break; the next test,
  // which saves the same bottle twice, is the one that would. Mutation check for
  // the write path: make incrementCountLine skip the ledger insert and `ledger`
  // is empty.
  const jameson = await db.productByName("Jameson");
  const storeroom = await db.locationByName("Storeroom");
  expect(await db.openCountIds()).toEqual([countId]);
  await expect.poll(async () => (await db.countLines(countId)).length, "count_line rows for this count").toBe(1);
  const lines = await db.countLines(countId);
  expect(lines[0]).toMatchObject({
    countId,
    productId: jameson.id,
    locationId: storeroom.id,
    sealedEachQty: 10,
    sealedCaseQty: 0,
    partialFills: [],
  });
  const ledger = await db.ledgerRows({ countLineId: lines[0].id });
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ sealedEachDelta: 10, sealedCaseDelta: 0, partialFillsDelta: [] });
  expect(ledger[0].clientLineId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("the same bottle again increments the same line and adds a ledger row", async ({ page, db }) => {
  const countId = await startCount(page);
  await pickLocation(page, "Storeroom");
  await addEaches(page, "Jameson", "Jameson", 10);

  await searchAndOpen(page, "Jameson", "Jameson");
  await expect(page.getByText("Currently recorded on this line:")).toContainText("10 ea");
  await eachesField(page).fill("5");
  await expect(quantitySave(page)).toContainText("10 ea → 15 ea");
  await quantitySave(page).click();
  await expect(page.getByRole("heading", { level: 1, name: "Jameson", exact: true })).toBeHidden();

  // One card, one line, 15 — never two cards, never "5".
  await expect(page.locator("article")).toHaveCount(1);
  await expect(legCard(page, "Jameson")).toContainText("15 ea");
  await expect(syncChip(page)).toHaveText("Synced");

  // Mutation check (invariant 3): make the second add INSERT instead of update
  // (or drop the unique index) and there are two count_line rows here, or the
  // insert dies on the index and the quantity stays 10.
  const lines = await db.countLines(countId);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ sealedEachQty: 15, sealedCaseQty: 0 });

  // Mutation check (invariant 5): reuse one client_line_id per LINE instead of
  // per write attempt and the second add is swallowed as a replay: the line
  // stays at 10 and this ledger has one row.
  const ledger = await db.ledgerRows({ countLineId: lines[0].id });
  expect(ledger.map((r) => r.sealedEachDelta)).toEqual([10, 5]);
  expect(new Set(ledger.map((r) => r.clientLineId)).size, "each write attempt carries its own client_line_id").toBe(2);
});

test("a SET states its consequence on the button and ledgers the delta", async ({ page, db }) => {
  const countId = await startCount(page);
  await pickLocation(page, "Storeroom");
  await addEaches(page, "Tito", "Tito's", 12);

  await searchAndOpen(page, "Tito", "Tito's");
  await page.getByRole("tab", { name: "Set exact count (=)" }).click();
  await eachesField(page).fill("3");
  // The "SET a number you meant as an ADD loses bottles" guard: before and after
  // are on the button, live, with the signed difference. No confirmation modal.
  await expect(quantitySave(page)).toContainText("was 12 ea");
  await expect(quantitySave(page)).toContainText(/[−-]9/);
  await quantitySave(page).click();
  await expect(page.getByRole("heading", { level: 1, name: "Tito's", exact: true })).toBeHidden();
  await expect(legCard(page, "Tito's")).toContainText("3 ea");

  const [line] = await db.countLines(countId);
  expect(line.sealedEachQty).toBe(3);
  const ledger = await db.ledgerRows({ countLineId: line.id });
  expect(ledger.map((r) => r.sealedEachDelta)).toEqual([12, -9]);
});

test("Speed Rail takes a fill level: Half, one save, [0.5] on the line", async ({ page, db }) => {
  const countId = await startCount(page);
  await pickLocation(page, "Speed Rail");

  await searchAndOpen(page, "Jameson", "Jameson");
  // Both editors are on screen on a tenths location. Open bottle first: Full /
  // Half / Empty are single taps, and the save button names what it will do.
  await expect(fillSave(page)).toBeDisabled();
  await page.getByRole("button", { name: "Half", exact: true }).click();
  await expect(fillSave(page)).toHaveText(/Add 50% and save/);
  await fillSave(page).click();

  await expect(page.getByRole("heading", { level: 1, name: "Jameson", exact: true })).toBeHidden();
  await expect(legCard(page, "Jameson")).toContainText("1 open (50%)");
  await expect(syncChip(page)).toHaveText("Synced");

  const jameson = await db.productByName("Jameson");
  const speedRail = await db.locationByName("Speed Rail");
  const lines = await db.countLines(countId);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    productId: jameson.id,
    locationId: speedRail.id,
    sealedEachQty: 0,
    partialFills: [0.5],
  });
  const ledger = await db.ledgerRows({ countLineId: lines[0].id });
  expect(ledger).toHaveLength(1);
  expect(ledger[0].partialFillsDelta).toEqual([0.5]);
});
