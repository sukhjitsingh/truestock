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
import { and, eq, like, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { product, productBarcode, vendor, location } from "@/db/schema";
import type { Role } from "@/lib/authz";
import { canSeeCost, canManageCost } from "@/lib/authz";
import { ConflictError, NotFoundError } from "@/lib/domain/errors";
import { isDuplicateKeyError } from "@/lib/domain/db-errors";
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
    return rows.map((r) => ({ ...r, currentUnitCost: r.currentUnitCost ?? undefined }));
  }
  const rows = await db
    .select(BASE_PRODUCT_COLUMNS)
    .from(product)
    .where(where)
    .orderBy(product.name)
    .limit(limit);
  return rows;
}

// ---------------------------------------------------------------------------
// Search / list
// ---------------------------------------------------------------------------

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
  return selectProducts(role, where, input.limit);
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
}

export async function listLocations(): Promise<LocationSummary[]> {
  return db
    .select({ id: location.id, name: location.name, sortOrder: location.sortOrder })
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
