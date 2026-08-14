"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { formatUnits } from "@/lib/utils";
import { formatReorderOrderText } from "@/lib/reorder-format";
import type { ReorderItem } from "@/lib/domain/reports";

/**
 * One vendor's reorder block: the table `/office/reorder` already rendered
 * inline, plus a Copy (clipboard) and Print button (Gate 4 slice 6,
 * `02-architecture.md` Decision 9 — 100% client-side, no new server action;
 * the page already fetched and role-gated this data via `reorderListAction`).
 *
 * `asOfCountId`/`asOfClosedAt` are threaded down to here — not read fresh —
 * so a copied or printed order carries the exact as-of date the page
 * rendered with (Risk 8). `page.tsx` formats the `Date` to a string before
 * passing it down; this component and `lib/reorder-format.ts` stay
 * date-library-free.
 */
export function ReorderVendorBlock({
  vendorName,
  items,
  asOfCountId,
  asOfClosedAt,
}: {
  vendorName: string;
  items: ReorderItem[];
  asOfCountId: number;
  asOfClosedAt: string | null;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const headingId = useId();

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  async function handleCopy() {
    const text = formatReorderOrderText({
      vendorName,
      asOfCountId,
      asOfClosedAt,
      items: items.map((item) => ({
        productName: item.productName,
        suggestedOrderQty: item.suggestedOrderQty,
      })),
    });

    // navigator.clipboard requires a secure context (HTTPS or localhost). A
    // Copy button that silently does nothing when it's unavailable, or when
    // the write itself rejects, is worse than one that reports the failure —
    // the manager would text a vendor nothing and never find out why.
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setCopyState("error");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      setCopyState("error");
    }
  }

  function handlePrint() {
    // Print scoping is CSS-only (app/globals.css "Print scoping") — mark
    // this section as the print target and the document as actively
    // scoping, print, then clear both on `afterprint` so a cancelled print
    // dialog doesn't leave the page silently reduced to one vendor block.
    document.body.classList.add("print-scope-active");
    sectionRef.current?.classList.add("print-target");

    function cleanup() {
      document.body.classList.remove("print-scope-active");
      sectionRef.current?.classList.remove("print-target");
      window.removeEventListener("afterprint", cleanup);
    }
    window.addEventListener("afterprint", cleanup);

    window.print();
  }

  return (
    <section ref={sectionRef} aria-labelledby={headingId}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="text-label uppercase text-muted-foreground">
          {vendorName}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {copyState === "error" ? (
            <span className="text-caption text-negative" role="alert">
              Couldn&rsquo;t copy — clipboard isn&rsquo;t available here.
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="tap"
            onClick={handleCopy}
            aria-label={`Copy ${vendorName} order to clipboard`}
          >
            {copyState === "copied" ? (
              <Check className="size-4 text-success" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
            {copyState === "copied" ? "Copied" : "Copy order"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="tap"
            onClick={handlePrint}
            aria-label={`Print ${vendorName} order`}
          >
            <Printer className="size-4" aria-hidden="true" />
            Print
          </Button>
        </div>
      </div>
      <TableContainer className="rounded-md border border-border">
        <Table className="min-w-[34rem]">
          <TableCaption>{vendorName} reorder, {items.length} items</TableCaption>
          <TableHeader>
            <TableRow interactive={false}>
              <TableHead>Product</TableHead>
              <TableHead numeric>On hand</TableHead>
              <TableHead numeric>Par</TableHead>
              <TableHead numeric>Order</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.productId} interactive={false}>
                <TableCell>
                  <span
                    className="block max-w-[16rem] truncate text-row-subtitle text-foreground"
                    title={item.productName}
                  >
                    {item.productName}
                  </span>
                  <span className="text-caption text-muted-foreground">{item.category}</span>
                </TableCell>
                <TableCell numeric className="tabular-nums text-muted-foreground">
                  {formatUnits(item.onHand)}
                </TableCell>
                <TableCell numeric className="tabular-nums text-muted-foreground">
                  {formatUnits(item.parLevel)}
                </TableCell>
                <TableCell numeric className="text-numeral-sm tabular-nums text-foreground">
                  {formatUnits(item.suggestedOrderQty)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </section>
  );
}
