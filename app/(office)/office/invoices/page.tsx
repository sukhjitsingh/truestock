import Link from "next/link";
import { requireOfficeUser } from "@/lib/current-user";
import { listInvoicesForOwnerAction, listInvoicesRedactedAction } from "@/app/actions/invoices";
import { listVendorsAction } from "@/app/actions/catalog";
import { PageHeader } from "@/components/office/page-header";
import { InvoiceUploadForm } from "@/components/office/invoice-upload-form";
import { StatusPill, invoiceStatusTone, invoiceStatusLabel } from "@/components/ui/status-pill";
import { NullValue } from "@/components/ui/null-value";
import { EmptyState } from "@/components/ui/empty-state";
import {
  TableContainer,
  Table,
  TableCaption,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { formatCalendarDate } from "@/lib/utils";

export const metadata = { title: "Invoices · Truestock" };

/**
 * Invoice archive — Phase 2.5 Slice 1 (upload + archive tracer bullet,
 * docs/plans/phase-2.5-invoice-automation/04-slices.md). Upload lands a row
 * here; extraction (Slice 2+) fills in the rest.
 *
 * ## Role split is load-bearing, not a display filter [AR-7]
 *
 * An owner gets `listInvoicesForOwnerAction()`; a manager gets
 * `listInvoicesRedactedAction()`, whose query never names a monetary
 * column. The action is picked BEFORE the fetch happens — never "fetch the
 * owner list and hide columns in the component" — because by the time a
 * component could hide anything, the money has already crossed the wire.
 * Mirrors `app/(office)/office/counts/page.tsx`'s `showValue` split.
 *
 * The "view original file" action is owner-only for the same reason
 * (`app/api/invoices/[id]/file/route.ts`'s `GET` requires `owner`, matching
 * `lib/authz.ts:canSeeCost` — the document's own printed price is cost
 * data). Rendering the link for a manager who would get a 403 on it is a
 * dead affordance, so the column itself doesn't exist for that role, same
 * "columns built per role" rule as the counts screen.
 *
 * The Slice 2 "Review" column is the same owner-only affordance, for the
 * same reason: `/office/invoices/[invoiceId]` is gated by
 * `getInvoiceAction`'s own `requireRole("owner")`, so a manager's link would
 * be a dead 403 too. It's a real `<Link>`, not a row `onClick` — AGENTS.md's
 * "Row-level edit is a real `<button>`" rule (this table also reflows: the
 * upload form sits above it) applies just as much to a navigation affordance
 * as an inline edit one.
 *
 * ## Every Slice 1 row is legitimately half-empty
 *
 * `invoice_number`, `invoice_date`, and `retention_until` (computed FROM
 * `invoice_date`, per `lib/domain/invoices.ts:computeRetentionUntil`) are
 * all NULL until an `extraction_job` actually runs — Slice 2, not built
 * yet. Rendering "Not yet extracted" instead of a fabricated or zero value
 * is the same rule this project already enforces for cost data
 * (docs/design-system.md §8): a plausible-but-wrong value on screen is
 * worse than an honest placeholder.
 *
 * `vendorId` is a DIFFERENT kind of missing — the uploader may simply not
 * have picked one (`uploadInvoiceSchema.vendorId` is optional), and nothing
 * about Slice 1 or Slice 2 fills it in automatically. That's `NullValue`'s
 * "not-applicable" (a dash), not "not yet extracted".
 *
 * Vendor NAMES aren't on `InvoiceRow`/`InvoiceRowRedacted` at all — both
 * only carry `vendorId`. Rather than touch `lib/domain/invoices.ts` (out of
 * scope for this slice, per the frontend brief) to add a join, this page
 * fetches `listVendorsAction()` alongside the invoice list and builds the
 * id -> name lookup here. `listVendorsAction` is already owner+manager,
 * no-cost-data (see its own doc comment in app/actions/catalog.ts), so this
 * adds no new role surface.
 */
export default async function InvoicesPage() {
  const user = await requireOfficeUser();
  const isOwner = user.role === "owner";

  const [invoicesResult, vendorsResult] = await Promise.all([
    isOwner ? listInvoicesForOwnerAction() : listInvoicesRedactedAction(),
    listVendorsAction(),
  ]);

  const invoices = invoicesResult.ok ? invoicesResult.data : [];
  const vendors = vendorsResult.ok ? vendorsResult.data : [];
  const vendorNameById = new Map(vendors.map((vendor) => [vendor.id, vendor.name]));

  const columnCount = isOwner ? 7 : 5;

  return (
    <div>
      <PageHeader
        title="Invoices"
        subtitle={
          <p className="text-row-subtitle text-muted-foreground">
            Supplier invoices, archived from upload. Extraction and cost capture arrive in a later
            phase — for now this is the durable record that a document was received.
          </p>
        }
      />

      <div className="mt-6 rounded-md border border-border bg-card p-6">
        <InvoiceUploadForm vendors={vendors} />
      </div>

      {!invoicesResult.ok ? (
        <p className="mt-6 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
          {invoicesResult.error.message}
        </p>
      ) : (
        <TableContainer className="mt-6">
          <Table>
            <TableCaption>Invoices, {invoices.length} total</TableCaption>
            <TableHeader>
              <TableRow interactive={false}>
                <TableHead>Invoice #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Retention until</TableHead>
                {isOwner ? <TableHead>File</TableHead> : null}
                {isOwner ? <TableHead>Review</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={columnCount}>
                    <EmptyState message="No invoices yet. Upload a photo or PDF of a supplier invoice above — this is where every invoice lands before extraction and archival." />
                  </td>
                </tr>
              ) : (
                invoices.map((invoice) => (
                  // Not interactive as a row: the only control is the File
                  // link inside its own cell (owner only). A row-wide hover
                  // would promise whole-row tap-ability that doesn't exist.
                  <TableRow key={invoice.id} interactive={false}>
                    <TableCell>
                      {invoice.invoiceNumber ?? (
                        <span className="text-row-subtitle text-muted-foreground">Not yet extracted</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {invoice.invoiceDate ? (
                        formatCalendarDate(invoice.invoiceDate)
                      ) : (
                        <span className="text-row-subtitle text-muted-foreground">Not yet extracted</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {invoice.vendorId != null ? (
                        (vendorNameById.get(invoice.vendorId) ?? `Vendor #${invoice.vendorId}`)
                      ) : (
                        <NullValue reason="not-applicable" />
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={invoiceStatusTone(invoice.status)}>
                        {invoiceStatusLabel(invoice.status)}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {invoice.retentionUntil ? (
                        formatCalendarDate(invoice.retentionUntil)
                      ) : (
                        <span className="text-row-subtitle text-muted-foreground">Not yet extracted</span>
                      )}
                    </TableCell>
                    {isOwner ? (
                      <TableCell>
                        <a
                          href={`/api/invoices/${invoice.id}/file`}
                          className="text-foreground underline"
                          target="_blank"
                          rel="noreferrer"
                        >
                          View
                        </a>
                      </TableCell>
                    ) : null}
                    {isOwner ? (
                      <TableCell>
                        <Link
                          href={`/office/invoices/${invoice.id}`}
                          className="text-foreground underline"
                        >
                          Review
                        </Link>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </div>
  );
}
