/**
 * The ONLY way an audit packet's ZIP bytes ever leave the server — Phase
 * 2.5, Slice 5's mirror of `app/api/invoices/[id]/file/route.ts` [AR-1],
 * same reasoning: audit-packet ZIPs live under `INVOICE_STORAGE_DIR` (a
 * sibling of `public/`, never inside it — `lib/storage/invoice-files.ts`'s
 * header), specifically so reaching them requires passing through this
 * handler — session, role, ownership, expiry, and the path-traversal guard —
 * rather than Next's static file server, which has none of those.
 *
 * Owner-only [AR-7], matching `lib/authz.ts:canSeeCost` and
 * `getAuditPacketAction`'s own gate.
 *
 * ## Why this independently re-checks status + expiry
 *
 * `getAuditPacketAction` already gates the same thing when the office UI
 * asks "is this ready?" and hands back a `downloadUrl`. But a client can
 * bookmark or re-request that URL directly, later, after the 10-minute TTL
 * has lapsed — the action's answer is a snapshot from whenever it was last
 * called, not a guarantee about this request. This route therefore calls
 * `loadFreshAuditPacket` itself (the SAME function `getAuditPacketStatus`
 * calls), which re-reads the row and lazily flips a lapsed `ready` packet to
 * `expired` right here, at request time — matching the discipline AGENTS.md
 * documents for the `active` flag on products/locations/users: the check
 * belongs on the read/write path itself, not only upstream of it.
 *
 * Every failure mode that touches WHICH packet or WHERE it lives — unknown
 * id, cross-tenant id, not yet built, expired, a stored path that fails the
 * containment check, a row that says a file exists but the disk disagrees —
 * resolves to the SAME 404 shape. Expired-vs-missing must be
 * indistinguishable to the caller (04-slices.md), and telling an attacker
 * which of "wrong id" / "not ready yet" / "link expired" applies is free
 * reconnaissance about a row that isn't theirs.
 */
import { readFile } from "node:fs/promises";
import { AuthzError, requireRole } from "@/lib/authz";
import { loadFreshAuditPacket } from "@/lib/domain/audit-packets";
import { DomainError } from "@/lib/domain/errors";
import { resolveStoredPath, StoragePathError } from "@/lib/storage/invoice-files";

function unavailable(): Response {
  return Response.json({ error: "Audit packet not found or not available." }, { status: 404 });
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const actor = await requireRole("owner");
    const id = parseId((await params).id);
    if (id === null) {
      return unavailable();
    }

    // Ownership-checked (throws NotFoundError on a cross-tenant/unknown id —
    // caught below and turned into the same 404 shape) AND lazily expires a
    // lapsed `ready` row right here — see the module header.
    const packet = await loadFreshAuditPacket(actor, id);

    // Independently re-verified even though `loadFreshAuditPacket` already
    // encodes this — status !== "ready" after that call means either it
    // never reached ready (`building`/`failed`) or it just got lazily
    // expired above; either way there is nothing to stream.
    if (packet.status !== "ready" || !packet.filePath) {
      return unavailable();
    }
    if (!packet.expiresAt || packet.expiresAt.getTime() <= Date.now()) {
      return unavailable();
    }

    let resolvedPath: string;
    try {
      resolvedPath = resolveStoredPath(packet.filePath);
    } catch (err) {
      if (err instanceof StoragePathError) {
        return unavailable();
      }
      throw err;
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(resolvedPath);
    } catch {
      // The row says the ZIP exists but the disk disagrees (corrupt state,
      // not caller error) — same 404 shape as everything else here, never a
      // 500 that hints at server internals.
      return unavailable();
    }

    const filename = `truestock-audit-${packet.dateFrom.replace(/-/g, "")}-${packet.dateTo.replace(/-/g, "")}.zip`;

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
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
    // NotFoundError (cross-tenant/unknown packetId) reads as the same
    // "unavailable" shape as every other "no" this route can produce
    // (invariant 9) — never a distinct message that would confirm the id is
    // real but belongs to someone else.
    return unavailable();
  }
  console.error("[api/audit-packets/[id]] unhandled error", err);
  return Response.json({ error: "Something went wrong." }, { status: 500 });
}
