/**
 * The ONLY way an invoice's original bytes ever leave the server [AR-1].
 *
 * `lib/storage/invoice-files.ts`'s header explains why this route exists at
 * all: invoice originals live under `INVOICE_STORAGE_DIR`, a sibling of
 * `public/`, specifically so that reaching them requires passing through
 * this handler — session, role, ownership, and the path-traversal guard —
 * rather than Next's static file server, which has none of those.
 *
 * `PUT` — the second half of the upload handshake started by
 * `uploadInvoiceAction` (`app/actions/invoices.ts`): receives the declared
 * file's bytes and writes them to the path `createInvoiceForUpload` already
 * computed. Owner + manager, matching the upload action's own role gate.
 *
 * `GET` — owner-only [AR-7], matching `lib/authz.ts:canSeeCost`. Every
 * failure mode that touches WHICH invoice or WHERE it lives — unknown id,
 * cross-tenant id, a `file_path` that hasn't been set yet, a stored path
 * that fails the containment check — resolves to the SAME 404 shape. A
 * `StoragePathError` in particular must never surface its own message:
 * reaching one means either corrupt data or someone probing the filesystem,
 * and telling them which is free reconnaissance (see that error class's doc
 * comment).
 *
 * Wrong role or no session is a DIFFERENT axis and is deliberately NOT
 * folded into that 404: `requireRole("owner")` throws `AuthzError` (401 with
 * no session, 403 for a signed-in manager/staff), which `errorResponse`
 * below returns as-is. That is an ordinary auth-boundary response, not a
 * cross-tenant existence leak — it says nothing about whether `id` names a
 * real invoice, only that this caller isn't allowed to read invoice files at
 * all, which the client already knows from its own role.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { AuthzError, requireRole } from "@/lib/authz";
import { getInvoice } from "@/lib/domain/invoices";
import { getJobForInvoice, withUploadSlot } from "@/lib/domain/extraction";
import { DomainError, InvoiceNotWritableError } from "@/lib/domain/errors";
import { resolveStoredPath, writeInvoiceFile, StoragePathError } from "@/lib/storage/invoice-files";
import { CONTENT_TYPE_EXTENSIONS } from "@/lib/storage/invoice-content-types";

/** Enforced on the REAL request body as it streams in, not on any declared
 * Content-Length header — a header is client-supplied input, same reasoning
 * as `lib/validation/invoices.ts`'s `MAX_INVOICE_BYTES` being re-checked
 * here rather than trusted from the upload-request step. */
const MAX_INVOICE_BYTES = 25 * 1024 * 1024;

const EXTENSION_TO_CONTENT_TYPE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CONTENT_TYPE_EXTENSIONS).map(([type, ext]) => [ext, type]),
);

function contentTypeForStoredPath(storedPath: string): string {
  return EXTENSION_TO_CONTENT_TYPE[path.extname(storedPath)] ?? "application/octet-stream";
}

