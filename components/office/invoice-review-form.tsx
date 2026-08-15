"use client";

/**
 * The review-invoice screen's interactive body — Phase 2.5, Slice 2
 * (docs/plans/phase-2.5-invoice-automation/04-slices.md, "Slice 2 —
 * Extraction + Review"). Owner-only end to end: the page that renders this
 * component already refused a non-owner via `getInvoiceAction`'s 403
 * (see app/(office)/office/invoices/[invoiceId]/page.tsx), and every action
 * called from here (`reviewInvoiceAction`, `rejectInvoiceAction`,
 * `resendToExtractionAction`) re-checks `requireRole("owner")` itself
 * (invariant 7) — this component's own role gate is belt, not buckle.
 *
 * ## Coded against the landed contract
 *
 * `getInvoiceLinesAction`, `reviewInvoiceAction`, `rejectInvoiceAction`, and
 * `resendToExtractionAction` all exist in `app/actions/invoices.ts`. The
 * shapes this file codes against — validated client-side via the SAME Zod
 * schemas the server uses (`lib/validation/invoices.ts`), imported directly
 * rather than re-implemented here, so client and server validation cannot
 * drift apart:
 *
 *   reviewInvoiceAction(input: {
 *     invoiceId: number,
 *     corrections: Array<{
 *       id: number,
 *       // DECIMAL(12,2) as the string mysql2 round-trips — never a JS
 *       // number. `/^-?\d{1,10}(\.\d{1,2})?$/`. `null` clears the column;
 *       // `undefined`/omitted leaves it unchanged (this form always sends
 *       // an explicit value for every editable line, never omits one).
 *       rawGross?: string | null,
 *       rawDiscount?: string | null,
 *       rawNet?: string | null,
 *       matchedProductId?: number | null,
 *     }>,
 *   }) => ActionResult<InvoiceRow>
 *
 *   rejectInvoiceAction(input: { invoiceId: number, reason: string })
 *     => ActionResult<InvoiceRow>
 *
 *   resendToExtractionAction(input: { invoiceId: number })
 *     => ActionResult<{ invoiceId: number, extractionJobId: number, status: InvoiceStatus }>
 *
 * `InvoiceLineRow` is imported from `lib/domain/invoice-lines.ts` (the read
 * shape `getInvoiceLinesAction` actually returns), not redeclared here.
 *
 * ## Status branching
 *
 * `needs_review` — the only status with editable money fields and an
 * Approve action (`reviewInvoiceAction`'s CAS only knows `needs_review ->
 * reviewed`; offering the button on any other status would just produce a
 * conflict error every time).
 * `reviewed` — read-only line values (nothing left in this slice writes
 * corrections to an already-reviewed line), but Return is still offered —
 * `lib/domain/invoices.ts`'s `INVOICE_TRANSITIONS` allows `reviewed ->
 * rejected`.
 * `rejected` — read-only (diagnostic) line values plus "Retry extraction"
 * (`resendToExtractionAction`), never Approve/Return — `rejected`'s only
 * legal edge is `-> processing`.
 * `approved` — fully terminal, read-only, no actions at all.
 * `uploaded` / `processing` never reach this component — the page renders a
 * plain "not ready for review" state instead (no lines exist yet to show).
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  reviewInvoiceAction,
  rejectInvoiceAction,
  resendToExtractionAction,
} from "@/app/actions/invoices";
import type { InvoiceRow } from "@/lib/domain/invoices";
import type { InvoiceLineRow, InvoiceLineUom } from "@/lib/domain/invoice-lines";
import type { ProductSummary } from "@/lib/domain/catalog";
import {
  lineCorrectionSchema,
  rejectInvoiceSchema,
  type ReviewInvoiceInput,
} from "@/lib/validation/invoices";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { NullValue } from "@/components/ui/null-value";
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
import { InvoiceExceptionBadges } from "@/components/office/invoice-exception-badges";
import { formatCostForInput } from "@/lib/utils";

/** One `corrections[]` entry, exactly as `reviewInvoiceSchema` (the SAME
 * schema `reviewInvoiceAction` validates with) shapes it — see the header
 * comment above. */
