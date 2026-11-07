import { requireRole } from "@/lib/authz";
import { PageHeader } from "@/components/office/page-header";
import { AuditPacket } from "@/components/office/audit-packet";

export const metadata = { title: "Audit packet · Truestock" };

/**
 * The audit-packet export screen — Phase 2.5, Slice 5
 * (docs/plans/phase-2.5-invoice-automation/04-slices.md, "Slice 5 — Audit
 * Packet"). Owner-only: `requireRole("owner")` gates the page itself, the
 * same shape `app/(office)/office/users/page.tsx` uses for a screen with no
 * per-record id to 404 against — there is nothing here to ownership-check
 * until a packet exists, so there's no `notFound()`-on-cross-tenant-id
 * pattern to mirror the way `invoices/[invoiceId]/page.tsx` does. Both
 * server actions this page's client component calls
 * (`createAuditPacketAction`, `getAuditPacketAction`) re-check
 * `requireRole("owner")` themselves (invariant 7) — this is the outer layer,
 * not the only one.
 *
 * A manager reaching this URL directly never sees it in the rail (owner-only
 * items are built per role, never rendered-then-hidden — `office-rail.tsx`),
 * and `requireRole` throwing here is the same outcome `UsersPage` already
 * accepts for the same shape of screen.
 */
export default async function AuditPacketPage() {
  await requireRole("owner");

  return (
    <div>
      <PageHeader
        title="Audit Packet"
        breadcrumb={{ label: "← All invoices", href: "/office/invoices" }}
        subtitle={
          <p className="text-row-subtitle text-muted-foreground">
            A dated export of invoices and counts, with a SHA-256 manifest, for the two-year
            retention and state-audit obligation. Requesting one starts a background job — this
            page tracks it until the download is ready.
          </p>
        }
      />

      <div className="mt-6">
        <AuditPacket />
      </div>
    </div>
  );
}
