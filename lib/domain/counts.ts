/**
 * Count domain functions — CLAUDE.md invariants 1, 2, 3, 4, 5 all live here.
 *
 * ## The idempotency ledger design (invariants 3 & 5) — REVISED 2026-07-25
 *
 * `count_line.client_line_id` used to be a single mutable column,
 * overwritten on every increment, treated as "the id of the most recently
 * applied write." Code review found the flaw: that only catches a retry of
 * the *immediately preceding* write. A count line is incremented many times
 * over a count's life (every scan of the same product+location adds to the
 * existing row, per the composite unique key), so an out-of-order replay —
 * write A applies, its ack is lost, write B applies and overwrites the
 * stored id with B's, then A retries off the client's queue — fails the
 * equality check, falls through, and re-applies A's delta a second time.
 * Silent double-count. Exactly the failure class CLAUDE.md names as this
 * app's worst.
 *
 * The fix, now in the schema: `client_line_id` was removed from `count_line`
 * entirely and moved to `count_line_write` — an append-only ledger with one
 * permanent row per write, `client_line_id` UNIQUE there. A duplicate-key
 * violation on inserting into the ledger *is* the "already applied" signal,
 * enforced by the database across a line's whole history, not a column that
 * can only remember one thing at a time. Full reasoning: the comment above
 * `countLineWrite` in db/schema.ts, and db/README.md's "Idempotency ledger"
 * section.
 *
 * **Two different unique constraints are involved and they mean opposite
 * things — this is the thing to not conflate:**
 *   - `count_line`'s composite key `(count_id, product_id, location_id)`
 *     colliding means "a line for this scan target already exists" — a
 *     perfectly normal, expected event on a second scan. It must INCREMENT.
 *     Handled entirely inside `upsertCountLineRow` below, recovered from
 *     without ever leaving the transaction.
 *   - `count_line_write`'s `client_line_id` colliding means "this exact
 *     write was already applied, sometime in this line's history" — a
 *     retry. It must be a NO-OP that still reports success. This can only
 *     be detected AFTER attempting the ledger insert, and by then the
 *     transaction has already applied a (now-unwanted) increment via
 *     `upsertCountLineRow` — so this collision is deliberately NOT caught
 *     inside the transaction. It's left to propagate, which rolls back
 *     everything the transaction did (the increment included), and is only
 *     caught by the caller, after the rollback, at which point the right
 *     move is to re-read whatever an earlier write already committed and
 *     hand THAT back as the result.
 *
 * Required write order inside one transaction (not optional — enforced by
 * the FK from `count_line_write.count_line_id` to `count_line.id`, and by
 * the fact that idempotency depends on both writes sharing a transaction):
 *   1. Insert-or-increment `count_line` (`upsertCountLineRow`) — resolves
 *      `count_line.id`, whether the row is brand new or already existed.
 *   2. Insert the `count_line_write` ledger row, referencing that id.
 * If step 2 hits `ER_DUP_ENTRY` on `client_line_id`, the transaction rolls
 * back in full — undoing step 1's increment along with it. Net effect of a
 * replayed write: zero, exactly. A caller retrying a write must get the
 * same successful result it would have gotten the first time — it must
 * never see this as an error (build brief) — so `applyIncrement` and
 * `setCountLineQuantities` below both catch `ER_DUP_ENTRY` from the ledger
 * insert *outside* `db.transaction(...)`, re-read the line, and return it
 * as an ordinary success.
 *
 * An application-level pre-check (`findReplayedLine`, before opening the
 * transaction) short-circuits the common case without paying for a
 * transaction+rollback — but it is an optimization only, not the
 * correctness mechanism. The unique index + rollback is what's actually
 * enforcing this; the pre-check just skips ahead to the same answer when it
 * can. A race between two concurrent retries is still caught by the index.
 *
 * ## Invariant 1 — closed counts are immutable
 * Every function that writes a count line re-reads the parent `count.status`
 * inside the same transaction (`FOR UPDATE`) and throws `ClosedCountError`
 * if it is `closed`. There is no trigger backstopping this at the database
 * level (see db/README.md) — this is the only enforcement point, so every
 * write path funnels through `assertCountWritable` below rather than
 * re-implementing the check.
 */
