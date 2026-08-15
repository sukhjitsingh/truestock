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

/**
 * Phase 2.5, Slice 2. §1.4(c) of docs/invoice-automation-research.md — the
 * line type that keeps deposits and freight out of unit cost. An invoice
 * line for a keg deposit or a freight surcharge is real money on the
 * invoice but must never be averaged into `product.current_unit_cost`: a
 * $10 keg-deposit line billed alongside 24 cases of beer would silently
 * inflate the beer's derived cost if it were priced as a `product` line
 * instead of excluded as a `deposit` one. `discount` is its own line type
 * (not folded into `product`) for the same reason: a supplier discount
 * printed as its own line item is a price adjustment, not a unit sold.
 * `unknown` is the extraction default — a badly OCR'd or unrecognized line
 * stays unclassified rather than defaulting to `product` and polluting a
 * valuation.
 */
export const invoiceLineTypeEnum = [
  "product",
  "deposit",
  "deposit_return",
  "freight",
  "tax",
  "fee",
  "discount",
  "unknown",
] as const;

/**
 * Unit of measure as printed on the invoice line. Deliberately its own enum,
 * distinct from `productUnitTypeEnum` (bottle/can/keg) — this describes what
 * the SUPPLIER billed by, before that line is ever reconciled against a
 * catalog product. `other` covers anything extraction can't map onto the
 * three known pack levels (e.g. "LB", "GAL") rather than forcing a guess.
 */
export const invoiceLineUomEnum = ["each", "case", "keg", "other"] as const;

/**
 * How `invoiceLine.matchedProductId` got set, ordered cheapest/most-trusted
 * first in the pipeline that will eventually try them. Only two of these are
 * live in Slice 2: every line this slice's extraction pipeline writes starts
 * `unmatched`, and the only way a line leaves that state is a human picking
 * the product on the review screen, which sets `manual`.
 * `vendor_alias_code` / `vendor_alias_desc` are Slice 3's automatic matching
 * against the (not-yet-built) `vendor_item_alias` table; `barcode` and
 * `fuzzy` are later automatic strategies; `created_draft` is reserved for a
 * not-yet-built "create this product from the invoice line" action. The
 * enum is declared now, in full, because `matchMethod` is a closed set
 * MariaDB must accept a value from the day the column exists — adding a
 * value later is itself a migration, whereas building the strategies that
 * produce these values is ordinary application work.
 */
export const invoiceMatchMethodEnum = [
  "vendor_alias_code",
  "vendor_alias_desc",
  "barcode",
  "fuzzy",
  "manual",
  "created_draft",
  "unmatched",
] as const;
