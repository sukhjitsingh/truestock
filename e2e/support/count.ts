/**
 * Driving the counting screens the way a person does, minus the camera.
 *
 * Everything here goes through the real UI — real taps on real buttons, found by
 * role and accessible name — because the screens ARE the product and a helper
 * that called a server action directly would skip exactly the client logic the
 * count specs exist to exercise (optimistic rows, the busy gate, the IndexedDB
 * queue). Ground truth is read back from the database (`db.ts`), never from
 * the same screen that is under test.
 *
 * Selectors, and why they are the ones they are:
 *  - Locations and search results are `<button>`s whose accessible name starts
 *    with the product / location name, so they are matched by a leading-anchored
 *    regex rather than an exact string (the name also carries the size and mode).
 *  - The quantity field is a `spinbutton` named "Eaches". `getByLabel("Eaches")`
 *    would also match the "Increase eaches" / "Decrease eaches" buttons, whose
 *    aria-labels contain the word.
 *  - The quantity Save button's name is "Save (10 ea) …"; the fill editor's is
 *    "Add 50% and save" / "Save fill levels". On a tenths location BOTH editors
 *    are on screen at once, so `quantitySave` and `fillSave` are separate and
 *    neither is reachable by a bare /save/i.
 */
import type { Locator, Page } from "playwright/test";
import { expect } from "./fixtures";
import { waitForLocatorHydration } from "./hydration";

/**
 * A well-formed UPC-A (valid check digit) that no seeded product carries. The
 * enroll specs assert it is absent from `product_barcode` before using it, so
 * if someone ever enrolls it for real the spec says so instead of drifting into
 * the "already known" path.
 */
export const UNKNOWN_UPC = "999999999993";

/** "/count/42/scan" -> 42. */
export function countIdFromUrl(url: string): number {
  const match = /^\/count\/(\d+)(?:\/|$)/.exec(new URL(url).pathname);
  if (!match) throw new Error(`not a count URL: ${url}`);
  return Number(match[1]);
}

/**
 * From a cold load of the hub: "Start a count" -> lands on the section picker of
 * the new count. Returns the new count's id. Expects no open count.
 */
export async function startCount(page: Page): Promise<number> {
  await page.goto("/count");
  await expect(page.getByRole("heading", { level: 1, name: "Floor Count" })).toBeVisible();
  const start = page.getByRole("button", { name: "Start a count" });
  await expect(start).toBeVisible();
  // A tap before React attaches does nothing and the test would then time out
  // waiting for a navigation that was never started.
  await waitForLocatorHydration(start);
  await start.click();
  await page.waitForURL(/\/count\/\d+\/scan/);
  await expect(page.getByRole("heading", { level: 1, name: "Which section?" })).toBeVisible();
  return countIdFromUrl(page.url());
}

/** Picks a location on the section picker and waits for that leg to be the active one. */
export async function pickLocation(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`^${escapeRegExp(name)}\\b`) }).click();
  await expect(page.getByLabel(`Current location for this leg: ${name}`)).toBeVisible();
  // The search bar and the scan button live side by side (AGENTS.md: "always
  // offer a search picker beside the scan button"). Checked on every leg entry.
  await expect(page.getByPlaceholder("Search products")).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan barcode" })).toBeVisible();
}

/** Types into the leg's search picker and opens the matching result's entry screen. */
export async function searchAndOpen(page: Page, query: string, productName: string): Promise<void> {
  await page.getByPlaceholder("Search products").fill(query);
  await page.getByRole("button", { name: new RegExp(`^${escapeRegExp(productName)}\\b`) }).click();
  await expect(page.getByRole("heading", { level: 1, name: productName, exact: true })).toBeVisible();
}

/** The sealed-quantity field on the entry screen. */
export function eachesField(page: Page): Locator {
  return page.getByRole("spinbutton", { name: "Eaches" });
}

/**
 * The sealed-quantity Save button. Only unambiguous on a quantity-only
 * location; on a tenths location the fill editor has its own (see `fillSave`).
 * Scoped by the "Sealed" submit's `Save (` / `Save correction (` prefix.
 */
export function quantitySave(page: Page): Locator {
  return page.getByRole("button", { name: /^Save(?: correction)?\s*\(/ });
}

/** The open-bottle editor's Save button: "Add 50% and save" / "Set bottle #1 to 40% and save" / "Save fill levels". */
export function fillSave(page: Page): Locator {
  return page.getByRole("button", { name: /and save$|^Save fill levels$/ });
}

/** The "Just counted" card for a product on the current leg. */
export function legCard(page: Page, productName: string): Locator {
  return page.locator("article").filter({ has: page.getByRole("heading", { level: 3, name: productName, exact: true }) });
}

/** The sync chip: "Synced" when the offline queue is empty, "N pending" otherwise. */
export function syncChip(page: Page): Locator {
  return page.getByText(/^(Synced|\d+ pending)$/);
}

/**
 * Add `eaches` of a product on a quantity location: search, open, type, Save,
 * and wait for the entry screen to hand back to the leg. The wait matters: the
 * screen leaves only after the server accepted the write (`finishSave`), so
 * returning from here means the row is committed.
 */
export async function addEaches(page: Page, query: string, productName: string, eaches: number): Promise<void> {
  await searchAndOpen(page, query, productName);
  await eachesField(page).fill(String(eaches));
  await quantitySave(page).click();
  await expect(page.getByRole("heading", { level: 1, name: productName, exact: true })).toBeHidden();
  await expect(legCard(page, productName)).toBeVisible();
}

/**
 * Makes the scanner "see" one barcode. Headless Chromium has no camera, and the
 * production build uses the NATIVE `BarcodeDetector` when present — so this
 * replaces both halves the scanner touches: a `BarcodeDetector` that reports
 * `barcode` on every frame, and a `getUserMedia` that returns a canvas stream
 * (a real, playable video track, so `video.play()` resolves as it would on a
 * phone). Installed with `addInitScript`, which runs ahead of the page's own
 * code and is not subject to the page CSP.
 *
 * Call BEFORE the first navigation of the test.
 */
export async function installFakeCamera(page: Page, barcode: string): Promise<void> {
  await page.addInitScript((code: string) => {
    class FakeBarcodeDetector {
      static async getSupportedFormats(): Promise<string[]> {
        return ["upc_a", "upc_e", "ean_13", "ean_8", "code_128", "code_39"];
      }
      // The real API resolves an ARRAY of detections (one per barcode in frame).
      // Returning a bare object makes the app's `results.find(...)` throw, which
      // its tick loop swallows on purpose ("a single failed frame is not an
      // error") — so a wrong fake looks exactly like a camera that sees nothing.
      async detect(): Promise<unknown[]> {
        return [{ rawValue: code, format: "upc_a", boundingBox: new DOMRectReadOnly(0, 0, 1, 1), cornerPoints: [] }];
      }
    }
    Object.defineProperty(window, "BarcodeDetector", { value: FakeBarcodeDetector, configurable: true, writable: true });

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    let frame = 0;
    setInterval(() => {
      if (!ctx) return;
      ctx.fillStyle = frame++ % 2 ? "#202020" : "#383838";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }, 100);
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(10);
    }
  }, barcode);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