import { and, desc, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { db } from "@/db";
import { count, countLine, countLineWrite, location, product, user } from "@/db/schema";
import type { Actor } from "@/lib/authz";
import { canSeeCost } from "@/lib/authz";
import {
  ClosedCountError,
  InvalidCountTransitionError,
  NotFoundError,
} from "@/lib/domain/errors";
import { isDuplicateKeyError } from "@/lib/domain/db-errors";
import { resolveBarcodeForCount } from "@/lib/domain/catalog";
import {
  computeLineValuation,
  summarizeValuation,
  type ValuationLine,
} from "@/lib/domain/valuation";
import type {
  OpenCountInput,
  IncrementCountLineInput,
  ScanCountLineInput,
  EditCountLineFillsInput,
  SetCountLineQuantitiesInput,
} from "@/lib/validation/counts";

// Extracts the transaction-callback parameter type from `db.transaction`
// itself, rather than hardcoding a drizzle-internal type name — stays
// correct regardless of exactly which class drizzle-orm's mysql2 driver
// hands back as `tx`.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CountLineRecord = typeof countLine.$inferSelect;

// ---------------------------------------------------------------------------
// Open a count
// ---------------------------------------------------------------------------

export interface CountSummaryRow {
  id: number;
  type: (typeof count.$inferSelect)["type"];
  status: (typeof count.$inferSelect)["status"];
  startedAt: Date;
  closedAt: Date | null;
  notes: string | null;
}

/** Any counting role may open a count (spec §4: all three roles count). */
export async function openCount(actor: Actor, input: OpenCountInput): Promise<CountSummaryRow> {
  const [inserted] = await db
    .insert(count)
    .values({
      type: input.type,
      status: "draft",
      openedBy: actor.userId,
      notes: input.notes,
    })
    .$returningId();

  const [row] = await db.select().from(count).where(eq(count.id, inserted.id)).limit(1);
  if (!row) {
    throw new NotFoundError("Count");
  }
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    startedAt: row.startedAt,
    closedAt: row.closedAt,
    notes: row.notes,
  };
}

async function assertCountWritable(
  tx: Tx,
  countId: number,
): Promise<(typeof count.$inferSelect)["status"]> {
  const [row] = await tx
    .select({ status: count.status })
    .from(count)
    .where(eq(count.id, countId))
    .for("update");
  if (!row) {
    throw new NotFoundError("Count");
  }
  if (row.status === "closed") {
    throw new ClosedCountError();
  }
  return row.status;
}

// ---------------------------------------------------------------------------
// Shared line shaping
// ---------------------------------------------------------------------------

export interface CountLineRow {
  id: number;
  countId: number;
  productId: number;
  locationId: number;
  sealedCaseQty: number;
  sealedEachQty: number;
  partialFills: number[];
  units: number | null;
  /** Only present for an owner caller (invariant 8). */
  unitCostAtCount?: string | null;
  caseSizeAtCount: number | null;
  extendedValue?: number | null;
}

function toValuationLine(row: CountLineRecord): ValuationLine {
  return {
    sealedCaseQty: row.sealedCaseQty,
    sealedEachQty: row.sealedEachQty,
    partialFills: row.partialFills,
    unitCostAtCount: row.unitCostAtCount,
    caseSizeAtCount: row.caseSizeAtCount,
  };
}

function toCountLineRow(role: Actor["role"], row: CountLineRecord): CountLineRow {
  const valuation = computeLineValuation(toValuationLine(row));
  const base: CountLineRow = {
    id: row.id,
    countId: row.countId,
    productId: row.productId,
    locationId: row.locationId,
    sealedCaseQty: row.sealedCaseQty,
    sealedEachQty: row.sealedEachQty,
    partialFills: row.partialFills,
    units: valuation.units,
    caseSizeAtCount: row.caseSizeAtCount,
  };
  // Cost is only attached to the returned object for a caller with cost
  // visibility (CLAUDE.md invariant 8) — a staff/manager caller never
  // receives `unitCostAtCount`/`extendedValue` in the response shape, full
  // stop, regardless of what's in the database row we read.
  if (canSeeCost(role)) {
    base.unitCostAtCount = row.unitCostAtCount;
    base.extendedValue = valuation.extendedValue;
  }
  return base;
}

/**
 * The ledger pre-check / post-rollback lookup described in the file header:
 * given a `client_line_id`, find the count_line an earlier, already-applied
 * write for it produced. Two round trips (ledger -> line) rather than one
 * join, kept simple and consistent with every other read in this file.
 */
