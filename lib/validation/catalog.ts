/**
 * Zod schemas for the catalog boundary (products, barcodes, vendors,
 * locations). Shared with the frontend — nothing here is server-only, so
 * these can be imported from client components/forms too.
 *
 * These validate what the database does not (db/schema.ts's own comments
 * call this out): non-negative quantities, enum membership, string lengths.
 * They do NOT decide who is allowed to submit a given field with a given
 * role — that's lib/authz.ts + the domain layer's job (e.g. cost fields are
 * accepted here as well-formed input, then silently dropped for non-owner
 * callers in lib/domain/catalog.ts — see the comment there for why "accept
 * then strip" beats "reject the whole request").
 */
import { z } from "zod";
import {
  productUnitTypeEnum,
  barcodePackLevelEnum,
} from "@/db/schema";

export const barcodeStringSchema = z
  .string()
  .trim()
  .min(4, "Barcode is too short.")
  .max(64, "Barcode is too long.");

export const productUnitTypeSchema = z.enum(productUnitTypeEnum);
export const barcodePackLevelSchema = z.enum(barcodePackLevelEnum);

/**
 * `product.current_unit_cost` is DECIMAL(10,4) — 10 total digits, 4 after
 * the point, so at most 6 integer digits (max value 999999.9999). The
 * regex bounds both halves, not just the decimal shape: an unbounded
 * integer part (the previous `\d+`) let a value like "12345678" reach the
 * database and fail there with MySQL's generic out-of-range error instead
 * of a field-level Zod message here. Non-negative — a negative cost is
 * never valid.
 */
export const unitCostSchema = z
  .string()
  .regex(
    /^\d{1,6}(\.\d{1,4})?$/,
    "Cost must be a non-negative number with up to 6 digits before the decimal and 4 after.",
  );

/** A barcode captured alongside a new/updated product. */
export const productBarcodeInputSchema = z.object({
  barcode: barcodeStringSchema,
  format: z.string().trim().max(20).optional(),
  packLevel: barcodePackLevelSchema,
  isPrimary: z.boolean().optional(),
});

/**
 * Scan-to-enroll / catalog create. `currentUnitCost` is accepted here as
 * well-formed input (a non-negative decimal string) but is only ever
 * persisted for an `owner` caller — see lib/domain/catalog.ts.
 */
export const productCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(255),
  brand: z.string().trim().max(255).optional(),
  category: z.string().trim().min(1, "Category is required.").max(100),
  subcategory: z.string().trim().max(100).optional(),
  unitType: productUnitTypeSchema,
  sizeMl: z.number().int().positive("Size must be a positive number of ml."),
  caseSize: z.number().int().positive().optional(),
  vendorId: z.number().int().positive().optional(),
  // Decimal as a string to avoid float round-tripping through JSON — see
  // `unitCostSchema` above for the DECIMAL(10,4) magnitude bound.
  currentUnitCost: unitCostSchema.optional(),
  // The barcode that triggered enrollment (scan-to-enroll). Optional because
  // the "no usable barcode" path (damaged label, house infusion) still needs
  // to create a product via the search picker.
  barcode: productBarcodeInputSchema.optional(),
});
export type ProductCreateInput = z.infer<typeof productCreateSchema>;

export const productUpdateSchema = z.object({
  productId: z.number().int().positive(),
  name: z.string().trim().min(1).max(255).optional(),
  brand: z.string().trim().max(255).nullable().optional(),
  category: z.string().trim().min(1).max(100).optional(),
  subcategory: z.string().trim().max(100).nullable().optional(),
  unitType: productUnitTypeSchema.optional(),
  sizeMl: z.number().int().positive().optional(),
  caseSize: z.number().int().positive().nullable().optional(),
  vendorId: z.number().int().positive().nullable().optional(),
  currentUnitCost: unitCostSchema.nullable().optional(),
  // DECIMAL(4,3) — 4 total digits, 3 after the point, so at most 1 integer
  // digit (max value 9.999). `.max(9.999)` already bounds this correctly
  // (checked while fixing the currentUnitCost gap above); noted here so a
  // future edit doesn't widen it without re-checking the column.
  wasteFactor: z.number().min(0).max(9.999).optional(),
  shelfLifeDays: z.number().int().positive().nullable().optional(),
});
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;

export const productDeactivateSchema = z.object({
  productId: z.number().int().positive(),
});

export const productSearchSchema = z.object({
  query: z.string().trim().max(255).optional(),
  category: z.string().trim().max(100).optional(),
  activeOnly: z.boolean().optional().default(true),
  limit: z.number().int().positive().max(100).optional().default(25),
});
export type ProductSearchInput = z.infer<typeof productSearchSchema>;

export const resolveBarcodeSchema = z.object({
  barcode: barcodeStringSchema,
});
