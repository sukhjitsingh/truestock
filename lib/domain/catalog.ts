/**
 * Catalog domain functions. Server actions call these; no business logic
 * lives in app/actions or components (CLAUDE.md "rules of work").
 *
 * Cost gating (CLAUDE.md invariant 8): every read function here takes the
 * caller's `Role` and decides, in the query itself, whether
 * `current_unit_cost` is even selected — not just whether it's attached to
 * the response object afterward. A staff or manager caller's SQL never
 * fetches the column, so there is no code path where it could accidentally
 * end up in a response to them.
 */
import { and, eq, inArray, isNull, like, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { product, productBarcode, productPar, vendor, location } from "@/db/schema";
import type { Actor } from "@/lib/authz";
import { canSeeCost, canManageCost } from "@/lib/authz";
import { ConflictError, NotFoundError } from "@/lib/domain/errors";
import { isDuplicateKeyError } from "@/lib/domain/db-errors";
import { getOnHandSnapshot } from "@/lib/domain/on-hand";
import { isCountedByCase } from "@/lib/pack-level";
import type {
  ProductCreateInput,
  ProductUpdateInput,
  ProductSearchInput,
  LinkBarcodeInput,
} from "@/lib/validation/catalog";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ProductSummary {
  id: number;
  name: string;
  brand: string | null;
  category: string;
  subcategory: string | null;
  unitType: (typeof product.$inferSelect)["unitType"];
  sizeMl: number;
  caseSize: number | null;
  vendorId: number | null;
  active: boolean;
  /** Present only for callers with cost visibility (owner). */
  currentUnitCost?: string;
  /**
   * Why this product isn't fully usable yet — empty when it is fine. Derived
   * on every read, never stored; see `ProductIncompleteReason`. Drives the
   * catalog's "Needs attention" view and its per-row pills.
   */
  incomplete: ProductIncompleteReason[];
  /**
   * Stock figures. Present only when the caller asked for them
   * (`includeOnHand`) — see `searchProducts` for why this is opt-in rather
   * than always attached. Not cost-gated: quantities and par levels are not
   * cost data, and a manager runs reordering (spec §4).
   */
  stock?: ProductStock;
}

/**
 * Why a product is not yet fully usable. DECIDED 2026-07-26
 * (docs/open-items.md item 9): incompleteness is a **derived predicate**, not
 * stored state — there is no `incomplete` column and there should not be one.
 * A stored flag would need maintaining on every write path and would drift
 * out of agreement with the data it describes; these facts are already in the
 * row.
 *
 * What matters is that the definition lives here, once. The prototype
 * inferred "needs producer" from category plus a null brand in the markup,
 * which is how three screens end up with three different ideas of incomplete.
 *
 * - `needs_producer` — a wine seeded as a varietal (`Merlot`, `Chardonnay`)
 *   rather than a specific bottle. It cannot be costed or scanned until it
 *   names a producer.
 * - `needs_cost` — no `current_unit_cost`, so this product's lines are
 *   excluded from every valuation. Owner-only: a manager has no cost
 *   visibility at all (invariant 8), and "this has no cost set" is still a
 *   statement about cost.
 * - `needs_case_size` — bottled beer with no `case_size`. Only beer is
 *   counted by the case; a NULL case size on a spirit, wine or keg is correct
 *   rather than missing (CLAUDE.md, "The catalog"), so this deliberately does
 *   not fire on them.
 * - `needs_par` — no `product_par` row, so this product can never appear on
 *   the reorder list no matter how far it runs down. Unlike the others this
 *   is not derivable from the product row, so it is attached in
 *   `attachStock` and therefore only appears when a caller asked for stock
 *   figures (`includeOnHand`). That is the right split rather than a
 *   limitation: the back-office catalog is the screen whose job is flagging
 *   catalog decay, and the count-time picker would pay for a join to render
 *   a pill nobody mid-count can act on.
 */
export type ProductIncompleteReason =
  | "needs_producer"
  | "needs_cost"
  | "needs_case_size"
  | "needs_par";

interface IncompletenessInput {
  brand: string | null;
  category: string;
  unitType: (typeof product.$inferSelect)["unitType"];
  caseSize: number | null;
  currentUnitCost?: string;
}

function incompleteReasons(row: IncompletenessInput, showCost: boolean): ProductIncompleteReason[] {
  const reasons: ProductIncompleteReason[] = [];
  const category = row.category.toLowerCase();

  if (category === "wine" && !row.brand) {
    reasons.push("needs_producer");
  }
  // Bottled beer is the only thing counted both as eaches and as cases, so
  // it is the only thing a missing case size is a gap for. That rule now
  // lives in lib/pack-level.ts because the barcode-link screen asks the same
  // question — see there for why it is shared rather than repeated.
  if (isCountedByCase(row) && row.caseSize == null) {
    reasons.push("needs_case_size");
  }
  if (showCost && !row.currentUnitCost) {
    reasons.push("needs_cost");
  }
  return reasons;
}

export interface ProductStock {
  /** Units on hand from the latest closed count; null when none exists yet. */
  onHand: number | null;
  /**
   * True when at least one contributing count line had indeterminate units
   * (sealed cases with no case-size snapshot). `onHand` is then a floor, not
   * a total, and the UI must not render it as a plain number — this is
   * currently the common case, since no product has a `case_size` yet
   * (docs/open-items.md item 4).
   */
  onHandIsPartial: boolean;
  /** MVP writes overall par rows only (location_id IS NULL) — spec §8. */
  parLevel: number | null;
  reorderPoint: number | null;
  /** The closed count `onHand` was derived from; null when none exists. */
  asOfCountId: number | null;
}

const BASE_PRODUCT_COLUMNS = {
  id: product.id,
  name: product.name,
  brand: product.brand,
  category: product.category,
  subcategory: product.subcategory,
  unitType: product.unitType,
  sizeMl: product.sizeMl,
  caseSize: product.caseSize,
  vendorId: product.vendorId,
  active: product.active,
} as const;

/**
 * Selects the column set appropriate to `role` — cost is not fetched at all
 * for a caller who can't see it, so there is nothing to accidentally leak
 * downstream. This is the "gate in the query" half of invariant 8; the
 * `currentUnitCost` key is likewise never added to the returned object for
 * anyone but an owner.
 */
async function selectProducts(
  actor: Actor,
  where: SQL | undefined,
  limit: number,
): Promise<ProductSummary[]> {
  // The tenant filter is applied HERE, not by callers, so no caller can
  // forget it. Every product read in this module goes through this function
  // for exactly that reason — a `where` built by a caller is always ANDed
  // with the organization, never used on its own.
  const scoped = and(eq(product.organizationId, actor.organizationId), where);

  if (canSeeCost(actor.role)) {
    const rows = await db
      .select({ ...BASE_PRODUCT_COLUMNS, currentUnitCost: product.currentUnitCost })
      .from(product)
      .where(scoped)
      .orderBy(product.name)
      .limit(limit);
    return rows.map((r) => {
      const currentUnitCost = r.currentUnitCost ?? undefined;
      return {
        ...r,
        currentUnitCost,
        incomplete: incompleteReasons({ ...r, currentUnitCost }, true),
      };
    });
  }
  const rows = await db
    .select(BASE_PRODUCT_COLUMNS)
    .from(product)
    .where(scoped)
    .orderBy(product.name)
    .limit(limit);
  return rows.map((r) => ({ ...r, incomplete: incompleteReasons(r, false) }));
}

// ---------------------------------------------------------------------------
// Search / list
// ---------------------------------------------------------------------------

/**
 * Search/list products, optionally with stock figures attached.
 *
 * `includeOnHand` is opt-in, and that is the decision docs/open-items.md
 * item 8 asked for: the catalog read owns the on-hand join rather than the
 * back office reimplementing what `reorderList()` already does — but it only
 * pays for it when asked. The two callers have opposite priorities. The
 * back-office catalog table wants a stock cell and runs at a desk. The
 * count-time product picker is on the app's latency-critical path (it is the
 * fallback for a damaged label, mid-count, one-handed) and must stay a single
 * indexed lookup — it would gain nothing from a scan of the last closed
 * count's lines. Attaching stock unconditionally would have quietly taxed the
 * one read that cannot afford it.
 */
export async function searchProducts(
  actor: Actor,
  input: ProductSearchInput,
): Promise<ProductSummary[]> {
  const conditions: SQL[] = [];
  if (input.activeOnly) {
    conditions.push(eq(product.active, true));
  }
  if (input.category) {
    conditions.push(eq(product.category, input.category));
  }
  if (input.query) {
    const needle = `%${input.query}%`;
    const nameOrBrand = or(like(product.name, needle), like(product.brand, needle));
    if (nameOrBrand) {
      conditions.push(nameOrBrand);
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const rows = await selectProducts(actor, where, input.limit);

  if (!input.includeOnHand || rows.length === 0) {
    return rows;
  }
  return attachStock(actor, rows);
}

/**
 * Attaches on-hand and par to an already-selected page of products. Two
 * queries total regardless of page size — the shared on-hand snapshot, and
 * one `IN (...)` over `product_par` for just the ids on this page.
 */
async function attachStock(actor: Actor, rows: ProductSummary[]): Promise<ProductSummary[]> {
  const ids = rows.map((r) => r.id);
  const [snapshot, parRows] = await Promise.all([
    getOnHandSnapshot(actor.organizationId),
    db
      .select({
        productId: productPar.productId,
        parLevel: productPar.parLevel,
        reorderPoint: productPar.reorderPoint,
      })
      .from(productPar)
      .where(
        and(
          eq(productPar.organizationId, actor.organizationId),
          inArray(productPar.productId, ids),
          isNull(productPar.locationId),
        ),
      ),
  ]);

  const parByProduct = new Map(parRows.map((p) => [p.productId, p]));

  return rows.map((row) => {
    const par = parByProduct.get(row.id);
    return {
      ...row,
      // A product with no par is invisible to the reorder list forever, and
      // that failure is silent at every layer above: the list simply renders
      // as though nothing is short. Saying so here is what makes it visible.
      incomplete: par == null ? [...row.incomplete, "needs_par" as const] : row.incomplete,
      stock: {
        // null rather than 0 when there is no closed count to derive from:
        // "we have never counted this" and "we counted it and there are none"
        // are different facts, and only one of them should read as empty.
        onHand: snapshot.asOfCountId == null ? null : (snapshot.byProduct.get(row.id) ?? 0),
        onHandIsPartial: snapshot.indeterminateProductIds.has(row.id),
        parLevel: par == null ? null : Number(par.parLevel),
        reorderPoint: par?.reorderPoint == null ? null : Number(par.reorderPoint),
        asOfCountId: snapshot.asOfCountId,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Barcode resolution — the single most latency-sensitive read in the app
// ---------------------------------------------------------------------------

export interface BarcodeResolution {
  product: ProductSummary;
  packLevel: (typeof productBarcode.$inferSelect)["packLevel"];
}

/**
 * One indexed lookup on `product_barcode.barcode` (unique index, see
 * db/schema.ts) followed by one primary-key lookup on `product` — both hit
 * indexes, no scans. Returns null (not a thrown error) on no match, since
 * "unknown barcode" is an expected, common outcome that routes to
 * scan-to-enroll rather than an error state.
 */
export async function resolveBarcode(
  actor: Actor,
  barcode: string,
): Promise<BarcodeResolution | null> {
  const [hit] = await db
    .select({ productId: productBarcode.productId, packLevel: productBarcode.packLevel })
    .from(productBarcode)
    .where(
      and(
        eq(productBarcode.organizationId, actor.organizationId),
        eq(productBarcode.barcode, barcode),
      ),
    )
    .limit(1);
  if (!hit) {
    return null;
  }
  const rows = await selectProducts(actor, eq(product.id, hit.productId), 1);
  const found = rows[0];
  if (!found) {
    return null;
  }
  return { product: found, packLevel: hit.packLevel };
}

/**
 * Lean barcode -> product id lookup used by the count-line scan path
 * (lib/domain/counts.ts). Deliberately returns no cost or display fields at
 * all — it's an id/pack_level resolution, not a payload — so there's no
 * role-gating decision to make here; the caller still checks the current
 * product's `unit_cost_at_count` snapshot value itself when writing the
 * count line, but that never flows back into a response to non-owner roles.
 */
export async function resolveBarcodeForCount(
  organizationId: number,
  barcode: string,
): Promise<{ productId: number; packLevel: (typeof productBarcode.$inferSelect)["packLevel"] } | null> {
  const [hit] = await db
    .select({ productId: productBarcode.productId, packLevel: productBarcode.packLevel })
    .from(productBarcode)
    .where(
      and(
        eq(productBarcode.organizationId, organizationId),
        eq(productBarcode.barcode, barcode),
      ),
    )
    .limit(1);
  return hit ?? null;
}

// ---------------------------------------------------------------------------
// Ownership checks for client-supplied foreign ids
// ---------------------------------------------------------------------------

/** `db` or a transaction handle — both expose the query builder used below. */
type Runner = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Invariant 9, the ownership-not-existence half: `vendor_id` arrives from the
 * client, and its foreign key only proves the vendor row EXISTS — not whose it
 * is. Without this check an owner or manager in Tenant A can point their own
 * product at Tenant B's vendor; ids are sequential autoincrement ints, so
 * guessing a live one is trivial.
 *
 * Why this was invisible, and why it still mattered: no current read path
 * renders a foreign vendor (`reorderList` in lib/domain/reports.ts builds its
 * vendor map from the caller's own organization-scoped list, so a foreign
 * vendor_id resolves to `vendorName: null`). So there was no live leak — but
 * the row permanently held a cross-tenant reference, and the first feature to
 * fetch a vendor by id directly (a vendor detail screen, or the invoice→vendor
 * join in docs/invoice-automation-research.md) would have leaked that vendor's
 * contact and lead time across tenants. Same bug class as the
 * `count_line.location_id` finding fixed in lib/domain/counts.ts on
 * 2026-07-27, which was never generalized. Schema audit 2026-07-27, B1.
 *
 * Raises NotFound, never Forbidden: invariant 9 requires that a cross-tenant
 * id be indistinguishable from one that doesn't exist, so the answer can't
 * confirm the row is real.
 */
async function assertVendorOwned(
  runner: Runner,
  organizationId: number,
  vendorId: number,
): Promise<void> {
  const [owned] = await runner
    .select({ id: vendor.id })
    .from(vendor)
    .where(and(eq(vendor.id, vendorId), eq(vendor.organizationId, organizationId)))
    .limit(1);
  if (!owned) {
    throw new NotFoundError("Vendor");
  }
}

/**
 * Invariant 9, same reasoning as `assertVendorOwned`: `product_id` arrives
 * from the client on the barcode-link path, and the composite tenant foreign
 * key would reject a cross-tenant id at the database — but as a 1452, which
 * surfaces as an opaque server error rather than the NotFound invariant 9
 * requires. Checking here means a foreign id is answered the same way a
 * nonexistent one is, and never confirms the row is real.
 */
async function assertProductOwned(
  runner: Runner,
  organizationId: number,
  productId: number,
): Promise<void> {
  const [owned] = await runner
    .select({ id: product.id })
    .from(product)
    .where(and(eq(product.id, productId), eq(product.organizationId, organizationId)))
    .limit(1);
  if (!owned) {
    throw new NotFoundError("Product");
  }
}

// ---------------------------------------------------------------------------
// Scan-to-enroll: link a scanned barcode to a product already in the catalog
// ---------------------------------------------------------------------------

/**
 * The "this bottle is already in the catalog, it just has no barcode yet"
 * path — which during the first count is the overwhelmingly common one, since
 * `upc` is deliberately blank on all 97 seeded products (CLAUDE.md) and fills
 * in through scanning.
 *
 * Without this, `createProduct` was the only enroll path, and typing the
 * catalog's own name for the bottle collided with
 * `product_name_size_ml_unique` and left the counter with an error and no way
 * forward, mid-count, on the app's highest-risk interaction. Typing a
 * *differing* name was worse rather than better: it succeeded, and produced a
 * second copy of a product the catalog already had, with the count split
 * silently across the two.
 *
 * `isPrimary` is derived, not accepted: the first barcode a product gets is
 * its primary one, and any later one is not. Letting the client decide would
 * allow two primaries on one product, which no constraint forbids and nothing
 * would notice.
 */
export async function linkBarcodeToProduct(
  actor: Actor,
  input: LinkBarcodeInput,
): Promise<ProductSummary> {
  await db.transaction(async (tx) => {
    // Inside the transaction so the product cannot be reassigned or
    // deactivated between the check and the insert.
    await assertProductOwned(tx, actor.organizationId, input.productId);

    const [existing] = await tx
      .select({ id: productBarcode.id })
      .from(productBarcode)
      .where(
        and(
          eq(productBarcode.organizationId, actor.organizationId),
          eq(productBarcode.productId, input.productId),
        ),
      )
      .limit(1);

    try {
      await tx.insert(productBarcode).values({
        organizationId: actor.organizationId,
        productId: input.productId,
        barcode: input.barcode,
        format: input.format,
        packLevel: input.packLevel,
        isPrimary: existing == null,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // product_barcode_organization_barcode_unique. Name who already holds
        // it — mid-count, "already assigned" without a name is a dead end,
        // and the answer is usually "you already scanned this one".
        const [owner] = await tx
          .select({ name: product.name })
          .from(productBarcode)
          .innerJoin(product, eq(product.id, productBarcode.productId))
          .where(
            and(
              eq(productBarcode.organizationId, actor.organizationId),
              eq(productBarcode.barcode, input.barcode),
            ),
          )
          .limit(1);
        throw new ConflictError(
          owner
            ? `Barcode ${input.barcode} is already assigned to "${owner.name}".`
            : `Barcode ${input.barcode} is already assigned to another product.`,
        );
      }
      throw err;
    }
  });

  const rows = await selectProducts(actor, eq(product.id, input.productId), 1);
  const result = rows[0];
  if (!result) {
    throw new NotFoundError("Product");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scan-to-enroll create
// ---------------------------------------------------------------------------

/**
 * Creates a product (and, if provided, its first ProductBarcode row — never
 * a `upc` column; see CLAUDE.md and db/schema.ts's comment on
 * `product_barcode` for why barcodes are one-to-many).
 *
 * Cost handling: `input.currentUnitCost` is well-formed by the time it
 * reaches here (Zod already validated it), but it is only ever written for
 * an `owner` caller. A manager/staff caller enrolling a new bottle mid-count
 * simply has the field silently ignored rather than the whole enrollment
 * rejected — rejecting would block the fast scan-to-enroll path (spec's
 * "under 20 seconds" requirement, the highest-risk interaction in the app)
 * over a field that role only needed to be allowed to leave blank anyway.
 * This is a deliberate write-side extension of invariant 8, not just a
 * read-side one: staff/manager never get to set cost either, matching "no
 * cost visibility" as a role property rather than only a response filter.
 */
export async function createProduct(
  actor: Actor,
  input: ProductCreateInput,
): Promise<ProductSummary> {
  const allowCost = canManageCost(actor.role);

  // Scan-to-enroll has a 20-second budget and is the app's highest-risk
  // interaction (CLAUDE.md) — a generic "Something went wrong" on the two
  // ways this can collide (same name+size already cataloged, or this exact
  // barcode already belongs to another product) is exactly the kind of dead
  // end that makes someone give up and walk away from the count. Both
  // collisions are caught here and turned into a `ConflictError` naming
  // what collided, not left to fall through to the generic error handler in
  // lib/action-result.ts.
  const created = await db.transaction(async (tx) => {
    // Inside the transaction so the vendor can't be reassigned between the
    // check and the insert.
    if (input.vendorId != null) {
      await assertVendorOwned(tx, actor.organizationId, input.vendorId);
    }

    let inserted: { id: number };
    try {
      [inserted] = await tx
        .insert(product)
        .values({
          organizationId: actor.organizationId,
          name: input.name,
          brand: input.brand,
          category: input.category,
          subcategory: input.subcategory,
          unitType: input.unitType,
          sizeMl: input.sizeMl,
          caseSize: input.caseSize,
          vendorId: input.vendorId,
          currentUnitCost: allowCost ? input.currentUnitCost : undefined,
        })
        .$returningId();
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // product_name_size_ml_unique
        throw new ConflictError(
          `A product named "${input.name}" at ${input.sizeMl}ml already exists.`,
        );
      }
      throw err;
    }

    if (input.barcode) {
      try {
        await tx.insert(productBarcode).values({
          organizationId: actor.organizationId,
          productId: inserted.id,
          barcode: input.barcode.barcode,
          format: input.barcode.format,
          packLevel: input.barcode.packLevel,
          isPrimary: input.barcode.isPrimary ?? true,
        });
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          // product_barcode_barcode_unique — look up who already has it so
          // the error names the actual collision, not just "duplicate".
          // Read inside the same (about-to-roll-back) transaction so this
          // sees a consistent snapshot with the failed insert above.
          const [owner] = await tx
            .select({ name: product.name })
            .from(productBarcode)
            .innerJoin(product, eq(product.id, productBarcode.productId))
            .where(
              and(
                eq(productBarcode.organizationId, actor.organizationId),
                eq(productBarcode.barcode, input.barcode.barcode),
              ),
            )
            .limit(1);
          throw new ConflictError(
            owner
              ? `Barcode ${input.barcode.barcode} is already assigned to "${owner.name}".`
              : `Barcode ${input.barcode.barcode} is already assigned to another product.`,
          );
        }
        throw err;
      }
    }

    return inserted.id;
  });

  const rows = await selectProducts(actor, eq(product.id, created), 1);
  const result = rows[0];
  if (!result) {
    throw new NotFoundError("Product");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Write (or clear) a product's OVERALL par — the `location_id IS NULL` row.
 *
 * Overall-only is the MVP convention (spec §8, and CLAUDE.md open question 2,
 * which is still open on purpose). `ProductPar.location_id` is nullable
 * precisely so per-location pars can be added later without a migration, and
 * writing NULL rows now is what keeps that question deferred rather than
 * answered by accident. The `location_scope` generated column enforces at
 * most one overall par per product at the database level, so a concurrent
 * double-write fails on the unique index rather than producing two.
 *
 * Passing `parLevel: null` deletes the row. "This product has no par" is a
 * real state — it is the state all 97 seeded products are in — and it has to
 * be reachable, or a par typed by mistake could never be taken back.
 */
async function upsertProductPar(
  runner: Runner,
  organizationId: number,
  productId: number,
  parLevel: number | null,
  reorderPoint: number | null | undefined,
): Promise<void> {
  const scope = and(
    eq(productPar.organizationId, organizationId),
    eq(productPar.productId, productId),
    isNull(productPar.locationId),
  );

  if (parLevel == null) {
    await runner.delete(productPar).where(scope);
    return;
  }

  // DECIMAL columns — drizzle's decimal mode is string in/out, so the
  // validated numbers are formatted here rather than passed through. Same
  // reasoning as `wasteFactor` below.
  const values = {
    parLevel: parLevel.toFixed(2),
    reorderPoint: reorderPoint == null ? null : reorderPoint.toFixed(2),
  };

  const updated = await runner.update(productPar).set(values).where(scope);
  if (updated[0].affectedRows > 0) {
    return;
  }
  await runner.insert(productPar).values({
    organizationId,
    productId,
    locationId: null,
    ...values,
  });
}

export async function updateProduct(
  actor: Actor,
  input: ProductUpdateInput,
): Promise<ProductSummary> {
  const allowCost = canManageCost(actor.role);
  const { productId, currentUnitCost, wasteFactor, parLevel, reorderPoint, ...rest } = input;

  const patch: Partial<typeof product.$inferInsert> = { ...rest };
  if (wasteFactor !== undefined) {
    // DECIMAL(4,3) column — drizzle's default decimal mode is string in/out
    // (see node_modules/drizzle-orm/mysql-core/columns/decimal.d.ts), so the
    // validated number has to be converted here, not passed through as-is.
    patch.wasteFactor = wasteFactor.toFixed(3);
  }
  if (allowCost && currentUnitCost !== undefined) {
    patch.currentUnitCost = currentUnitCost;
  }
  // Non-owner callers who included currentUnitCost in the request simply
  // have it ignored (same reasoning as createProduct above) rather than the
  // whole update rejected.

  // One transaction, because a product edit can now write two tables: the
  // product row and its `product_par` row. Saving the name and silently
  // dropping the par (or the reverse) would be a half-applied edit that the
  // form reports as success.
  await db.transaction(async (tx) => {
    // Existence and ownership, proven once and up front, before anything is
    // written (invariant 9 — a cross-tenant id is answered as NotFound).
    //
    // This ALSO replaces the previous `affectedRows === 0 -> NotFoundError`
    // check, which was subtly wrong and is now reachable in normal use.
    // mysql2 does not set CLIENT_FOUND_ROWS, so `affectedRows` counts rows
    // actually CHANGED, not rows matched — a save that submits identical
    // values matches the row, changes nothing, and reported "Product not
    // found". That was latent while every edit changed something; par levels
    // make "save the form having only touched the par" an ordinary action,
    // and it would have failed with an error naming the wrong thing.
    await assertProductOwned(tx, actor.organizationId, productId);

    // `null` is a legitimate value here — it clears the vendor — so only a
    // non-null id needs proving. See assertVendorOwned.
    if (patch.vendorId != null) {
      await assertVendorOwned(tx, actor.organizationId, patch.vendorId);
    }

    if (Object.keys(patch).length > 0) {
      try {
        // The organization predicate stays on the write as well: the check
        // above is the answer to the caller, this is the guarantee that a
        // cross-tenant row cannot be touched even if that check were skipped.
        await tx
          .update(product)
          .set(patch)
          .where(
            and(eq(product.id, productId), eq(product.organizationId, actor.organizationId)),
          );
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          // product_name_size_ml_unique — only reachable if this update
          // changes name and/or size_ml to a combination another product has.
          throw new ConflictError(
            "Another product already has this name and size. Choose a different name or size.",
          );
        }
        throw err;
      }
    }

    // `undefined` means the caller did not mention par at all, so leave it
    // alone. `null` means "clear it". The distinction is why the schema makes
    // this nullable-and-optional rather than just optional.
    if (parLevel !== undefined) {
      await upsertProductPar(tx, actor.organizationId, productId, parLevel, reorderPoint);
    }
  });

  const rows = await selectProducts(actor, eq(product.id, productId), 1);
  const updated = rows[0];
  if (!updated) {
    throw new NotFoundError("Product");
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Deactivate — invariant 6: never hard-delete
// ---------------------------------------------------------------------------

export async function deactivateProduct(actor: Actor, productId: number): Promise<void> {
  const result = await db
    .update(product)
    .set({ active: false })
    .where(
      and(eq(product.id, productId), eq(product.organizationId, actor.organizationId)),
    );
  if (result[0].affectedRows === 0) {
    throw new NotFoundError("Product");
  }
}

// ---------------------------------------------------------------------------
// Locations — read-only list (no CRUD surface in the MVP build list; the
// seed already populates them, see db/README.md)
// ---------------------------------------------------------------------------

export interface LocationSummary {
  id: number;
  name: string;
  sortOrder: number;
  /** Which input the counting screen offers here — see `locationCountModeEnum`. */
  countMode: (typeof location.$inferSelect)["countMode"];
  notes: string | null;
}

export async function listLocations(actor: Actor): Promise<LocationSummary[]> {
  return db
    .select({
      id: location.id,
      name: location.name,
      sortOrder: location.sortOrder,
      countMode: location.countMode,
      notes: location.notes,
    })
    .from(location)
    .where(eq(location.organizationId, actor.organizationId))
    .orderBy(location.sortOrder, location.name);
}

// ---------------------------------------------------------------------------
// Vendors — read for owner/manager (reorder-by-vendor grouping, catalog
// forms); write is owner-only (pricing/purchasing is cost-adjacent).
// ---------------------------------------------------------------------------

export interface VendorSummary {
  id: number;
  name: string;
  contact: string | null;
  orderMethod: string | null;
  leadTimeDays: number | null;
}

export async function listVendors(actor: Actor): Promise<VendorSummary[]> {
  return db
    .select({
      id: vendor.id,
      name: vendor.name,
      contact: vendor.contact,
      orderMethod: vendor.orderMethod,
      leadTimeDays: vendor.leadTimeDays,
    })
    .from(vendor)
    .where(eq(vendor.organizationId, actor.organizationId))
    .orderBy(vendor.name);
}