async function findReplayedLine(clientLineId: string): Promise<CountLineRecord | null> {
  const [ledgerRow] = await db
    .select({ countLineId: countLineWrite.countLineId })
    .from(countLineWrite)
    .where(eq(countLineWrite.clientLineId, clientLineId))
    .limit(1);
  if (!ledgerRow) {
    return null;
  }
  const [line] = await db
    .select()
    .from(countLine)
    .where(eq(countLine.id, ledgerRow.countLineId))
    .limit(1);
  return line ?? null;
}

// ---------------------------------------------------------------------------
// count_line insert-or-increment (invariants 2, 3, 4) — the composite-key
// half of the write. Owns ONLY the (count_id, product_id, location_id)
// unique constraint; knows nothing about client_line_id/the ledger.
// ---------------------------------------------------------------------------

interface UpsertCountLineParams {
  countId: number;
  productId: number;
  locationId: number;
  sealedCaseQtyDelta: number;
  sealedEachQtyDelta: number;
  newPartialFills: number[];
  openedAt?: string;
  actorId: number;
}

async function upsertCountLineRow(
  tx: Tx,
  params: UpsertCountLineParams,
): Promise<CountLineRecord> {
  const [existing] = await tx
    .select()
    .from(countLine)
    .where(
      and(
        eq(countLine.countId, params.countId),
        eq(countLine.productId, params.productId),
        eq(countLine.locationId, params.locationId),
      ),
    )
    .for("update");

  if (existing) {
    const nextPartialFills = [...existing.partialFills, ...params.newPartialFills];
    await tx
      .update(countLine)
      .set({
        sealedCaseQty: existing.sealedCaseQty + params.sealedCaseQtyDelta,
        sealedEachQty: existing.sealedEachQty + params.sealedEachQtyDelta,
        partialFills: nextPartialFills,
        countedBy: params.actorId,
        countedAt: new Date(),
        ...(params.openedAt ? { openedAt: params.openedAt } : {}),
      })
      .where(eq(countLine.id, existing.id));
    const [updated] = await tx
      .select()
      .from(countLine)
      .where(eq(countLine.id, existing.id))
      .limit(1);
    if (!updated) throw new NotFoundError("Count line");
    return updated;
  }

  // First write for this (count, product, location). Snapshot cost/case
  // size from the product NOW (invariant 2) — this value must never be
  // re-read live once written.
  const [productRow] = await tx
    .select({ currentUnitCost: product.currentUnitCost, caseSize: product.caseSize })
    .from(product)
    .where(eq(product.id, params.productId))
    .limit(1);
  if (!productRow) {
    throw new NotFoundError("Product");
  }

  try {
    const [inserted] = await tx
      .insert(countLine)
      .values({
        countId: params.countId,
        productId: params.productId,
        locationId: params.locationId,
        sealedCaseQty: params.sealedCaseQtyDelta,
        sealedEachQty: params.sealedEachQtyDelta,
        partialFills: params.newPartialFills,
        unitCostAtCount: productRow.currentUnitCost,
        caseSizeAtCount: productRow.caseSize,
        countedBy: params.actorId,
        ...(params.openedAt ? { openedAt: params.openedAt } : {}),
      })
      .$returningId();
    const [created] = await tx
      .select()
      .from(countLine)
      .where(eq(countLine.id, inserted.id))
      .limit(1);
    if (!created) throw new NotFoundError("Count line");
    return created;
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
    // The composite-key unique index firing — count_line has no other
    // unique index left on it (client_line_id moved to count_line_write),
    // so this can only mean a concurrent request for the same (count,
    // product, location) won the insert between our SELECT ... FOR UPDATE
    // finding nothing and this INSERT. A genuine concurrent scan, not a
    // replay — recover by re-reading and incrementing.
    const [raced] = await tx
      .select()
      .from(countLine)
      .where(
        and(
          eq(countLine.countId, params.countId),
          eq(countLine.productId, params.productId),
          eq(countLine.locationId, params.locationId),
        ),
      )
      .for("update");
    if (!raced) {
      throw err;
    }
    const nextPartialFills = [...raced.partialFills, ...params.newPartialFills];
    await tx
      .update(countLine)
      .set({
        sealedCaseQty: raced.sealedCaseQty + params.sealedCaseQtyDelta,
        sealedEachQty: raced.sealedEachQty + params.sealedEachQtyDelta,
        partialFills: nextPartialFills,
        countedBy: params.actorId,
        countedAt: new Date(),
      })
      .where(eq(countLine.id, raced.id));
    const [updated] = await tx
      .select()
      .from(countLine)
      .where(eq(countLine.id, raced.id))
      .limit(1);
    if (!updated) throw new NotFoundError("Count line");
    return updated;
  }
}

