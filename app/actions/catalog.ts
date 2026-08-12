"use server";

/**
 * Catalog server actions. Every export here checks session + role itself
 * (CLAUDE.md invariant 7 / spec §11) via lib/authz.ts — never trusts that
 * middleware already did it. Business logic lives in lib/domain/catalog.ts;
 * these functions are thin: authorize, validate, call the domain function,
 * shape the result.
 */
import { requireRole } from "@/lib/authz";
import { runAction, type ActionResult } from "@/lib/action-result";
import * as catalog from "@/lib/domain/catalog";
import {
  productCreateSchema,
  productUpdateSchema,
  productDeactivateSchema,
  productSearchSchema,
  resolveBarcodeSchema,
  linkBarcodeSchema,
  vendorCreateSchema,
  vendorUpdateSchema,
  assignVendorToProductsSchema,
  locationCreateSchema,
  locationUpdateSchema,
  locationDeactivateSchema,
} from "@/lib/validation/catalog";

/**
 * Search/list products. All three roles need this (staff resolves products
 * via search when a barcode isn't usable — spec's "always offer a search
 * picker" working agreement), so this only requires a valid session, not a
 * specific role. Cost visibility is still gated inside the domain function
 * by the caller's actual role.
 */
export async function searchProductsAction(
  input: unknown,
): Promise<ActionResult<catalog.ProductSummary[]>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager", "staff");
    const parsed = productSearchSchema.parse(input);
    return catalog.searchProducts(actor, parsed);
  });
}

/**
 * Resolve a scanned barcode to a product. The single most latency-sensitive
 * read in the app (build brief) — one indexed lookup on `product_barcode`,
 * one primary-key lookup on `product` (see lib/domain/catalog.ts). Returns
 * `null` (not an error) for an unknown barcode; the caller routes to
 * scan-to-enroll.
 */
export async function resolveBarcodeAction(
  input: unknown,
): Promise<ActionResult<catalog.BarcodeResolution | null>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager", "staff");
    const parsed = resolveBarcodeSchema.parse(input);
    return catalog.resolveBarcode(actor, parsed.barcode);
  });
}

/**
 * Scan-to-enroll: create a product (and optionally its first barcode) mid-
 * count. All three roles may call this — see the long comment in
 * lib/domain/catalog.ts's createProduct for why (it's the core "unknown
 * barcode -> fast form -> keep counting" loop, spec's highest-risk
 * interaction). Cost is accepted as well-formed input but only ever
 * persisted for an owner caller; that's enforced in the domain layer, not
 * here, so it can't be bypassed by a differently-shaped request.
 */
export async function createProductAction(
  input: unknown,
): Promise<ActionResult<catalog.ProductSummary>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager", "staff");
    const parsed = productCreateSchema.parse(input);
    return catalog.createProduct(actor, parsed);
  });
}

/**
 * Attach a scanned barcode to a product already in the catalog. Same three
 * roles as `createProductAction`, and for the same reason: this is the other
 * half of the unknown-barcode loop, and during the first count it is the
 * common half — whoever is holding the phone must be able to finish it
 * without a role change.
 *
 * Ownership of `productId` is checked in the domain layer (invariant 9 — a
 * foreign key proves the row exists, not whose it is), not here.
 */
export async function linkBarcodeToProductAction(
  input: unknown,
): Promise<ActionResult<catalog.ProductSummary>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager", "staff");
    const parsed = linkBarcodeSchema.parse(input);
    return catalog.linkBarcodeToProduct(actor, parsed);
  });
}

/**
 * Full catalog edit (back office) — owner/manager only. Staff is
 * "count only" (spec §4) and doesn't get catalog-management access beyond
 * scan-to-enroll.
 */
export async function updateProductAction(
  input: unknown,
): Promise<ActionResult<catalog.ProductSummary>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    const parsed = productUpdateSchema.parse(input);
    return catalog.updateProduct(actor, parsed);
  });
}

/** Invariant 6: never hard-delete. Owner/manager only. */
export async function deactivateProductAction(
  input: unknown,
): Promise<ActionResult<{ productId: number }>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    const parsed = productDeactivateSchema.parse(input);
    await catalog.deactivateProduct(actor, parsed.productId);
    return { productId: parsed.productId };
  });
}

