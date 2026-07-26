/**
 * Zod schemas for the count boundary. Shared with the frontend.
 *
 * Validates what the database cannot (db/schema.ts's comment above
 * `count_line` says this explicitly): quantities >= 0 and bounded, each
 * `partial_fills` entry within [0, 1], enum membership for count type/status.
 *
 * ## `clientLineId` — one per WRITE ATTEMPT, not one per count line
 *
 * This is unmissable on purpose because getting it wrong is quiet and bad:
 * `clientLineId` is the idempotency key for a single write (see
 * `count_line_write` in db/schema.ts and lib/domain/counts.ts's file-level
 * comment). A count line gets incremented many times over a count's life —
 * every scan of the same product+location adds to the existing row. If a
 * client generates ONE UUID per line and reuses it across every scan of that
 * line ("this is my local record for Tito's at the Back Bar"), every scan
 * after the first collides with the ledger's unique index and is silently
 * treated as an already-applied retry — a real second scan gets thrown away,
 * not double-counted. That failure mode is worse than the double-count bug
 * this table replaced: it under-counts instead of over-counting, and nothing
 * about it looks wrong until the total doesn't reconcile.
 *
 * The rule: generate a fresh UUID for every individual write you send —
 * every scan, every typed quantity submission, every fill correction, every
 * absolute-set correction — including when you resend the same write from an
 * IndexedDB retry queue after a dropped connection (THAT resend must reuse
 * the id the original attempt used, so the replay is recognized as the same
 * write, not a new one).
 */
import { z } from "zod";
import { countTypeEnum, countStatusEnum } from "@/db/schema";

export const countTypeSchema = z.enum(countTypeEnum);
export const countStatusSchema = z.enum(countStatusEnum);

export const openCountSchema = z.object({
  type: countTypeSchema,
  notes: z.string().trim().max(2000).optional(),
});
export type OpenCountInput = z.infer<typeof openCountSchema>;

const fillFractionSchema = z
  .number()
  .min(0, "A fill level can't be negative.")
  .max(1, "A fill level can't exceed a full bottle (1.0).");

// Generous sanity ceiling for a single write's quantity — nowhere near a
// real bar's scale (spec: 50-200 bottles/count), but bounds what reaches
// count_line/count_line_write's plain `int` columns so a typo (or a
// malicious payload) fails with an actionable Zod message instead of an
// integer-overflow error from MySQL.
const MAX_QTY_PER_WRITE = 100_000;

/**
 * The scan/increment path (CLAUDE.md invariants 3 & 5). One request = one
 * additive write: "I observed N more sealed cases / N more sealed eaches /
 * these additional open-bottle fill readings" for a given (count, product,
 * location).
 *
 * `clientLineId` = one fresh UUID per write attempt — see the file header.
 */
export const incrementCountLineSchema = z.object({
  clientLineId: z.uuid(),
  countId: z.number().int().positive(),
  productId: z.number().int().positive(),
  locationId: z.number().int().positive(),
  sealedCaseQtyDelta: z.number().int().min(0).max(MAX_QTY_PER_WRITE).default(0),
  sealedEachQtyDelta: z.number().int().min(0).max(MAX_QTY_PER_WRITE).default(0),
  // Newly observed open bottles to append to partial_fills, e.g. a bottle
  // just found and tapped to 0.4 full. Not a replacement of the array.
  newPartialFills: z.array(fillFractionSchema).max(50).default([]),
  openedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD.")
    .optional(),
});
export type IncrementCountLineInput = z.infer<typeof incrementCountLineSchema>;

/**
 * Barcode-driven variant of the same increment: resolves the product from a
 * scanned barcode server-side (never trusts a client-resolved product id for
 * the scan path) before applying the same increment logic.
 *
 * `clientLineId` = one fresh UUID per write attempt (i.e. per scan) — see the
 * file header. Scanning the same bottle five times means five different
 * `clientLineId` values, one per scan, not one reused across all five.
 */
export const scanCountLineSchema = z.object({
  clientLineId: z.uuid(),
  countId: z.number().int().positive(),
  barcode: z.string().trim().min(4).max(64),
  locationId: z.number().int().positive(),
  // A barcode scan of a case carton vs. a loose bottle resolves to a
  // pack_level (each|case) from ProductBarcode; the quantity being recorded
  // is always "1 more of whatever this barcode's pack_level is" unless the
  // caller is entering a typed quantity (sealed backstock's "3 cases" case),
  // in which case they pass an explicit qty.
  qty: z.number().int().positive().max(MAX_QTY_PER_WRITE).default(1),
});
export type ScanCountLineInput = z.infer<typeof scanCountLineSchema>;

/**
 * Correct a specific open-bottle fill reading on an existing line (e.g. "the
 * 3rd bottle was actually 0.4, not 0.3"), or replace the whole array in one
 * go. This is a SET of `partial_fills`, not an increment.
 */
export const editCountLineFillsSchema = z.object({
  countLineId: z.number().int().positive(),
  partialFills: z.array(fillFractionSchema).max(50),
});
export type EditCountLineFillsInput = z.infer<typeof editCountLineFillsSchema>;

/**
 * Correct `sealed_case_qty`/`sealed_each_qty` to an absolute value — for
 * "a manager typed 5 cases instead of 3" during a live count, where the
 * scan/increment path (additive only) has no way to fix a wrong entry short
 * of scanning negative quantities (which doesn't exist).
 *
 * Still needs its own `clientLineId` (one per correction attempt, same rule
 * as above — see lib/domain/counts.ts for why a SET still needs ledger
 * protection even though it's naturally idempotent at the count_line level:
 * it isn't idempotent at the ledger/audit-trail level, since the delta this
 * write represents depends on the row's state at the moment it's applied).
 */
export const setCountLineQuantitiesSchema = z.object({
  clientLineId: z.uuid(),
  countLineId: z.number().int().positive(),
  sealedCaseQty: z.number().int().min(0).max(MAX_QTY_PER_WRITE),
  sealedEachQty: z.number().int().min(0).max(MAX_QTY_PER_WRITE),
});
export type SetCountLineQuantitiesInput = z.infer<typeof setCountLineQuantitiesSchema>;

export const countIdSchema = z.object({
  countId: z.number().int().positive(),
});

export const submitCountSchema = countIdSchema;
export const reviewCountSchema = countIdSchema;
export const closeCountSchema = countIdSchema;
export const getCountSchema = countIdSchema;
