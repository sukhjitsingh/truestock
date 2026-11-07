/**
 * `vendor_alias` reads/writes and the extraction-time matcher — Phase 2.5,
 * Slice 3 (docs/plans/phase-2.5-invoice-automation/04-slices.md, "Slice 3 —
 * Matching"). The "fix once" memory: a human maps a vendor's SKU to one of
 * our products exactly once (`upsertAlias`, called from
 * `lib/domain/invoice-lines.ts:learnAliasesTx` on review submit), and every later invoice
 * from that vendor with the same `vendor_item_code` arrives pre-matched
 * (`matchLinesToProducts`, called from
 * `lib/domain/extraction-pipeline.ts:runClaimedJob`, between parse and
 * persist).
 *
 * ## Trust boundary — every id here is caller-verified, not re-checked
 *
 * Every function in this file takes a plain `orgId`/`vendorId`/`productId`
 * number, never an `Actor` or a raw client payload, and does NOT
 * ownership-check them itself. That is deliberate, not an oversight — see
 * each function's own comment for the specific trust chain — but it makes
 * this file's contract stricter than most of this codebase's domain layer:
 * a caller that passes a `vendorId`/`productId` it has not itself verified
 * against `organizationId` [invariant 9] creates a real cross-tenant leak,
 * with nothing here to catch it. The two call sites that exist today:
 *   - `matchLinesToProducts` is called with `invoiceRow.vendorId`, read from
 *     `getInvoice(actor, invoiceId)` — a row already tenant-scoped by that
 *     read, and itself only ever set from an ownership-checked value at
 *     `createInvoiceForUpload` time (`lib/domain/invoices.ts:assertVendorOwned`).
 *   - `learnAliasesTx` (`lib/domain/invoice-lines.ts`) calls `upsertAliasTx`
 *     with `invoice.vendorId` (same provenance as above, re-selected in that
 *     function's own tenant-scoped query) and each line's `matchedProductId`,
 *     which it re-verifies against `actor.organizationId` in the same pass.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { vendorAlias } from "@/db/schema";
import { isDuplicateKeyError, withLockRetry } from "@/lib/domain/db-errors";
import { DomainError } from "@/lib/domain/errors";
import { isValidPackSize } from "@/lib/domain/cost-derivation";
import type { DraftInvoiceLine } from "@/lib/domain/invoice-lines";

/** Mirrors every other domain file's `Tx` extraction — see e.g. `lib/domain/extraction.ts`. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface VendorAliasRow {
  id: number;
  organizationId: number;
  vendorId: number;
  vendorItemCode: string;
  productId: number;
  /** DECIMAL(4,3) as the string mysql2 round-trips — this file's usual precision convention, never a JS number. */
  matchConfidence: string;
  /** Units per case remembered for this vendor item, or null when not known (never 1). */
  packSize: number | null;
  createdAt: Date;
  updatedAt: Date;
}

function toVendorAliasRow(row: typeof vendorAlias.$inferSelect): VendorAliasRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    vendorId: row.vendorId,
    vendorItemCode: row.vendorItemCode,
    productId: row.productId,
    matchConfidence: row.matchConfidence,
    packSize: row.packSize,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Prefix of a description-derived alias key, kept apart from any real item code. */
const DESCRIPTION_KEY_PREFIX = "desc:";

/**
 * Unicode NFKC, lower case, whitespace collapsed and trimmed. Punctuation and
 * digits are kept on purpose: `750ml` and `1.75l` are different items.
 */
