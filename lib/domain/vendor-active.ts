/**
 * The retired-vendor write guard (invariant 6: refuse inactive rows on the
 * WRITE path). Lives in its own module so `invoices.ts` need not import the
 * large `catalog.ts`.
 *
 * `SELECT ... FOR UPDATE` on purpose: a plain snapshot read would let a retire
 * that commits mid-transaction slip past, and the write would then attach a
 * retired vendor. With the lock, a concurrent retire waits for the writer (and
 * the writer's later retire is seen by the next write), so nothing gains a
 * vendor after it is retired.
 *
 * Callers invoke this as the FIRST statement of their transaction, above any
 * existing-row lookup, and only when a non-null vendor id is being set.
 *
 * Invariant 9: a cross-tenant or nonexistent id is NotFound("Vendor"), never
 * "retired" — the answer must not confirm another tenant's row exists.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { vendor } from "@/db/schema";
import { NotFoundError, VendorRetiredError } from "@/lib/domain/errors";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function assertVendorActive(
  tx: Tx,
  organizationId: number,
  vendorId: number,
): Promise<{ id: number; name: string }> {
  const [row] = await tx
    .select({ id: vendor.id, name: vendor.name, active: vendor.active })
    .from(vendor)
    .where(and(eq(vendor.id, vendorId), eq(vendor.organizationId, organizationId)))
    .limit(1)
    .for("update");
  if (!row) {
    throw new NotFoundError("Vendor");
  }
  if (!row.active) {
    throw new VendorRetiredError(row.name);
  }
  return { id: row.id, name: row.name };
}