type LineCorrectionInput = ReviewInvoiceInput["corrections"][number];

const UOM_LABEL: Record<InvoiceLineUom, string> = {
  each: "Each",
  case: "Case",
  keg: "Keg",
  other: "Other",
};

/** Only the reason textarea uses a raw element now — the three money fields
 * below use the shared `Input` component (product-edit-form.tsx's own
 * money-input convention: `inputMode="decimal"`, no `type` attribute). */
const textareaClassName =
  "min-h-tap-min w-full rounded-md border border-input bg-card px-3 py-2 text-body text-foreground placeholder:text-muted-foreground";

interface LineFieldState {
  rawGross: string;
  rawDiscount: string;
  rawNet: string;
  matchedProductId: string;
}

function initialFieldState(line: InvoiceLineRow): LineFieldState {
  return {
    rawGross: formatCostForInput(line.rawGross),
    rawDiscount: formatCostForInput(line.rawDiscount),
    rawNet: formatCostForInput(line.rawNet),
    matchedProductId: line.matchedProductId == null ? "" : String(line.matchedProductId),
  };
}

function productLabel(product: ProductSummary): string {
  return product.brand ? `${product.name} — ${product.brand}` : product.name;
}

export function InvoiceReviewForm({
  invoice,
  lines,
  products,
}: {
  invoice: InvoiceRow;
  lines: InvoiceLineRow[];
  products: ProductSummary[];
}) {
  const router = useRouter();

  const orderedLines = useMemo(
    () => [...lines].sort((a, b) => a.lineNumber - b.lineNumber),
    [lines],
  );
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const [fields, setFields] = useState<Record<number, LineFieldState>>(() =>
    Object.fromEntries(orderedLines.map((line) => [line.id, initialFieldState(line)])),
  );
  const [lineErrors, setLineErrors] = useState<
    Record<number, Partial<Record<"rawGross" | "rawDiscount" | "rawNet", string>>>
  >({});

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  const editable = invoice.status === "needs_review";
  const canReturn = invoice.status === "needs_review" || invoice.status === "reviewed";
  const canRetry = invoice.status === "rejected";

  function updateField(lineId: number, key: keyof LineFieldState, value: string) {
    setFields((prev) => ({ ...prev, [lineId]: { ...prev[lineId], [key]: value } }));
  }

  async function handleApprove(event: React.FormEvent) {
    event.preventDefault();
    const corrections: LineCorrectionInput[] = [];
    const nextLineErrors: typeof lineErrors = {};
    let hasError = false;

    for (const line of orderedLines) {
      const state = fields[line.id];
      // Blank field -> `null` (explicitly clears the column); a non-blank
      // field is validated by `lineCorrectionSchema` itself — the SAME
      // schema `reviewInvoiceAction` parses with, so this can never accept
      // something the server would then reject (or vice versa).
      const candidate = {
        id: line.id,
        rawGross: state.rawGross.trim() === "" ? null : state.rawGross.trim(),
        rawDiscount: state.rawDiscount.trim() === "" ? null : state.rawDiscount.trim(),
        rawNet: state.rawNet.trim() === "" ? null : state.rawNet.trim(),
        matchedProductId: state.matchedProductId === "" ? null : Number(state.matchedProductId),
      };
      const parsed = lineCorrectionSchema.safeParse(candidate);
      if (!parsed.success) {
        const rowErrors: Partial<Record<"rawGross" | "rawDiscount" | "rawNet", string>> = {};
        for (const issue of parsed.error.issues) {
          const key = issue.path[0];
          if (key === "rawGross" || key === "rawDiscount" || key === "rawNet") {
            rowErrors[key] = issue.message;
          }
        }
        nextLineErrors[line.id] = rowErrors;
        hasError = true;
        continue;
      }
      corrections.push(parsed.data);
    }

    setLineErrors(nextLineErrors);
    if (hasError) {
      setError("Some lines need attention before this can be approved.");
      return;
    }

    setPending(true);
    setError(null);
    try {
      const result = await reviewInvoiceAction({ invoiceId: invoice.id, corrections });
      setPending(false);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      router.refresh();
    } catch {
      setPending(false);
      setError("Could not reach the server. Check your connection and try again.");
    }
  }

  async function handleConfirmReturn(event: React.FormEvent) {
    event.preventDefault();
    const parsed = rejectInvoiceSchema.safeParse({ invoiceId: invoice.id, reason });
    if (!parsed.success) {
      setReasonError(parsed.error.issues[0]?.message ?? "Enter a reason.");
      return;
    }
    setPending(true);
    setError(null);
    setReasonError(null);
    try {
      const result = await rejectInvoiceAction(parsed.data);
      setPending(false);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setReturning(false);
      setReason("");
      router.refresh();
    } catch {
      setPending(false);
      setError("Could not reach the server. Check your connection and try again.");
    }
  }

  async function handleRetry(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await resendToExtractionAction({ invoiceId: invoice.id });
      setPending(false);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      router.refresh();
    } catch {
      setPending(false);
      setError("Could not reach the server. Check your connection and try again.");
    }
  }

  // 7 columns always render (Description, Qty, UOM, Pack, Vendor code,
  // Matched product, Gross/Discount/Net) — `editable` only changes what's
  // rendered INSIDE the last two cells, never how many columns exist. A
  // conditional count here previously gave the empty-lines row colSpan={6}
  // against a 7-column table for any non-editable status.
  const columnCount = 7;

  return (
    <div className="mt-6 flex flex-col gap-section-gap">
      {invoice.status === "reviewed" ? (
        <p className="rounded-md bg-warning-bg px-3 py-2 text-caption text-warning" role="status">
          Reviewed — awaiting approval. Lines are locked; use Return below if this needs another
          look before it&apos;s approved.
        </p>
      ) : null}
      {invoice.status === "rejected" ? (
        <p className="rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="status">
          Returned for re-extraction. The lines below are from the last attempt, kept for
          diagnosis — retry to run extraction again.
        </p>
      ) : null}
      {invoice.status === "approved" ? (
        <p className="rounded-md bg-success-bg px-3 py-2 text-caption text-success" role="status">
          Approved. This is a permanent record and can no longer be changed here.
        </p>
      ) : null}

      <form method="post" onSubmit={editable ? handleApprove : (e) => e.preventDefault()}>
        <TableContainer>
          <Table>
            <TableCaption>
              Invoice {invoice.invoiceNumber ?? `#${invoice.id}`} lines, {orderedLines.length} total
            </TableCaption>
            <TableHeader>
              <TableRow interactive={false}>
                <TableHead>Description</TableHead>
                <TableHead numeric>Qty</TableHead>
                <TableHead>UOM</TableHead>
                <TableHead>Pack</TableHead>
                <TableHead>Vendor code</TableHead>
                <TableHead>Matched product</TableHead>
                <TableHead>Gross / Discount / Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orderedLines.length === 0 ? (
                <tr>
                  <td colSpan={columnCount}>
                    <p className="py-section-gap text-center text-row-subtitle text-muted-foreground">
                      No lines were extracted from this document.
                    </p>
                  </td>
                </tr>
              ) : (
                orderedLines.map((line) => {
                  const state = fields[line.id];
                  const rowErrors = lineErrors[line.id];
                  const matchedProduct =
                    line.matchedProductId != null ? productById.get(line.matchedProductId) : undefined;
                  return (
                    <TableRow key={line.id} interactive={false} className="align-top">
                      <TableCell>
                        <div className="flex flex-col gap-1.5">
                          <span>
                            {line.description ?? <NullValue reason="not-entered" />}
                          </span>
                          <InvoiceExceptionBadges flags={line.exceptionFlags} />
                        </div>
                      </TableCell>
                      <TableCell numeric className="text-muted-foreground">
                        {line.quantity ?? <NullValue reason="not-entered" />}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {line.uom ? UOM_LABEL[line.uom] : <NullValue reason="not-entered" />}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {line.packDescription ?? <NullValue reason="not-entered" />}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {line.vendorItemCode ?? <NullValue reason="not-entered" />}
                      </TableCell>
                      <TableCell>
                        {editable ? (
                          <Select
                            aria-label={`Matched product for line ${line.lineNumber}`}
                            value={state.matchedProductId}
                            onChange={(e) => updateField(line.id, "matchedProductId", e.target.value)}
                            className="min-w-[12rem]"
                          >
                            <option value="">Not matched</option>
                            {products.map((product) => (
                              <option key={product.id} value={product.id}>
                                {productLabel(product)}
                              </option>
                            ))}
                          </Select>
                        ) : matchedProduct ? (
                          <span>{productLabel(matchedProduct)}</span>
                        ) : (
                          <NullValue reason="not-entered" />
                        )}
                      </TableCell>
                      <TableCell>
                        {editable ? (
                          <div className="grid grid-cols-3 gap-2">
                            <Field
                              label="Gross"
                              htmlFor={`line-${line.id}-gross`}
                              error={rowErrors?.rawGross}
                              className="gap-1"
                            >
                              <Input
                                id={`line-${line.id}-gross`}
                                inputMode="decimal"
                                value={state.rawGross}
                                onChange={(e) => updateField(line.id, "rawGross", e.target.value)}
                                placeholder="0.00"
                                className="min-h-9 w-full"
                              />
                            </Field>
                            <Field
                              label="Discount"
                              htmlFor={`line-${line.id}-discount`}
                              error={rowErrors?.rawDiscount}
                              className="gap-1"
                            >
                              <Input
                                id={`line-${line.id}-discount`}
                                inputMode="decimal"
                                value={state.rawDiscount}
                                onChange={(e) => updateField(line.id, "rawDiscount", e.target.value)}
                                placeholder="0.00"
                                className="min-h-9 w-full"
                              />
                            </Field>
                            <Field
                              label="Net"
                              htmlFor={`line-${line.id}-net`}
                              error={rowErrors?.rawNet}
                              className="gap-1"
                            >
                              <Input
                                id={`line-${line.id}-net`}
                                inputMode="decimal"
                                value={state.rawNet}
                                onChange={(e) => updateField(line.id, "rawNet", e.target.value)}
                                placeholder="0.00"
                                className="min-h-9 w-full"
                              />
                            </Field>
                          </div>
                        ) : (
                          <span className="tabular-nums text-card-foreground">
                            {formatCostForInput(line.rawGross) || "—"} /{" "}
                            {formatCostForInput(line.rawDiscount) || "—"} /{" "}
                            {formatCostForInput(line.rawNet) || "—"}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </TableContainer>

        {error ? (
          <p className="mt-4 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
            {error}{" "}
            <button
              type="button"
              onClick={() => router.refresh()}
              className="underline"
            >
              Reload this invoice
            </button>
          </p>
        ) : null}

        {editable || canReturn ? (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {editable ? (
              <Button type="submit" size="primary" disabled={pending}>
                {pending ? "Approving…" : "Approve"}
              </Button>
            ) : null}
            {canReturn ? (
              <Button
                type="button"
                variant="outline"
                size="primary"
                disabled={pending}
                onClick={() => setReturning(true)}
              >
                Return
              </Button>
            ) : null}
          </div>
        ) : null}
      </form>

      {returning ? (
        <form
          method="post"
          onSubmit={handleConfirmReturn}
          className="flex flex-col gap-3 rounded-md border border-border bg-card p-card-pad"
        >
          <h2 className="text-label uppercase text-muted-foreground">
            Return {invoice.invoiceNumber ?? `invoice #${invoice.id}`} for re-extraction
          </h2>
          <Field
            label="Reason"
            htmlFor="reject-reason"
            error={reasonError ?? undefined}
            hint="Recorded on the invoice. Required."
          >
            <textarea
              id="reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className={textareaClassName}
            />
          </Field>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" variant="destructive" size="tap" disabled={pending}>
              {pending ? "Returning…" : "Confirm return"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="tap"
              disabled={pending}
              onClick={() => {
                setReturning(false);
                setReason("");
                setReasonError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {canRetry ? (
        <form method="post" onSubmit={handleRetry} className="flex flex-col gap-3">
          <Button type="submit" size="primary" disabled={pending} className="w-fit">
            {pending ? "Retrying…" : "Retry extraction"}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