function notFound(): Response {
  return Response.json({ error: "Invoice not found." }, { status: 404 });
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

class PayloadTooLargeError extends Error {}

/** Reads the request body up to `limit` bytes, aborting the stream past it
 * rather than buffering an unbounded upload into memory first and checking
 * afterward. */
async function readBodyWithLimit(request: Request, limit: number): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) {
    return Buffer.alloc(0);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const actor = await requireRole("owner", "manager");
    const id = parseId((await params).id);
    if (id === null) {
      return notFound();
    }

    const invoice = await getInvoice(actor, id);
    if (!invoice.filePath) {
      return notFound();
    }

    // Write-once. Role, ownership and the traversal guard all say yes to a
    // second PUT — right owner, own invoice, contained path — and none of
    // them is about WHEN. Without this, re-PUTting a confirmed invoice
    // replaces the archived bytes while `file_sha256` goes on describing the
    // bytes that used to be there: the row still reads verified, the archive
    // list is unchanged, and only the file itself disagrees. On documents
    // carrying a 3-year statutory retention that surfaces in an audit packet
    // (Slice 5), long after the original is unrecoverable.
    //
    // `awaiting_upload` is precisely the window where an upload is
    // legitimate, so the same state machine that keeps the extraction worker
    // off an unwritten file (AR-6) keeps a writer off a confirmed one.
    // Checked BEFORE the body is read, so a refused write never reaches the
    // filesystem — a 409 returned after the overwrite would be worse than no
    // guard at all, because it would read as a refusal.
    //
    // This check is a FAST PATH, not the guarantee. It is unlocked, so it can
    // go stale between here and the write below; what actually holds the line
    // is `withUploadSlot`, which re-asserts the same condition under the
    // extraction_job row lock. Keeping this one as well means the common
    // rejection — an already-confirmed invoice — costs nothing and never
    // reads 25 MB off the wire to then discard it.
    const job = await getJobForInvoice(actor.organizationId, id);
    if (job.status !== "awaiting_upload") {
      return Response.json(
        { error: "This invoice's file has already been uploaded and verified." },
        { status: 409 },
      );
    }

    let bytes: Buffer;
    try {
      bytes = await readBodyWithLimit(request, MAX_INVOICE_BYTES);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return Response.json({ error: "File is too large." }, { status: 413 });
      }
      throw err;
    }

    try {
      resolveStoredPath(invoice.filePath);
    } catch (err) {
      if (err instanceof StoragePathError) {
        return notFound();
      }
      throw err;
    }

    // The write itself runs under the extraction_job row lock, re-asserting
    // `awaiting_upload` after the body has been read. The body is read first
    // deliberately: the lock is also taken by `markUploadConfirmed`, and
    // holding it across a client's upload stream would let a slow connection
    // block every confirm for that invoice.
    const storedPath = invoice.filePath;
    try {
      await withUploadSlot(actor.organizationId, id, () => writeInvoiceFile(storedPath, bytes));
    } catch (err) {
      if (err instanceof InvoiceNotWritableError) {
        // Lost the race to a confirm that landed while this body was being
        // read. Same 409 and the same remedy as the fast path above, and no
        // byte was written either way — but a DIFFERENT message, deliberately.
        //
        // The two are indistinguishable to a client and must stay that way in
        // behaviour, yet a test cannot otherwise tell which guard fired. That
        // matters here more than usual: a test for this race that is actually
        // being satisfied by the fast path passes, proves nothing, and reads
        // as evidence — which is precisely what happened on the first attempt
        // at `invoice_file_write_once_survives_a_concurrent_put`. Distinct
        // wording is what lets that test assert it reached the window it
        // claims to be testing.
        return Response.json(
          { error: "This invoice's upload was confirmed while these bytes were still arriving." },
          { status: 409 },
        );
      }
      throw err;
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const actor = await requireRole("owner");
    const id = parseId((await params).id);
    if (id === null) {
      return notFound();
    }

    const invoice = await getInvoice(actor, id);
    if (!invoice.filePath) {
      return notFound();
    }

    let resolvedPath: string;
    try {
      resolvedPath = resolveStoredPath(invoice.filePath);
    } catch (err) {
      if (err instanceof StoragePathError) {
        return notFound();
      }
      throw err;
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(resolvedPath);
    } catch {
      // The row says a file exists but the disk disagrees (corrupt state,
      // not caller error) — same 404 shape as everything else here, never a
      // 500 that hints at server internals.
      return notFound();
    }

    const contentType = contentTypeForStoredPath(invoice.filePath);
    const filename = `invoice-${invoice.id}${path.extname(invoice.filePath)}`;

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(bytes.byteLength),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof AuthzError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof DomainError) {
    // NotFoundError and friends carry a client-safe message, but a cross-
    // tenant/unknown invoice id must still read as the same 404 shape as
    // every other "no" this route can produce (invariant 9).
    return notFound();
  }
  console.error("[api/invoices/[id]/file] unhandled error", err);
  return Response.json({ error: "Something went wrong." }, { status: 500 });
}
