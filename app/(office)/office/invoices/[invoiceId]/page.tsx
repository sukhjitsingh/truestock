import { notFound } from "next/navigation";
import { requireOfficeUser } from "@/lib/current-user";
import { getInvoiceAction, getInvoiceLinesAction } from "@/app/actions/invoices";
import {
  listVendorsAction,
  searchProductsAction,
  getProductsByIdsAction,
} from "@/app/actions/catalog";
import { PageHeader } from "@/components/office/page-header";
import { InvoiceReviewForm } from "@/components/office/invoice-review-form";
import { StatusPill, invoiceStatusTone, invoiceStatusLabel } from "@/components/ui/status-pill";
import { Money } from "@/components/ui/money";
import { formatCalendarDate } from "@/lib/utils";

export const metadata = { title: "Review invoice · Truestock" };

/**
 * The review-invoice screen (Phase 2.5, Slice 2 —
 * docs/plans/phase-2.5-invoice-automation/04-slices.md). Owner-only [AR-7]:
 * `getInvoiceAction` itself refuses a manager/staff `requireRole("owner")`
 * call, and that refusal surfaces here as `!result.ok -> notFound()` — the
 * same shape `counts/[countId]/page.tsx` and `catalog/[productId]/page.tsx`
 * already use. A 404 rather than a 403 page is deliberate: a cross-tenant
 * `invoiceId` and "you're not an owner" must be indistinguishable from the
 * outside (invariant 9's "never confirm the row is real").
 *
 * `requireOfficeUser()` only redirects staff (to `/count`) — it does NOT
 * redirect a manager, so the `notFound()` above is what actually keeps a
 * manager out of this screen, not the office-user gate.
 *
 * ## Status branching
 *
 * `uploaded`/`processing` — no lines exist yet (extraction hasn't run, or
 * is running). Rendered as a plain "not ready for review" state; fetching
 * lines/products for a document with nothing to review yet would be a
 * wasted round trip, so neither is fetched in that case.
 * `needs_review`/`reviewed`/`rejected`/`approved` — handed to
 * `InvoiceReviewForm`, which owns the per-status editable/read-only/action
 * split (see that component's own doc comment).
 */
export default async function InvoiceReviewPage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  await requireOfficeUser();
  const invoiceId = Number((await params).invoiceId);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) notFound();

  const invoiceResult = await getInvoiceAction({ invoiceId });
  if (!invoiceResult.ok) notFound();
  const invoice = invoiceResult.data;

  const notReady = invoice.status === "uploaded" || invoice.status === "processing";

  const [vendorsResult, reviewData] = await Promise.all([
    listVendorsAction(),
    notReady
      ? Promise.resolve(null)
      : Promise.all([
          getInvoiceLinesAction({ invoiceId }),
          searchProductsAction({ activeOnly: true, limit: 100 }),
        ]),
  ]);

  const vendors = vendorsResult.ok ? vendorsResult.data : [];
  const vendorName =
    invoice.vendorId != null
      ? (vendors.find((vendor) => vendor.id === invoice.vendorId)?.name ?? `Vendor #${invoice.vendorId}`)
      : null;

  const linesResult = reviewData ? reviewData[0] : null;
  const productsResult = reviewData ? reviewData[1] : null;

  // `searchProductsAction` above is capped (`limit: 100`) and `activeOnly` —
  // a line's `matchedProductId` can point at a product outside that result
  // (org has >100 active products, or the matched product was later
  // deactivated per invariant 6). Left alone, the review form's lookup map
  // renders those lines as "not entered" even though they ARE matched — a
  // "plausible but wrong" display bug (AGENTS.md), fixed here by resolving
  // whichever matched ids the capped search didn't already return.
  let products = productsResult?.ok ? productsResult.data : [];
  if (linesResult?.ok) {
    const knownIds = new Set(products.map((product) => product.id));
    const missingIds = [
      ...new Set(
        linesResult.data
          .map((line) => line.matchedProductId)
          .filter((id): id is number => id != null && !knownIds.has(id)),
      ),
    ];
    if (missingIds.length > 0) {
      const missingResult = await getProductsByIdsAction({ ids: missingIds });
      if (missingResult.ok) {
        products = [...products, ...missingResult.data];
      }
    }
  }

  return (
    <div>
      <PageHeader
        title={invoice.invoiceNumber ?? `Invoice #${invoice.id}`}
        breadcrumb={{ label: "← All invoices", href: "/office/invoices" }}
        pills={
          <StatusPill tone={invoiceStatusTone(invoice.status)}>
            {invoiceStatusLabel(invoice.status)}
          </StatusPill>
        }
        subtitle={
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-row-subtitle text-muted-foreground">
            {vendorName ? <span>{vendorName}</span> : null}
            {invoice.invoiceDate ? <span>{formatCalendarDate(invoice.invoiceDate)}</span> : null}
            {invoice.totalNet != null ? (
              <Money value={Number(invoice.totalNet)} className="text-row-subtitle" />
            ) : null}
          </p>
        }
      />

      {notReady || !linesResult ? (
        <div className="mt-6 rounded-md border border-border bg-card p-card-pad">
          <p className="text-row-subtitle text-muted-foreground">
            {invoice.status === "uploaded"
              ? "This invoice hasn't started extraction yet. Check back shortly."
              : "Extraction is running. This invoice isn't ready for review yet — check back shortly."}
          </p>
        </div>
      ) : !linesResult.ok ? (
        <p className="mt-6 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
          {linesResult.error.message}
        </p>
      ) : (
        <InvoiceReviewForm invoice={invoice} lines={linesResult.data} products={products} />
      )}
    </div>
  );
}
