/**
 * Pure helpers for the product edit form's vendor field (no React, no DB, so
 * they are unit-testable). See docs/plans/vendor-retire/03-program-design.md.
 */
import type { VendorSummary } from "@/lib/domain/catalog";

export interface VendorOption {
  id: number;
  label: string;
}

/**
 * Options for the edit form's vendor select: every active vendor, plus the
 * product's CURRENT vendor if it is retired (labelled "<name> (retired)") so
 * the select can still show what the product is on. Other retired vendors are
 * excluded — a retired vendor can be kept, never newly chosen.
 */
export function vendorOptionsFor(
  vendors: Pick<VendorSummary, "id" | "name" | "active">[],
  currentVendorId: number | null,
): VendorOption[] {
  return vendors
    .filter((v) => v.active || v.id === currentVendorId)
    .map((v) => ({ id: v.id, label: v.active ? v.name : `${v.name} (retired)` }));
}

/**
 * The `vendorId` part of the save payload. Sent ONLY when it changed: the
 * server refuses any write naming a retired vendor, so an untouched retired
 * vendor must not be re-sent on an unrelated save (par, name). `{}` spreads
 * to nothing; `null` clears the vendor.
 */
export function vendorIdPatch(
  currentVendorId: number | null,
  selected: string,
): { vendorId?: number | null } {
  const next = selected === "" ? null : Number(selected);
  return next === currentVendorId ? {} : { vendorId: next };
}