// ---------------------------------------------------------------------------
// Increment path (invariants 2, 3, 4, 5)
// ---------------------------------------------------------------------------

interface IncrementDelta {
  countId: number;
  productId: number;
  locationId: number;
  clientLineId: string;
  sealedCaseQtyDelta: number;
  sealedEachQtyDelta: number;
  newPartialFills: number[];
  openedAt?: string;
}

async function applyIncrement(actor: Actor, delta: IncrementDelta): Promise<CountLineRow> {
  // Fast-path pre-check — see the file header. Not the correctness
  // mechanism, just avoids opening a transaction we already know would
  // roll back for the common "ack was lost but the write landed" retry.
  const preexisting = await findReplayedLine(delta.clientLineId);
  if (preexisting) {
    return toCountLineRow(actor.role, preexisting);
  }

  let appliedLine: CountLineRecord | null = null;
  let replayLine: CountLineRecord | null = null;

  try {
    appliedLine = await db.transaction(async (tx) => {
      await assertCountWritable(tx, delta.countId);

      const line = await upsertCountLineRow(tx, {
        countId: delta.countId,
        productId: delta.productId,
        locationId: delta.locationId,
        sealedCaseQtyDelta: delta.sealedCaseQtyDelta,
        sealedEachQtyDelta: delta.sealedEachQtyDelta,
        newPartialFills: delta.newPartialFills,
        openedAt: delta.openedAt,
        actorId: actor.userId,
      });

      // Ledger insert SECOND, deliberately not caught here. A duplicate-key
      // violation on client_line_id must roll back everything
      // upsertCountLineRow just did — see the file header.
      await tx.insert(countLineWrite).values({
        countLineId: line.id,
        countId: delta.countId,
        writtenBy: actor.userId,
        sealedCaseDelta: delta.sealedCaseQtyDelta,
        sealedEachDelta: delta.sealedEachQtyDelta,
        partialFillsDelta: delta.newPartialFills,
        clientLineId: delta.clientLineId,
      });

      return line;
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
    // Replay: the transaction rolled back in full, so nothing from this
    // attempt persisted. Re-read whatever an earlier, already-committed
    // write left behind and hand it back as an ordinary success — a
    // retrying client must get the same answer it would have gotten the
    // first time, never an error.
    replayLine = await findReplayedLine(delta.clientLineId);
    if (!replayLine) {
      // Unreachable in practice: a duplicate-key error on this ledger's
      // only unique index means a row with this client_line_id exists.
      // Surface the original error rather than silently returning nothing.
      throw err;
    }
  }

  if (appliedLine) {
    // Only promote a genuinely new write — a replay changed nothing, so
    // there's nothing new to promote the count for. Not folded into the
    // transaction above: it's a status change on a different row that
    // doesn't need the same lock, and a second racing promotion is
    // harmless (idempotent — both just set the same value).
    await db
      .update(count)
      .set({ status: "in_progress" })
      .where(and(eq(count.id, delta.countId), eq(count.status, "draft")));
  }

  const finalLine = appliedLine ?? replayLine;
  if (!finalLine) {
    throw new NotFoundError("Count line");
  }
  return toCountLineRow(actor.role, finalLine);
}

/** Manual increment by product id (e.g. typed "3 cases" for sealed backstock). */
export async function incrementCountLine(
  actor: Actor,
  input: IncrementCountLineInput,
): Promise<CountLineRow> {
  return applyIncrement(actor, {
    countId: input.countId,
    productId: input.productId,
    locationId: input.locationId,
    clientLineId: input.clientLineId,
    sealedCaseQtyDelta: input.sealedCaseQtyDelta,
    sealedEachQtyDelta: input.sealedEachQtyDelta,
    newPartialFills: input.newPartialFills,
    openedAt: input.openedAt,
  });
}

/**
 * Barcode-driven increment: resolves the product server-side from the scan
 * (never trusts a client-supplied product id for this path) and applies the
 * scanned quantity to the correct bucket based on the barcode's pack_level —
 * a case barcode increments `sealed_case_qty`, an each barcode increments
 * `sealed_each_qty`. Invariant 4: these are never converted into each other.
 */
export async function scanCountLine(
  actor: Actor,
  input: ScanCountLineInput,
): Promise<CountLineRow> {
  const resolved = await resolveBarcodeForCount(input.barcode);
  if (!resolved) {
    throw new NotFoundError("Product for this barcode");
  }
  return applyIncrement(actor, {
    countId: input.countId,
    productId: resolved.productId,
    locationId: input.locationId,
    clientLineId: input.clientLineId,
    sealedCaseQtyDelta: resolved.packLevel === "case" ? input.qty : 0,
    sealedEachQtyDelta: resolved.packLevel === "each" ? input.qty : 0,
    newPartialFills: [],
  });
}

// ---------------------------------------------------------------------------
// Corrections — absolute SETs, not increments. Both still need the ledger:
// naturally idempotent at the count_line level (setting the same target
// twice ends at the same value either way) does NOT mean idempotent at the
// ledger/audit-trail level, since the delta a correction represents depends
// on the row's state at the moment it's applied — see setCountLineQuantities
// below for exactly how that delta is computed and why.
// ---------------------------------------------------------------------------

/**
 * Correct `sealed_case_qty`/`sealed_each_qty` to an absolute value. The
 * scan/increment path is additive-only (CLAUDE.md invariant 3/5's whole
 * design assumes deltas), so a manager who typed 5 cases instead of 3 has no
 * way to fix it through scanning — there's no such thing as "scan
 * negative 2." This is that fix.
 *
 * **How an absolute SET represents itself in a delta-shaped ledger:**
 * `count_line_write`'s `sealed_case_delta`/`sealed_each_delta` columns exist
 * so that summing every write's delta for a line reconstructs its current
 * state from scratch (db/schema.ts's comment above `countLineWrite`) — that
 * property has to keep holding for corrections too, not just increments. So
 * this does NOT store the absolute target in the ledger; it computes
 * `delta = target - current` (using the value under the row lock taken
 * below, not whatever the client thought the previous value was) and stores
 * that. A correction from 3 cases to 5 records `sealed_case_delta: +2`,
 * identical in shape to what a real 2-case increment would have recorded —
 * the ledger can't tell a correction from a very well-timed scan, which is
 * exactly what keeps "sum the deltas" a correct reconstruction either way.
 */
export async function setCountLineQuantities(
  actor: Actor,
  input: SetCountLineQuantitiesInput,
): Promise<CountLineRow> {
  const preexisting = await findReplayedLine(input.clientLineId);
  if (preexisting) {
    return toCountLineRow(actor.role, preexisting);
  }

  let appliedLine: CountLineRecord | null = null;
  let replayLine: CountLineRecord | null = null;

  try {
    appliedLine = await db.transaction(async (tx) => {
      // Same count-then-count_line lock order as applyIncrement/
      // editCountLineFills — see the deadlock-avoidance comment in
      // editCountLineFills below for why this matters.
      const [unlocked] = await tx
        .select({ countId: countLine.countId })
        .from(countLine)
        .where(eq(countLine.id, input.countLineId))
        .limit(1);
      if (!unlocked) {
        throw new NotFoundError("Count line");
      }
      await assertCountWritable(tx, unlocked.countId);

      const [line] = await tx
        .select()
        .from(countLine)
        .where(eq(countLine.id, input.countLineId))
        .for("update");
      if (!line) {
        throw new NotFoundError("Count line");
      }

      await tx
        .update(countLine)
        .set({
          sealedCaseQty: input.sealedCaseQty,
          sealedEachQty: input.sealedEachQty,
          countedBy: actor.userId,
          countedAt: new Date(),
        })
        .where(eq(countLine.id, input.countLineId));

      // Ledger insert SECOND, not caught here — same reasoning as
      // applyIncrement: a duplicate-key on client_line_id must roll back
      // the SET above along with it.
      await tx.insert(countLineWrite).values({
        countLineId: line.id,
        countId: line.countId,
        writtenBy: actor.userId,
        sealedCaseDelta: input.sealedCaseQty - line.sealedCaseQty,
        sealedEachDelta: input.sealedEachQty - line.sealedEachQty,
        partialFillsDelta: [],
        clientLineId: input.clientLineId,
      });

      const [updated] = await tx
        .select()
        .from(countLine)
        .where(eq(countLine.id, input.countLineId))
        .limit(1);
      if (!updated) throw new NotFoundError("Count line");
      return updated;
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
    replayLine = await findReplayedLine(input.clientLineId);
    if (!replayLine) {
      throw err;
    }
  }

  const finalLine = appliedLine ?? replayLine;
  if (!finalLine) {
    throw new NotFoundError("Count line");
  }
  return toCountLineRow(actor.role, finalLine);
}

// ---------------------------------------------------------------------------
// Edit fills — a correction to partial_fills, not a scan. Naturally
// idempotent at the count_line level (a SET). Does NOT currently write a
// count_line_write ledger entry — see this session's report for why that's
// a deliberate scope decision, not an oversight, and what it costs.
// ---------------------------------------------------------------------------

export async function editCountLineFills(
  actor: Actor,
  input: EditCountLineFillsInput,
): Promise<CountLineRow> {
  const updated = await db.transaction(async (tx) => {
    // Lock ordering matters here: applyIncrement/setCountLineQuantities
    // always lock `count` before `count_line`. If this function locked
    // `count_line` first (by going straight to `SELECT ... FOR UPDATE` on
    // it) and only then locked `count`, two concurrent transactions taking
    // opposite lock orders could deadlock under load (a scan and a
    // fill-edit on the same line, at the same time). This unlocked lookup
    // just discovers which count owns the line, so the row lock below can
    // follow the same count-then-line order as every other write path.
    const [unlocked] = await tx
      .select({ countId: countLine.countId })
      .from(countLine)
      .where(eq(countLine.id, input.countLineId))
      .limit(1);
    if (!unlocked) {
      throw new NotFoundError("Count line");
    }
    await assertCountWritable(tx, unlocked.countId);

    const [line] = await tx
      .select()
      .from(countLine)
      .where(eq(countLine.id, input.countLineId))
      .for("update");
    if (!line) {
      throw new NotFoundError("Count line");
    }

    await tx
      .update(countLine)
      .set({
        partialFills: input.partialFills,
        countedBy: actor.userId,
        countedAt: new Date(),
      })
      .where(eq(countLine.id, input.countLineId));

    const [row] = await tx
      .select()
      .from(countLine)
      .where(eq(countLine.id, input.countLineId))
      .limit(1);
    if (!row) throw new NotFoundError("Count line");
    return row;
  });
  return toCountLineRow(actor.role, updated);
}

// ---------------------------------------------------------------------------
// Lifecycle: draft -> in_progress -> submitted -> reviewed -> closed
// ---------------------------------------------------------------------------

async function transitionCount(
  countId: number,
  from: (typeof count.$inferSelect)["status"][],
  to: (typeof count.$inferSelect)["status"],
  extra?: Partial<typeof count.$inferInsert>,
): Promise<typeof count.$inferSelect> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(count)
      .where(eq(count.id, countId))
      .for("update");
    if (!row) {
      throw new NotFoundError("Count");
    }
    if (!from.includes(row.status)) {
      throw new InvalidCountTransitionError(
        `Count must be ${from.join(" or ")} to move to ${to}, but it is ${row.status}.`,
      );
    }
    await tx
      .update(count)
      .set({ status: to, ...extra })
      .where(eq(count.id, countId));
    const [updated] = await tx.select().from(count).where(eq(count.id, countId)).limit(1);
    if (!updated) throw new NotFoundError("Count");
    return updated;
  });
}

/** Whoever was counting marks it done. Any counting role. */
export async function submitCount(countId: number): Promise<CountSummaryRow> {
  const row = await transitionCount(countId, ["draft", "in_progress"], "submitted");
  return row;
}

/** Supervisory step — owner/manager only (enforced by the action layer too). */
export async function reviewCount(countId: number): Promise<CountSummaryRow> {
  const row = await transitionCount(countId, ["submitted"], "reviewed");
  return row;
}

// ---------------------------------------------------------------------------
// Count totals (shared by closeCount and the live count-session screen)
// ---------------------------------------------------------------------------

/**
 * Raw, ungated totals for a count. Deliberately private: `totalValue` here is
 * the true figure regardless of who asked, because `closeCount` must persist
 * the real number onto `count.total_value` even when a manager is the one
 * closing. Role gating happens in `getCountTotals` below, which is what
 * anything read-facing calls.
 *
 * Takes an executor so `closeCount` can run it inside its own transaction —
 * on the same `FOR UPDATE`-locked snapshot it is about to write from — while
 * the live screen runs it against the pool. Two callers, one implementation:
 * the whole point of docs/open-items.md item 8, since a displayed total that
 * disagrees with the total `closeCount` writes a second later means the user
 * saw one number and the immutable record holds another, with no edit path to
 * reconcile them (invariant 1).
 */
type Executor = Tx | typeof db;

async function computeCountTotals(
  executor: Executor,
  countId: number,
): Promise<ReturnType<typeof summarizeValuation> & { lineCount: number }> {
  const lines = await executor.select().from(countLine).where(eq(countLine.countId, countId));
  return {
    ...summarizeValuation(lines.map(toValuationLine)),
    lineCount: lines.length,
  };
}

export interface CountTotals {
  countId: number;
  status: (typeof count.$inferSelect)["status"];
  lineCount: number;
  totalUnits: number;
  pricedLineCount: number;
  /**
   * Lines counted but excluded from valuation — no cost snapshot, no case
   * size snapshot, or both. Surfaced continuously rather than only at close
   * because on the current catalog it will fire constantly: no product has a
   * `case_size` yet and only the 9 draft kegs carry a cost, so a count taken
   * today is almost entirely unpriced (docs/open-items.md item 4). A user
   * needs to see that while counting, not discover it at the close screen.
   */
  excludedLineCount: number;
  /** Owner only (invariant 8) — absent, not zero, for manager and staff. */
  totalValue?: number;
}

/**
 * Live progress totals for an in-progress count. Safe to poll — it holds no
 * locks and writes nothing.
 *
 * `totalValue` is gated to owners exactly as `closeCount`'s response is, so
 * the CLOSE COUNT button can print the same figure the close will compute
 * without a manager ever seeing a dollar amount they are not entitled to.
 */
export async function getCountTotals(actor: Actor, countId: number): Promise<CountTotals> {
  const [row] = await db
    .select({ status: count.status })
    .from(count)
    .where(eq(count.id, countId))
    .limit(1);
  if (!row) {
    throw new NotFoundError("Count");
  }

  const totals = await computeCountTotals(db, countId);

  const result: CountTotals = {
    countId,
    status: row.status,
    lineCount: totals.lineCount,
    totalUnits: totals.totalUnits,
    pricedLineCount: totals.pricedLineCount,
    excludedLineCount: totals.excludedLineCount,
  };
  if (canSeeCost(actor.role)) {
    result.totalValue = totals.totalValue;
  }
  return result;
}

/**
 * Locks the count. Computes and stores `total_value` from every line's
 * snapshot cost (invariant 2 — never from current product data), excluding
 * unpriced/unsized lines from the total rather than coercing them to $0
 * (invariant 2 / valuation.ts). The response is still role-shaped by the
 * caller (reports/counts action layer) — see lib/domain/reports.ts.
 *
 * Totals come from the same `computeCountTotals` the live session screen
 * reads through, so the figure shown on the CLOSE COUNT button and the figure
 * written to `count.total_value` cannot drift apart.
 */
export async function closeCount(
  actor: Actor,
  countId: number,
): Promise<{
  count: CountSummaryRow;
  totals: ReturnType<typeof summarizeValuation> & { lineCount: number };
}> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(count)
      .where(eq(count.id, countId))
      .for("update");
    if (!row) {
      throw new NotFoundError("Count");
    }
    if (row.status !== "reviewed") {
      throw new InvalidCountTransitionError(
        `Count must be reviewed to be closed, but it is ${row.status}.`,
      );
    }

    const totals = await computeCountTotals(tx, countId);

    await tx
      .update(count)
      .set({
        status: "closed",
        closedAt: new Date(),
        closedBy: actor.userId,
        totalValue: totals.totalValue.toFixed(2),
      })
      .where(eq(count.id, countId));

    const [updated] = await tx.select().from(count).where(eq(count.id, countId)).limit(1);
    if (!updated) throw new NotFoundError("Count");

    return {
      count: {
        id: updated.id,
        type: updated.type,
        status: updated.status,
        startedAt: updated.startedAt,
        closedAt: updated.closedAt,
        notes: updated.notes,
      },
      totals,
    };
  });
}

