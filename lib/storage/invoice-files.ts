/**
 * Where invoice bytes live, and the only sanctioned way to turn a stored
 * `invoice.file_path` back into a real filesystem path.
 *
 * ## Why this module exists at all (finding AR-1)
 *
 * The first draft of Phase 2.5 stored invoice originals in `public/invoices/`.
 * Next serves `public/` as static content *ahead of the application*: no
 * `requireSession`, no role check, no organization predicate. Anyone who
 * obtained or guessed a path could retrieve a supplier invoice — negotiated
 * pricing, business volumes, delivery cadence — unauthenticated, from a
 * browser with no account. That is a cross-tenant breach (invariant 9) and a
 * cost-visibility breach (invariant 8) at the same time, and no amount of
 * checking in the route handler would have helped, because the request never
 * reached the route handler.
 *
 * So the rule, which admits no exceptions:
 *
 *   1. Invoice originals, page renders and audit ZIPs live under
 *      `INVOICE_STORAGE_DIR`, **outside the Next.js web root**. Deployment
 *      must not symlink it into `public/`.
 *   2. The only read path is `GET /api/invoices/[id]/file`, which authorises
 *      the caller and then calls `resolveStoredPath()` below.
 *   3. A stored path is never concatenated raw onto the storage root.
 *
 * ## Why the traversal guard is a separate, explicit step
 *
 * `invoice.file_path` is data. It is written by our own upload path today, but
 * it is a database column, and a column is only as trustworthy as every future
 * code path that writes it — plus anything that can edit the row. Treating it
 * as trusted input is the same mistake as trusting a client-supplied
 * `productId` because a foreign key exists: the FK proves the row exists, not
 * whose it is (invariant 9). `path.join(root, "../../etc/passwd")` is a
 * perfectly ordinary path join, and it escapes.
 *
 * `resolveStoredPath` therefore resolves to an absolute path first and then
 * asserts containment on the *resolved* result, which is the only form of the
 * check that survives `..`, symlinks in the stored value, and absolute paths
 * smuggled in as the stored value.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Thrown when a stored path resolves outside `INVOICE_STORAGE_DIR`.
 *
 * Deliberately NOT a `DomainError`: a domain error's message is safe to show a
 * client, and this one must never be. A caller that reaches this has either hit
 * corrupt data or is probing the filesystem, and in both cases the response
 * they get should be the same 404 an unknown id gets — telling them which of
 * the two happened is free reconnaissance. Route handlers catch this and
 * return `NotFoundError`'s shape, never this message.
 */
export class StoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoragePathError";
  }
}

/**
 * The storage root, resolved to an absolute path.
 *
 * Read through a function rather than a module-level const so tests can point
 * `INVOICE_STORAGE_DIR` at a temp directory per-test. A const captured at
 * import time would freeze whatever the first import happened to see, which in
 * a test file means "whatever the previous test set", and the resulting
 * failures look like flakes rather than the ordering bug they are.
 */
export function invoiceStorageRoot(): string {
  const configured = process.env.INVOICE_STORAGE_DIR?.trim();
  const root = path.resolve(configured && configured.length > 0 ? configured : "./var/invoices");

  // A storage root inside `public/` re-creates AR-1 exactly, so refuse it here
  // rather than trusting deployment to get it right. This fires at the first
  // read or write, not at some later audit.
  const publicDir = path.resolve("./public");
  if (root === publicDir || root.startsWith(publicDir + path.sep)) {
    throw new StoragePathError(
      "INVOICE_STORAGE_DIR resolves inside public/, where Next serves files " +
        "statically and unauthenticated. Point it at a sibling of public/, not a child.",
    );
  }
  return root;
}

/**
 * Turns a stored `invoice.file_path` into an absolute path, or refuses.
 *
 * The containment check is on the RESOLVED path, and it compares against
 * `root + sep` rather than `root` alone — otherwise a sibling directory whose
 * name merely starts with the root's name (`/srv/invoices-public`) passes a
 * naive `startsWith(root)` and reads as contained.
 */
export function resolveStoredPath(storedPath: string): string {
  const root = invoiceStorageRoot();
  const resolved = path.resolve(root, storedPath);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new StoragePathError("Stored path resolves outside the invoice storage root.");
  }
  return resolved;
}

/**
 * The storage key for an invoice's original file.
 *
 * Organization-prefixed so that a directory listing is itself tenant-segmented
 * — useful when someone is eyeballing the disk during an incident, and it
 * means a path leaked in a log names an org rather than looking global.
 *
 * The extension is derived from a fixed allowlist rather than from the
 * uploaded filename: a client-supplied extension is client-supplied input, and
 * `invoice.php` or `invoice.html` written into a directory someone later
 * misconfigures as servable is a much worse day than a wrong file extension.
 */
export function invoiceStorageKey(
  organizationId: number,
  invoiceId: number,
  contentType: string,
): string {
  return path.posix.join(
    String(organizationId),
    `${invoiceId}${extensionForContentType(contentType)}`,
  );
}

const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
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

function extensionForContentType(contentType: string): string {
  return CONTENT_TYPE_EXTENSIONS[contentType] ?? ".bin";
}

/**
 * Writes bytes to the storage root, creating the org directory if needed.
 *
 * Returns the SHA-256 and byte length of what was ACTUALLY written, not what
 * the caller claimed. `confirmUpload` compares these against the values
 * declared at upload time, and comparing a declared value against itself would
 * make the whole verification step decorative — which is the failure mode
 * worth guarding, because it would still look like it was working.
 */
export async function writeInvoiceFile(
  storedPath: string,
  bytes: Buffer,
): Promise<{ sha256: string; byteLength: number }> {
  const resolved = resolveStoredPath(storedPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, bytes);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

/** SHA-256 of a buffer, lowercase hex — the form stored in `invoice.file_sha256`. */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
