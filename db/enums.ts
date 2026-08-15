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

/**
 * [AR-4] docs/plans/phase-2.5-invoice-automation/02-architecture.md §2. The
 * invoice status machine, declared once — the legal transitions themselves
 * live in `lib/domain/invoices.ts` (`INVOICE_TRANSITIONS`), not here; this
 * tuple only fixes the closed set of values MariaDB will accept. `approved`
 * is terminal: nothing transitions out of it, and a correction to an
 * approved invoice is a new record, never a status edit.
 */
export const invoiceStatusEnum = [
  "uploaded",
  "processing",
  "needs_review",
  "reviewed",
  "approved",
  "rejected",
] as const;

/** How the invoice document arrived. */
export const invoiceSourceEnum = ["photo", "pdf", "email_forward"] as const;

/**
 * [AR-6] ONE state machine for `extraction_job`, declared here and nowhere
 * else. The earlier draft had three incompatible vocabularies: the enum
 * said "pending", a slice wrote "ready_for_classify" (not in the enum —
 * MariaDB would reject it), and the cron claimed "pending". The lifecycle is
 * exactly `awaiting_upload → queued → running → done | failed`.
 *
 * A job is created `awaiting_upload`, NOT `queued` — the invoice and job
 * rows exist before the client has finished uploading the file, and a job
 * claimable at creation gets picked up by the cron before the object exists.
 * It only becomes `queued` once the upload is confirmed and its byte length
 * and SHA-256 match what was declared at upload time. See
 * `db/schema.ts`'s `extractionJob` table comment for the reaper that
 * returns a stuck `running` job to `queued` (or `failed` after 3 retries).
 */
export const extractionJobStatusEnum = [
  "awaiting_upload",
  "queued",
  "running",
  "done",
  "failed",
] as const;

/**
 * Progress *within* extraction. Observability only — never a claim
 * predicate, so adding a pipeline step never changes which jobs the cron
 * claims.
 */
export const extractionPhaseEnum = ["classify", "text_extract", "ocr", "parse"] as const;

/** Set by the classify phase; drives whether OCR (Claude Vision) runs. */
export const pdfTypeEnum = ["text", "scanned", "mixed", "image"] as const;
