/**
 * The upload content-types this phase accepts, split out of
 * `lib/storage/invoice-files.ts` for exactly the reason `db/enums.ts`'s
 * header documents: `lib/validation/invoices.ts` is shared with client
 * components and needs `ACCEPTED_INVOICE_CONTENT_TYPES` as a value to build
 * a Zod enum. `invoice-files.ts` imports `node:fs/promises` and
 * `node:crypto` — pulling anything from that module into a client bundle
 * ships Node built-ins to the browser, the same failure mode that shipped
 * Drizzle to the catalog page before the enum split. This file has zero
 * imports so nothing reaching it can drag anything else along.
 *
 * `invoice-files.ts` re-exports these under its existing names so its own
 * public API (and `tests/invoice-storage.test.ts`, which imports from there)
 * is unchanged.
 */
export const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/heic": ".heic",
  "image/webp": ".webp",
};

/** The upload types this phase accepts. Anything else is refused at validation. */
export const ACCEPTED_INVOICE_CONTENT_TYPES = Object.keys(
  CONTENT_TYPE_EXTENSIONS,
) as readonly string[];

export function extensionForContentType(contentType: string): string {
  return CONTENT_TYPE_EXTENSIONS[contentType] ?? ".bin";
}