export function normalizeAliasDescription(description: string): string {
  return description.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

interface AliasKey {
  key: string;
  method: "vendor_alias_code" | "vendor_alias_desc";
}

function descriptionAliasKey(line: { description: string | null }): AliasKey | null {
  if (line.description != null) {
    const normalized = normalizeAliasDescription(line.description);
    if (normalized !== "") {
      // Hashed because description is varchar(512) and the key column is
      // varchar(64): "desc:" + 43 base64url characters = 48.
      const digest = createHash("sha256").update(normalized, "utf8").digest("base64url");
      return { key: `${DESCRIPTION_KEY_PREFIX}${digest}`, method: "vendor_alias_desc" };
    }
  }
  return null;
}

function codeAliasKey(line: { vendorItemCode: string | null }): AliasKey | null {
  if (line.vendorItemCode != null && line.vendorItemCode.trim() !== "") {
    return { key: line.vendorItemCode, method: "vendor_alias_code" };
  }
  return null;
}

/** The key a line is remembered by: its code when it has one, else its description. */
function resolveAliasKey(line: { vendorItemCode: string | null; description: string | null }): AliasKey | null {
  return codeAliasKey(line) ?? descriptionAliasKey(line);
}

/**
 * Every key to look a line up by, in priority order: the code key, then the
 * description key. A line that gained an item code read from its name
 * (lib/invoice-item-name.ts) must still find an alias learned earlier under
 * its description, before the code existed.
 */
function lookupAliasKeys(line: { vendorItemCode: string | null; description: string | null }): AliasKey[] {
  return [codeAliasKey(line), descriptionAliasKey(line)].filter((k): k is AliasKey => k != null);
}

/**
 * What a line is remembered by: its item code when it has one, otherwise a
 * hash of its normalised description. Null when it has neither. Always scoped
 * by the caller to one vendor and one organization.
 */
export function aliasKeyForLine(line: { vendorItemCode: string | null; description: string | null }): string | null {
  return resolveAliasKey(line)?.key ?? null;
}

/**
 * The existing alias for `(orgId, vendorId, vendorItemCode)`, or `null` if
 * this vendor's item code has never been mapped. A direct read of the
 * `vendor_alias_organization_vendor_item_code_unique` index (db/schema.ts) —
 * at most one row can ever match.
 */
export async function findAlias(
  orgId: number,
  vendorId: number,
  vendorItemCode: string,
): Promise<VendorAliasRow | null> {
  const [row] = await db
    .select()
    .from(vendorAlias)
    .where(
      and(
        eq(vendorAlias.organizationId, orgId),
        eq(vendorAlias.vendorId, vendorId),
        eq(vendorAlias.vendorItemCode, vendorItemCode),
      ),
    )
    .limit(1);
  return row ? toVendorAliasRow(row) : null;
}

/**
 * ## The confidence rule
 *
 * `match_confidence` starts at the schema's own default, 0.500, on first
 * creation (db/schema.ts's `vendorAlias.matchConfidence` comment: "one human
 * confirmation is a real signal, but not yet proven to generalize"). Each
 * later call that RECONFIRMS the same `(vendor_id, vendor_item_code) ->
 * product_id` mapping halves the remaining distance to 1.000:
 *
 *   next = current + (1 - current) * 0.5
 *
 * 0.500 -> 0.750 -> 0.875 -> 0.938 -> 0.969 -> … — monotonically toward
 * 1.000, never reaching it in exact arithmetic. Chosen over the schema
 * comment's alternative sketch (`1 - 1/(timesConfirmed + 1)`) because it
 * needs no separate confirmation-count column: the next value is a pure
 * function of the value already stored (`computeReconfirmedConfidence`
 * below), computed in JS from the row `upsertAliasCore`'s duplicate-key
 * recovery branch already had to read under `SELECT ... FOR UPDATE` — not an
 * extra read, the SAME one that decides reconfirm-vs-reset in the first
 * place. Capped at 0.999 as a hard ceiling regardless of arithmetic —
 * DECIMAL(4,3) rounds to 3 places on every write, and this formula's rounded
 * sequence reaches 1.000 by the ~10th reconfirmation without the cap
 * (0.999 + 0.0005 rounds up to 1.000), which would silently violate "never
 * reaching or exceeding 1.000" for a long-lived vendor relationship —
 * exactly the kind of plausible-but-wrong drift this codebase's own
 * convention (AGENTS.md) says to guard against explicitly, not assume away.
 *
 * If the submitted `productId` does NOT match the alias's current
 * `product_id`, this is a CORRECTION, not a reconfirmation of the same
 * match — confidence resets to 0.500 rather than climbing, because a mapping
 * that just changed has exactly the same one-data-point trust as a mapping
 * seen for the first time. `productId` itself is unconditionally overwritten
 * either way; a human's most recent choice always wins.
 *
 * ## NOT a single `INSERT ... ON DUPLICATE KEY UPDATE` — and why
 *
 * A first version tried exactly that: one statement, with `matchConfidence`
 * computed by a `CASE WHEN vendor_alias.product_id = :new THEN … ELSE 0.500
 * END` inside the `ON DUPLICATE KEY UPDATE` clause. It is wrong, and stayed
 * wrong across a JS `set: {}` key-reorder attempt, because the bug is not in
 * this file: MySQL/MariaDB evaluates an `UPDATE`'s (and `ON DUPLICATE KEY
 * UPDATE`'s — same row-update machinery) column assignments strictly left to
 * right *in the target table's declared column order*, which
 * `drizzle-orm`'s `buildUpdateSet` derives from `Object.keys(table[Columns])`
 * — the schema's own column order, NOT this file's `set: {}` object's key
 * order. `db/schema.ts` declares `productId` before `matchConfidence` on
 * `vendorAlias`, so by the time the confidence `CASE` runs, `product_id` has
 * ALREADY been overwritten to the new value in the same statement, and the
 * comparison against it is always true — confidence climbs forever and never
 * resets on a correction. (Caught by this file's own test: "submitting a
 * DIFFERENT productId … resets matchConfidence to 0.500" kept observing
 * 0.750/0.875 instead.) There is no column order this file can dictate from
 * a `set: {}` literal, and reordering the schema's own column declarations
 * to work around it is not a call this file gets to make on its own.
 *
 * So this instead follows `lib/domain/counts.ts`'s own established
 * insert-first idiom (`upsertCountLineRow`, see counts-increment-idempotency
 * in this agent's memory) — try the INSERT; on a duplicate-key error,
 * re-read the row with `SELECT ... FOR UPDATE` and branch in JS. Two
 * deliberate choices carried over from that precedent, not reinvented here:
 *   - INSERT is attempted FIRST, never `SELECT ... FOR UPDATE` on a
 *     possibly-absent row. A `SELECT ... FOR UPDATE` that finds nothing
 *     takes a gap lock instead of a row lock, and two concurrent callers
 *     both gap-locking the same not-yet-existing key can deadlock each
 *     other's subsequent INSERT — the exact failure this codebase already
 *     hit and fixed once for `count_line` (memory:
 *     truestock-countline-gap-lock-deadlock). Racing to INSERT first and
 *     recovering via the duplicate-key error sidesteps that lock shape
 *     entirely.
 *   - The recovery `SELECT` uses `.for("update")`, so the branch decision
 *     (reconfirm vs. reset) and the `UPDATE` that acts on it happen against
 *     a row this transaction now holds locked — a second concurrent caller
 *     for the SAME `(orgId, vendorId, vendorItemCode)` blocks on that lock
 *     until this transaction commits or rolls back, rather than reading a
 *     stale `productId` and computing the wrong branch.
 */
async function upsertAliasCore(
  tx: Tx,
  orgId: number,
  vendorId: number,
  vendorItemCode: string,
  productId: number,
  packSize: number | null,
): Promise<VendorAliasRow> {
  // Enforced here, not only in Zod: every writer of vendor_alias.pack_size
  // goes through this function.
  if (packSize !== null && !isValidPackSize(packSize)) {
    throw new DomainError("INVALID_PACK_SIZE", "Units per case must be a whole number from 1 to 9999.");
  }
  try {
    const [inserted] = await tx
      .insert(vendorAlias)
      .values({
        organizationId: orgId,
        vendorId,
        vendorItemCode,
        productId,
        packSize,
        // matchConfidence omitted on the INSERT branch — takes the column's
        // own default (0.500), same discipline as
        // lib/domain/invoice-lines.ts:writeExtractedLines relying on
        // matchMethod's column default rather than repeating the literal here.
      })
      .$returningId();
    const [row] = await tx.select().from(vendorAlias).where(eq(vendorAlias.id, inserted.id)).limit(1);
    if (!row) {
      throw new Error(`upsertAlias: row for vendor ${vendorId} item ${vendorItemCode} not found after insert.`);
    }
    return toVendorAliasRow(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
    // The `vendor_alias_organization_vendor_item_code_unique` index firing —
    // an alias already exists for this (org, vendor, code), either because a
    // prior call created it or because a concurrent one just won the insert
    // race. Either way, read it locked and branch in JS: reconfirmation
    // climbs confidence, a changed productId resets it.
    const [existing] = await tx
      .select()
      .from(vendorAlias)
      .where(
        and(
          eq(vendorAlias.organizationId, orgId),
          eq(vendorAlias.vendorId, vendorId),
          eq(vendorAlias.vendorItemCode, vendorItemCode),
        ),
      )
      .for("update");
    if (!existing) {
      // The unique index fired a moment ago, so a row exists — invariant 6
      // means nothing in this codebase hard-deletes, and vendor_alias has no
      // delete path at all, so this row cannot have vanished between the
      // failed INSERT and this SELECT within the same transaction. Rethrow
      // the original duplicate-key error rather than silently retrying,
      // matching lib/domain/counts.ts's own "if (!raced) throw err;"
      // discipline for the same shape of race.
      throw err;
    }
    const nextConfidence =
      existing.productId === productId ? computeReconfirmedConfidence(existing.matchConfidence) : "0.500";
    // Pack size: same product, a non-null value replaces and null keeps what
    // is remembered. A different product always takes the submitted value, so
    // null clears: a case size must not follow an item code onto another
    // product.
    const nextPackSize = existing.productId === productId ? (packSize ?? existing.packSize) : packSize;
    await tx
      .update(vendorAlias)
      .set({ productId, matchConfidence: nextConfidence, packSize: nextPackSize })
      .where(eq(vendorAlias.id, existing.id));
    const [updated] = await tx.select().from(vendorAlias).where(eq(vendorAlias.id, existing.id)).limit(1);
    if (!updated) {
      throw new Error(`upsertAlias: row ${existing.id} not found after update.`);
    }
    return toVendorAliasRow(updated);
  }
}

/**
 * `next = current + (1 - current) * 0.5`, capped at 0.999 — see this file's
 * "The confidence rule" comment above `upsertAliasCore` for the full
 * derivation. Formatted to exactly 3 decimal places as a string, matching
 * `match_confidence`'s `DECIMAL(4,3)` column (this file's usual convention:
 * DECIMAL columns round-trip through drizzle as strings, never JS numbers —
 * see `VendorAliasRow.matchConfidence`'s own comment).
 */
function computeReconfirmedConfidence(current: string): string {
  const next = Math.min(0.999, Number(current) + (1 - Number(current)) * 0.5);
  return next.toFixed(3);
}

/**
 * `upsertAliasCore`, inside the caller's OWN transaction — for
 * `applyLineReviewTx` (`lib/domain/invoice-lines.ts`), which already holds a
 * `tx` and must not open a second, since the alias write is a side effect of
 * the SAME review-correction transaction, not an independent one: if the
 * reviewer's correction rolls back (e.g. a concurrent status-CAS conflict in
 * `submitInvoiceReview`), the alias it would have produced must roll back
 * with it — nothing here retries or standalone-writes outside that
 * transaction's outcome.
 */
export async function upsertAliasTx(
  tx: Tx,
  orgId: number,
  vendorId: number,
  vendorItemCode: string,
  productId: number,
  packSize: number | null,
): Promise<VendorAliasRow> {
  return upsertAliasCore(tx, orgId, vendorId, vendorItemCode, productId, packSize);
}

/**
 * `upsertAliasTx`, opening its own transaction — for standalone/unit use (mirrors `applyLineReview` next to `applyLineReviewTx`).
 *
 * Wrapped in `withLockRetry` (see db-errors.ts): `upsertAliasCore`'s duplicate-key
 * recovery branch takes a `SELECT ... FOR UPDATE` on the existing row before
 * deciding reconfirm-vs-reset, and 3+ concurrent callers upserting the SAME
 * `(orgId, vendorId, vendorItemCode)` — e.g. two reviewers correcting the same
 * vendor SKU at once — can have InnoDB pick one as a deadlock victim (1213)
 * while it waits on that lock behind another. `isDuplicateKeyError` only
 * recognises 1062 and does not catch this, so without the retry it would
 * propagate as a raw driver error instead of the transaction simply
 * re-running. Retrying the WHOLE transaction is safe for the same reason it is
 * in `lib/domain/counts.ts`: InnoDB rolls the deadlock victim back completely,
 * so a retry starts from the same state the first attempt saw.
 */
export async function upsertAlias(
  orgId: number,
  vendorId: number,
  vendorItemCode: string,
  productId: number,
  packSize: number | null,
): Promise<VendorAliasRow> {
  return withLockRetry(() =>
    db.transaction((tx) => upsertAliasCore(tx, orgId, vendorId, vendorItemCode, productId, packSize)),
  );
}

/**
 * 04-slices.md's own Slice 3 sketch writes this signature as
 * `matchLinesToProducts(lines, orgId)`, with no `vendorId` — but
 * `vendor_alias`'s only unique key (db/schema.ts,
 * `vendor_alias_organization_vendor_item_code_unique`) is
 * `(organizationId, vendorId, vendorItemCode)`, so a lookup that omitted
 * `vendorId` could not even select a single row: two different vendors are
 * free to reuse the same `vendorItemCode` for unrelated products (a supplier
 * SKU is only unique within that supplier's own catalog), and nothing about
 * `orgId` alone disambiguates them. `vendorId` is threaded through
 * explicitly here as a deliberate correction of the doc's sketch, not an
 * unrequested feature — the one invoice-level piece of information this
 * function needs and that only its caller (which already resolved the
 * invoice) can provide.
 *
 * Mutates `lines` in place: for every line with an alias key (`aliasKeyForLine`:
 * its item code, else its hashed description), looks up an existing alias for
 * `(orgId, vendorId, key)` and, if found, sets `matchedProductId`,
 * `matchedVendorAliasId`, `matchMethod` (`"vendor_alias_code"` for an item-code
 * key, `"vendor_alias_desc"` for a description key) and `matchConfidence` from
 * that alias row, and fills `packSize` when the line has none. Never auto-approves:
 * the reviewer still confirms. A line with neither a code nor a description, or
 * an invoice with `vendorId: null` (no vendor recorded on the upload), is
 * left completely untouched — not an error, just nothing this function can
 * match against; the caller (`lib/domain/extraction-pipeline.ts`) is
 * responsible for flagging whichever lines are STILL unmatched afterward
 * with the "unmatched item" exception badge. This function never sets that
 * badge itself — matching and exception-flagging are kept as separate
 * concerns, the same split `arithmeticCheck`/`pdfInspectorCrossCheck` already
 * follow (a pure check function that reports a result, versus the pipeline
 * that turns failing results into `exceptionFlags` entries).
 *
 * One batched `SELECT ... WHERE vendor_item_code IN (...)` for every distinct
 * code across `lines`, not one query per line — mirrors
 * `applyLineReviewTx`'s own batched-lookup convention, and an invoice can
 * carry dozens of lines.
 */
export async function matchLinesToProducts(
  lines: DraftInvoiceLine[],
  orgId: number,
  vendorId: number | null,
): Promise<void> {
  if (vendorId == null) {
    return;
  }
  const resolved = lines.map((line) => lookupAliasKeys(line));
  const keys = Array.from(new Set(resolved.flat().map((r) => r.key)));
  if (keys.length === 0) {
    return;
  }

  const aliases = await db
    .select()
    .from(vendorAlias)
    .where(
      and(
        eq(vendorAlias.organizationId, orgId),
        eq(vendorAlias.vendorId, vendorId),
        inArray(vendorAlias.vendorItemCode, keys),
      ),
    );
  const aliasByKey = new Map(aliases.map((row) => [row.vendorItemCode, row]));

  lines.forEach((line, index) => {
    // Code key first, description key as the fallback; the first hit wins.
    let found: AliasKey | undefined;
    let alias: (typeof aliases)[number] | undefined;
    for (const candidate of resolved[index]) {
      alias = aliasByKey.get(candidate.key);
      if (alias) {
        found = candidate;
        break;
      }
    }
    if (!found || !alias) {
      return;
    }
    line.matchedProductId = alias.productId;
    line.matchedVendorAliasId = alias.id;
    line.matchMethod = found.method;
    line.matchConfidence = alias.matchConfidence;
    // A pack size printed on this invoice line came from this document and
    // beats the remembered one; only a missing one is filled in.
    if (line.packSize == null && alias.packSize != null) {
      line.packSize = alias.packSize;
    }
  });
}
