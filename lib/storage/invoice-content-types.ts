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

/**
 * Content types `CONTENT_TYPE_EXTENSIONS` knows how to name on disk but that
 * new uploads must NOT use. HEIC stays in the extension map so a file already
 * stored as `.heic` still serves back (`app/api/invoices/[id]/file/route.ts`)
 * and `invoiceStorageKey` never falls to `.bin` for it — but the Claude API
 * does not accept HEIC, so an accepted HEIC upload would be stored, queued,
 * and then fail extraction every time. Refusing it at validation tells the
 * user while they are still holding the phone.
 */
const STORED_ONLY_CONTENT_TYPES: ReadonlySet<string> = new Set(["image/heic"]);

/** The upload types this phase accepts. Anything else is refused at validation. */
export const ACCEPTED_INVOICE_CONTENT_TYPES = Object.keys(CONTENT_TYPE_EXTENSIONS).filter(
  (contentType) => !STORED_ONLY_CONTENT_TYPES.has(contentType),
) as readonly string[];

export function extensionForContentType(contentType: string): string {
  return CONTENT_TYPE_EXTENSIONS[contentType] ?? ".bin";
}

/** The photo formats the Claude Vision `image` block accepts, and so the only ones the extraction pipeline can read. */
export const VISION_IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type VisionImageContentType = (typeof VISION_IMAGE_CONTENT_TYPES)[number];

export function isVisionImageContentType(contentType: string): contentType is VisionImageContentType {
  return (VISION_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType);
}

/**
 * Largest photo the extraction pipeline will send to Claude Vision, in bytes.
 *
 * The API caps one image at 10 MB of BASE64 — 7.5 MB of file once the 4/3
 * encoding overhead is counted — and some hosts of the same API (Bedrock) cap
 * it at 5 MB base64. 7.5 MB is the first-party figure, in decimal megabytes so
 * it stays under the limit whichever megabyte the API means. The general 25 MB
 * upload ceiling is far above it, so without this a 12 MB phone photo uploads
 * fine, queues, and then fails extraction with an API error that names neither
 * the photo nor the limit. There is no downscaling step; a counter whose phone
 * writes larger files has to retake the photo at a lower resolution or upload
 * a PDF. (Pixel dimensions — 8000 x 8000 at most — are not checked here.)
 */
export const MAX_VISION_IMAGE_BYTES = 7_500_000;

/**
 * Why `bytes` of `contentType` can't be read by Claude Vision, or `null` if it
 * can. Only photos are bounded — a PDF reaches Vision as a `document` block,
 * which has its own, larger limits. Shared by upload validation (so the
 * counter hears it while still holding the phone) and the pipeline (which sees
 * the real bytes, not the declared size).
 */
export function visionImageSizeProblem(contentType: string, bytes: number): string | null {
  if (!isVisionImageContentType(contentType) || bytes <= MAX_VISION_IMAGE_BYTES) return null;
  // The photo's size rounds UP to a tenth so it always reads larger than the
  // cap beside it: 7,500,001 bytes is "7.6 MB" here, not the self-contradicting
  // "7.5 MB, and photos over 7.5 MB can't be read".
  const mbUp = (n: number) => (Math.ceil(n / 100_000) / 10).toFixed(1);
  const mb = (n: number) => (n / 1_000_000).toFixed(1);
  return (
    `This photo is ${mbUp(bytes)} MB, and photos over ${mb(MAX_VISION_IMAGE_BYTES)} MB can't be read. ` +
    "Retake it at a lower resolution, or upload a PDF."
  );
}

const EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(CONTENT_TYPE_EXTENSIONS).map(([type, ext]) => [ext, type])),
  // Stored keys are always `.jpg` (`invoiceStorageKey`), but `.jpeg` is the
  // same format and costs nothing to recognise.
  ".jpeg": "image/jpeg",
};

/**
 * The inverse of `extensionForContentType`, for a STORED path: the extension
 * is the only record of what an invoice file is (the `invoice` row keeps
 * `file_path`, not the declared content type). Returns `null` for anything
 * not in the map — `.bin`, no extension, a bare dotfile — so the caller must
 * decide what an unknown type means rather than inherit a guess from here.
 */
export function contentTypeForPath(storedPath: string): string | null {
  const dot = storedPath.lastIndexOf(".");
  const lastSeparator = Math.max(storedPath.lastIndexOf("/"), storedPath.lastIndexOf("\\"));
  if (dot <= lastSeparator + 1) {
    return null;
  }
  return EXTENSION_CONTENT_TYPES[storedPath.slice(dot).toLowerCase()] ?? null;
}