// ---------------------------------------------------------------------------
// Read a count with its lines (role-shaped)
// ---------------------------------------------------------------------------

/**
 * A count line with enough product/location context to render a row without
 * a second round trip.
 *
 * Only `getCount` returns this shape. The write paths (scan, increment, set,
 * edit) deliberately keep returning the lean `CountLineRow`: they are on the
 * count loop's latency budget, and the caller of a scan already knows which
 * product it resolved — making every write pay for a join to re-tell it the
 * name would be a per-scan cost for information the client already holds.
 */
export interface CountLineDetail extends CountLineRow {
  productName: string;
  productBrand: string | null;
  category: string;
  unitType: (typeof product.$inferSelect)["unitType"];
  sizeMl: number;
  locationName: string;
}

export interface CountDetail {
  count: CountSummaryRow;
  lines: CountLineDetail[];
}

export async function getCount(actor: Actor, countId: number): Promise<CountDetail> {
  const [row] = await db.select().from(count).where(eq(count.id, countId)).limit(1);
  if (!row) {
    throw new NotFoundError("Count");
  }
  const lines = await db
    .select({
      line: countLine,
      productName: product.name,
      productBrand: product.brand,
      category: product.category,
      unitType: product.unitType,
      sizeMl: product.sizeMl,
      locationName: location.name,
    })
    .from(countLine)
    .innerJoin(product, eq(product.id, countLine.productId))
    .innerJoin(location, eq(location.id, countLine.locationId))
    .where(eq(countLine.countId, countId))
    .orderBy(desc(countLine.countedAt));

  return {
    count: {
      id: row.id,
      type: row.type,
      status: row.status,
      startedAt: row.startedAt,
      closedAt: row.closedAt,
      notes: row.notes,
    },
    lines: lines.map((r) => ({
      ...toCountLineRow(actor.role, r.line),
      productName: r.productName,
      productBrand: r.productBrand,
      category: r.category,
      unitType: r.unitType,
      sizeMl: r.sizeMl,
      locationName: r.locationName,
    })),
  };
}