/**
 * Dashboard "Catalog health" tile (#14). Owner/manager only, matching the
 * rest of the dashboard's aggregate reads — `catalog.getCatalogHealth`
 * further gates `unpricedCount` to owner only (invariant 8).
 */
export async function catalogHealthAction(): Promise<ActionResult<catalog.CatalogHealth>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    return catalog.getCatalogHealth(actor);
  });
}

/**
 * Needed by every role to pick a location while counting. Active-only,
 * UNCHANGED signature and behavior (Decision 5, 02-architecture.md) — the
 * single highest risk in the locations bundle is a retired location
 * leaking into this picker, where it would keep accepting real scans with
 * zero errors anywhere. `listAllLocationsAction` below is the only caller
 * that ever passes `includeInactive: true`.
 */
export async function listLocationsAction(): Promise<ActionResult<catalog.LocationSummary[]>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager", "staff");
    return catalog.listLocations(actor);
  });
}

/** Owner/manager only — the management screen; includes retired locations. */
export async function listAllLocationsAction(): Promise<ActionResult<catalog.LocationSummary[]>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    return catalog.listLocations(actor, { includeInactive: true });
  });
}

/**
 * Create a location. Owner/manager only. Duplicate `(organization_id,
 * name)` — active or retired — is refused with ConflictError in the domain
 * layer.
 */
export async function createLocationAction(
  input: unknown,
): Promise<ActionResult<catalog.LocationSummary>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    const parsed = locationCreateSchema.parse(input);
    return catalog.createLocation(actor, parsed);
  });
}

/**
 * Rename / re-mode / re-order / re-note a location. Owner/manager only.
 * Ownership of `locationId` and the count-mode-change guard (Gate 2
 * Decision 3) are both checked in the domain layer.
 */
export async function updateLocationAction(
  input: unknown,
): Promise<ActionResult<catalog.LocationSummary>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    const parsed = locationUpdateSchema.parse(input);
    return catalog.updateLocation(actor, parsed);
  });
}

/**
 * Retire a location. Owner/manager only. Invariant 6: never a hard delete —
 * sets `active = false`. Refused with a `DomainError` (surfaced via
 * `result.error.message`) when it is the org's last active location, or
 * when it has count lines on a non-closed count — both checked in the
 * domain layer (Gate 2 Decisions 4 and 6).
 */
export async function deactivateLocationAction(
  input: unknown,
): Promise<ActionResult<{ locationId: number }>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    const parsed = locationDeactivateSchema.parse(input);
    await catalog.deactivateLocation(actor, parsed.locationId);
    return { locationId: parsed.locationId };
  });
}

/** Vendor list — owner/manager (reorder grouping, catalog forms). No cost data. */
export async function listVendorsAction(): Promise<ActionResult<catalog.VendorSummary[]>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    return catalog.listVendors(actor);
  });
}

/**
 * Create a vendor. Owner/manager only — vendors and reordering are a
 * manager's job (spec §4), matching the role gating on `updateProductAction`.
 */
export async function createVendorAction(
  input: unknown,
): Promise<ActionResult<catalog.VendorSummary>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    const parsed = vendorCreateSchema.parse(input);
    return catalog.createVendor(actor, parsed);
  });
}

/**
 * Update a vendor. Owner/manager only. Ownership of `id` is checked in the
 * domain layer (invariant 9), not here.
 */
export async function updateVendorAction(
  input: unknown,
): Promise<ActionResult<catalog.VendorSummary>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    const parsed = vendorUpdateSchema.parse(input);
    return catalog.updateVendor(actor, parsed);
  });
}

/**
 * Assign a vendor to multiple products atomically. Owner/manager only.
 *
 * Every product id is ownership-checked in the domain layer in a single
 * scoped query (not N). The vendor id is also ownership-checked unless null.
 * If any product is not the actor's, the whole call fails as NotFound rather
 * than silently assigning the subset that is — a partial success would probe
 * cross-tenant ids.
 */
export async function assignVendorToProductsAction(
  input: unknown,
): Promise<ActionResult<{ count: number }>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    const parsed = assignVendorToProductsSchema.parse(input);
    await catalog.assignVendorToProducts(actor, parsed);
    return { count: parsed.productIds.length };
  });
}
