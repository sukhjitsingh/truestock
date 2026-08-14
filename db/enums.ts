/**
 * The schema's string enums, split out of `db/schema.ts` so they can be
 * imported without dragging Drizzle into the bundle that imports them.
 *
 * They are plain `as const` string tuples — no Drizzle, no `mysql2`, no
 * database handle — and `db/schema.ts` re-exports every one of them, so
 * server-side callers can keep importing from either place.
 *
 * **Why the split is load-bearing, not tidiness.** `lib/validation/*.ts` is
 * shared with the frontend by design (see the header comment there), and it
 * needs these tuples as *values* to build `z.enum(...)`. A value import
 * reaches through to whatever module defines them, so while they lived in
 * `db/schema.ts` every client component that imported a validation schema
 * pulled `drizzle-orm/mysql-core` and the entire table definitions into the
 * browser bundle. `components/office/catalog-table.tsx` imports
 * `unitCostSchema`, which is how the back-office catalog route ended up
 * shipping Drizzle to the client.
 *
 * The visible symptom was not a big download — it was the catalog page
 * *hanging*: the route's chunks took tens of seconds to be served in dev
 * because Turbopack had to compile Drizzle for the browser on demand, and
 * the server-rendered HTML paints long before any of it arrives. So the page
 * looked completely normal and simply ignored every click until hydration
 * finally landed. The same failure mode AGENTS.md already records for the
 * CSP: **a page that renders is not a page that works**, and a 200 proves
 * nothing about either.
 *
 * Keep this file free of imports. Anything added here is added to the client
 * bundle of every form in the app.
 */

export const userRoleEnum = ["owner", "manager", "staff"] as const;
export const productUnitTypeEnum = ["bottle", "can", "keg"] as const;
export const barcodePackLevelEnum = ["each", "case"] as const;
export const countTypeEnum = ["full", "spot", "monthly_close"] as const;

/**
 * How a location is counted. CLAUDE.md: "the input-mode switch [is] explicit —
 * Speed Rail and Back Bar are tenths, Storeroom is quantities only, and that
 * is driven entirely by location."
 *
 * It lives on `location` as a column because it is a property of the place,
 * not of the screen. The alternative was matching location names in the
 * frontend, which is how three screens end up with three different opinions
 * about whether the Wine Rack takes fill levels.
 *
 *  - `tenths`   — open bottles are the point here; the fill pad is the primary
 *                 input. Sealed quantities are still reachable, because a
 *                 back bar legitimately holds a backup bottle behind the open
 *                 one.
 *  - `quantity` — sealed backstock only. No fill UI at all, per "quantities
 *                 only": offering a fill pad in the storeroom invites someone
 *                 to tap a level on a sealed case.
 */
export const locationCountModeEnum = ["tenths", "quantity"] as const;

export const countStatusEnum = [
  "draft",
  "in_progress",
  "submitted",
  "reviewed",
  "closed",
] as const;
