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
import type { Role } from "@/lib/authz";
import { canSeeCost, canManageCost } from "@/lib/authz";
import { ConflictError, NotFoundError } from "@/lib/domain/errors";
import { isDuplicateKeyError } from "@/lib/domain/db-errors";
import { getOnHandSnapshot } from "@/lib/domain/on-hand";
import type {
  ProductCreateInput,
  ProductUpdateInput,
  ProductSearchInput,
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
 */
export type ProductIncompleteReason = "needs_producer" | "needs_cost" | "needs_case_size";

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
  // it is the only thing a missing case size is a gap for. `unit_type` is
  // what separates bottled/canned beer from draft here — a keg is one unit
  // measured in tenths and never has a case size.
  if (category === "beer" && row.unitType !== "keg" && row.caseSize == null) {
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
  role: Role,
  where: SQL | undefined,
  limit: number,
): Promise<ProductSummary[]> {
  if (canSeeCost(role)) {
    const rows = await db
      .select({ ...BASE_PRODUCT_COLUMNS, currentUnitCost: product.currentUnitCost })
      .from(product)
      .where(where)
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
    .where(where)
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
  role: Role,
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
  const rows = await selectProducts(role, where, input.limit);

  if (!input.includeOnHand || rows.length === 0) {
    return rows;
  }
  return attachStock(rows);
}

/**
 * Attaches on-hand and par to an already-selected page of products. Two
 * queries total regardless of page size — the shared on-hand snapshot, and
 * one `IN (...)` over `product_par` for just the ids on this page.
 */
async function attachStock(rows: ProductSummary[]): Promise<ProductSummary[]> {
  const ids = rows.map((r) => r.id);
  const [snapshot, parRows] = await Promise.all([
    getOnHandSnapshot(),
    db
      .select({
        productId: productPar.productId,
        parLevel: productPar.parLevel,
        reorderPoint: productPar.reorderPoint,
      })
      .from(productPar)
      .where(and(inArray(productPar.productId, ids), isNull(productPar.locationId))),
  ]);

  const parByProduct = new Map(parRows.map((p) => [p.productId, p]));

  return rows.map((row) => {
    const par = parByProduct.get(row.id);
    return {
      ...row,
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
  role: Role,
  barcode: string,
): Promise<BarcodeResolution | null> {
  const [hit] = await db
    .select({ productId: productBarcode.productId, packLevel: productBarcode.packLevel })
    .from(productBarcode)
    .where(eq(productBarcode.barcode, barcode))
    .limit(1);
  if (!hit) {
    return null;
  }
  const rows = await selectProducts(role, eq(product.id, hit.productId), 1);
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
  barcode: string,
): Promise<{ productId: number; packLevel: (typeof productBarcode.$inferSelect)["packLevel"] } | null> {
  const [hit] = await db
    .select({ productId: productBarcode.productId, packLevel: productBarcode.packLevel })
    .from(productBarcode)
    .where(eq(productBarcode.barcode, barcode))
    .limit(1);
  return hit ?? null;
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
  role: Role,
  input: ProductCreateInput,
): Promise<ProductSummary> {
  const allowCost = canManageCost(role);

  // Scan-to-enroll has a 20-second budget and is the app's highest-risk
  // interaction (CLAUDE.md) — a generic "Something went wrong" on the two
  // ways this can collide (same name+size already cataloged, or this exact
  // barcode already belongs to another product) is exactly the kind of dead
  // end that makes someone give up and walk away from the count. Both
  // collisions are caught here and turned into a `ConflictError` naming
  // what collided, not left to fall through to the generic error handler in
  // lib/action-result.ts.
  const created = await db.transaction(async (tx) => {
    let inserted: { id: number };
    try {
      [inserted] = await tx
        .insert(product)
        .values({
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
            .where(eq(productBarcode.barcode, input.barcode.barcode))
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

  const rows = await selectProducts(role, eq(product.id, created), 1);
  const result = rows[0];
  if (!result) {
    throw new NotFoundError("Product");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateProduct(
  role: Role,
  input: ProductUpdateInput,
): Promise<ProductSummary> {
  const allowCost = canManageCost(role);
  const { productId, currentUnitCost, wasteFactor, ...rest } = input;

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

  if (Object.keys(patch).length === 0) {
    const rows = await selectProducts(role, eq(product.id, productId), 1);
    const existing = rows[0];
    if (!existing) throw new NotFoundError("Product");
    return existing;
  }

  let result;
  try {
    result = await db.update(product).set(patch).where(eq(product.id, productId));
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      // product_name_size_ml_unique — only reachable if this update changes
      // name and/or size_ml to a combination another product already has.
      throw new ConflictError(
        "Another product already has this name and size. Choose a different name or size.",
      );
    }
    throw err;
  }
  if (result[0].affectedRows === 0) {
    throw new NotFoundError("Product");
  }

  const rows = await selectProducts(role, eq(product.id, productId), 1);
  const updated = rows[0];
  if (!updated) {
    throw new NotFoundError("Product");
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Deactivate — invariant 6: never hard-delete
// ---------------------------------------------------------------------------

export async function deactivateProduct(productId: number): Promise<void> {
  const result = await db
    .update(product)
    .set({ active: false })
    .where(eq(product.id, productId));
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

export async function listLocations(): Promise<LocationSummary[]> {
  return db
    .select({
      id: location.id,
      name: location.name,
      sortOrder: location.sortOrder,
      countMode: location.countMode,
      notes: location.notes,
    })
    .from(location)
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

export async function listVendors(): Promise<VendorSummary[]> {
  return db
    .select({
      id: vendor.id,
      name: vendor.name,
      contact: vendor.contact,
      orderMethod: vendor.orderMethod,
      leadTimeDays: vendor.leadTimeDays,
    })
    .from(vendor)
    .orderBy(vendor.name);
}