// ---------------------------------------------------------------------------
// List counts (back-office counts screen)
// ---------------------------------------------------------------------------

export interface CountListRow extends CountSummaryRow {
  openedByName: string | null;
  closedByName: string | null;
  /**
   * Owner only (invariant 8). Read from the stored `count.total_value`
   * snapshot rather than recomputed, so a closed count in this list always
   * shows exactly the figure that was locked in at close time — never a
   * value re-derived from data that may have moved since. Null for any count
   * that isn't closed yet, since the column is only written at close.
   */
  totalValue?: number | null;
}

/**
 * The counts list. `count` joined against `user` twice — once for who opened
 * it, once for who closed it — which needs two aliases of the same table
 * rather than two joins to the same name.
 *
 * A LEFT join on both sides on purpose: `closed_by` is null for every count
 * that isn't closed, and an inner join would silently drop exactly the
 * in-progress counts this screen exists to show. `opened_by` is NOT NULL in
 * the schema, but is still left-joined so a future user row disappearing
 * cannot make history vanish from the list (invariant 6's spirit — history
 * outlives the rows it references).
 */
export async function listCounts(actor: Actor, limit = 50): Promise<CountListRow[]> {
  const opener = alias(user, "opener");
  const closer = alias(user, "closer");

  const rows = await db
    .select({
      id: count.id,
      type: count.type,
      status: count.status,
      startedAt: count.startedAt,
      closedAt: count.closedAt,
      notes: count.notes,
      totalValue: count.totalValue,
      openedByName: opener.name,
      closedByName: closer.name,
    })
    .from(count)
    .leftJoin(opener, eq(opener.id, count.openedBy))
    .leftJoin(closer, eq(closer.id, count.closedBy))
    .orderBy(desc(count.startedAt))
    .limit(limit);

  const showCost = canSeeCost(actor.role);

  return rows.map((r) => {
    const row: CountListRow = {
      id: r.id,
      type: r.type,
      status: r.status,
      startedAt: r.startedAt,
      closedAt: r.closedAt,
      notes: r.notes,
      openedByName: r.openedByName,
      closedByName: r.closedByName,
    };
    if (showCost) {
      row.totalValue = r.totalValue == null ? null : Number(r.totalValue);
    }
    return row;
  });
}

/**
 * The count currently being worked, if any — the counting app's entry point.
 *
 * Deliberately separate from `listCounts`, which is owner/manager only. A
 * staff member is count-only (spec §4) and has no back-office history
 * surface, but still has to be able to walk up to the bar phone and join the
 * count in progress. Making them depend on someone handing over a URL would
 * fail the "faster than a clipboard on day one" test the whole project is
 * judged on. This read answers exactly one question — "what am I working
 * on?" — and exposes no history and no value.
 *
 * Returns the most recently started count that is not yet closed. The MVP
 * assumes one count in flight at a time; if two were ever open, the newer is
 * the one someone walking up is being handed.
 */
export async function getActiveCount(): Promise<CountSummaryRow | null> {
  const [row] = await db
    .select()
    .from(count)
    .where(ne(count.status, "closed"))
    .orderBy(desc(count.startedAt))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    startedAt: row.startedAt,
    closedAt: row.closedAt,
    notes: row.notes,
  };
}

// Re-exported so report modules can build ValuationLine[] from raw
// count_line rows the same way this module does, without duplicating the
// mapping.
export { toValuationLine };
export type { ValuationLine };
