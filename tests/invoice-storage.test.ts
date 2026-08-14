/**
 * The AR-1 storage guards.
 *
 * Pure path arithmetic, no database — but this is the file standing between a
 * supplier invoice and an unauthenticated GET. The finding these close is that
 * invoice originals were to be stored in `public/`, which Next serves
 * statically ahead of the application: no session, no role, no organization
 * predicate. Nothing in a route handler can defend against that, because the
 * request never reaches one.
 *
 * Every test here is written to fail against the uncorrected behaviour:
 *   - drop the containment check in `resolveStoredPath` and the traversal
 *     cases return a path instead of throwing;
 *   - drop the `public/` refusal in `invoiceStorageRoot` and the web-root case
 *     returns a root instead of throwing.
 * None of them may be weakened to go green.
 */
import { describe, test, expect, afterEach } from "bun:test";
import path from "node:path";
import {
  invoiceStorageRoot,
  resolveStoredPath,
  invoiceStorageKey,
  sha256Hex,
  StoragePathError,
  ACCEPTED_INVOICE_CONTENT_TYPES,
} from "@/lib/storage/invoice-files";

const ORIGINAL = process.env.INVOICE_STORAGE_DIR;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.INVOICE_STORAGE_DIR;
  else process.env.INVOICE_STORAGE_DIR = ORIGINAL;
});

// ---------------------------------------------------------------------------
// The root itself
// ---------------------------------------------------------------------------

describe("invoiceStorageRoot", () => {
  test("defaults to ./var/invoices — a SIBLING of public/, never a child", () => {
    delete process.env.INVOICE_STORAGE_DIR;
    const root = invoiceStorageRoot();
    expect(root).toBe(path.resolve("./var/invoices"));

    // The whole point of the default. Asserted as a relationship rather than a
    // string so that changing the default directory cannot quietly move it
    // inside the web root.
    const publicDir = path.resolve("./public");
    expect(root.startsWith(publicDir + path.sep)).toBe(false);
    expect(root).not.toBe(publicDir);
  });

  test("refuses a root inside public/ — this IS finding AR-1", () => {
    process.env.INVOICE_STORAGE_DIR = "./public/invoices";
    expect(() => invoiceStorageRoot()).toThrow(StoragePathError);
  });

  test("refuses public/ itself", () => {
    process.env.INVOICE_STORAGE_DIR = "./public";
    expect(() => invoiceStorageRoot()).toThrow(StoragePathError);
  });

  test("is re-read per call, so a test can point it at a temp directory", () => {
    process.env.INVOICE_STORAGE_DIR = "/tmp/truestock-invoices-a";
    expect(invoiceStorageRoot()).toBe("/tmp/truestock-invoices-a");
    process.env.INVOICE_STORAGE_DIR = "/tmp/truestock-invoices-b";
    expect(invoiceStorageRoot()).toBe("/tmp/truestock-invoices-b");
  });
});

// ---------------------------------------------------------------------------
// invoice_file_rejects_path_traversal  [AR-1]
// ---------------------------------------------------------------------------

describe("resolveStoredPath", () => {
  test("resolves an ordinary stored key inside the root", () => {
    process.env.INVOICE_STORAGE_DIR = "/tmp/truestock-invoices";
    expect(resolveStoredPath("7/42.pdf")).toBe("/tmp/truestock-invoices/7/42.pdf");
  });

  test("refuses a `..` traversal", () => {
    process.env.INVOICE_STORAGE_DIR = "/tmp/truestock-invoices";
    expect(() => resolveStoredPath("../../etc/passwd")).toThrow(StoragePathError);
  });

  test("refuses a traversal buried mid-path, not just a leading one", () => {
    process.env.INVOICE_STORAGE_DIR = "/tmp/truestock-invoices";
    expect(() => resolveStoredPath("7/../../../etc/passwd")).toThrow(StoragePathError);
  });

  test("refuses an absolute path smuggled in as the stored value", () => {
    // path.resolve(root, "/etc/passwd") === "/etc/passwd" — the root is
    // discarded entirely. A `startsWith("..")` check on the *stored* string
    // would pass this happily; only checking the RESOLVED path catches it.
    process.env.INVOICE_STORAGE_DIR = "/tmp/truestock-invoices";
    expect(() => resolveStoredPath("/etc/passwd")).toThrow(StoragePathError);
  });

  test("refuses a sibling directory that merely shares the root's prefix", () => {
    // `/tmp/truestock-invoices-public/x.pdf`.startsWith(`/tmp/truestock-invoices`)
    // is true. Containment must be tested against root + separator.
    process.env.INVOICE_STORAGE_DIR = "/tmp/truestock-invoices";
    expect(() => resolveStoredPath("../truestock-invoices-public/x.pdf")).toThrow(
      StoragePathError,
    );
  });
});

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

describe("invoiceStorageKey", () => {
  test("is organization-prefixed, so the directory tree is tenant-segmented", () => {
    expect(invoiceStorageKey(7, 42, "application/pdf")).toBe("7/42.pdf");
    expect(invoiceStorageKey(9, 42, "application/pdf")).toBe("9/42.pdf");
  });

  test("derives the extension from the content type, never from a filename", () => {
    expect(invoiceStorageKey(1, 1, "image/jpeg")).toBe("1/1.jpg");
    expect(invoiceStorageKey(1, 1, "image/png")).toBe("1/1.png");
  });

  test("an unrecognized content type gets .bin, never a caller-chosen extension", () => {
    // A client-supplied extension is client-supplied input. `invoice.php`
    // written into a directory someone later misconfigures as servable is a
    // considerably worse day than a wrong extension.
    expect(invoiceStorageKey(1, 1, "text/html")).toBe("1/1.bin");
  });

  test("every accepted content type maps to a real extension", () => {
    for (const type of ACCEPTED_INVOICE_CONTENT_TYPES) {
      expect(invoiceStorageKey(1, 1, type).endsWith(".bin")).toBe(false);
    }
  });

  test("a generated key always resolves back inside the root", () => {
    process.env.INVOICE_STORAGE_DIR = "/tmp/truestock-invoices";
    const key = invoiceStorageKey(7, 42, "application/pdf");
    expect(resolveStoredPath(key)).toBe("/tmp/truestock-invoices/7/42.pdf");
  });
});

// ---------------------------------------------------------------------------
// Hashing — the upload verification depends on this being the real digest
// ---------------------------------------------------------------------------

describe("sha256Hex", () => {
  test("matches the known digest of the empty input", () => {
    expect(sha256Hex(Buffer.from(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("is lowercase hex of the expected length", () => {
    const digest = sha256Hex(Buffer.from("truestock"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
