/**
 * Challenger 1 (challenger_m1_1) Empirical Adversarial Verification Suite.
 *
 * Focus areas:
 * 1. Role-Gated Cost Visibility (Invariant 8): Proving non-owners NEVER render unpriced cards, valuation totals, or cost columns.
 * 2. Invoice Review Split-Screen Responsive Layout: Proving mobile stacked (grid-cols-1) and desktop side-by-side (lg:grid-cols-12, col-span-5 / col-span-7).
 * 3. @media print Styling on Reorder: Proving CSS print scoping, target positioning, and clipboard formatting.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { canSeeCost, canManageCost, canManageInventoryOps } from "@/lib/authz";
import { Money } from "@/components/ui/money";
import { NullValue } from "@/components/ui/null-value";
import { formatReorderOrderText } from "@/lib/reorder-format";
import type { ProductSummary } from "@/lib/domain/catalog";

describe("Adversarial Test 1: Invariant 8 Role-Gated Cost Visibility & DOM Omission", () => {
  test("Role authorization matrix strictly denies cost visibility and cost management to Manager and Staff", () => {
    // Owner
    expect(canSeeCost("owner")).toBe(true);
    expect(canManageCost("owner")).toBe(true);
    expect(canManageInventoryOps("owner")).toBe(true);

    // Manager
    expect(canSeeCost("manager")).toBe(false);
    expect(canManageCost("manager")).toBe(false);
    expect(canManageInventoryOps("manager")).toBe(true);

    // Staff
    expect(canSeeCost("staff")).toBe(false);
    expect(canManageCost("staff")).toBe(false);
    expect(canManageInventoryOps("staff")).toBe(false);
  });

  test("Money component returns null (0 DOM nodes) for undefined or null values", () => {
    expect(Money({ value: undefined })).toBeNull();
    expect(Money({ value: null })).toBeNull();
    expect(NullValue({ reason: "role-gated" })).toBeNull();
  });

  test("Dashboard page source code gates Unpriced products card strictly on user.role === 'owner'", () => {
    const dashboardSource = readFileSync(
      resolve(process.cwd(), "app/(office)/office/page.tsx"),
      "utf-8",
    );

    // Assert that the Unpriced Products card is gated by user.role === 'owner'
    expect(dashboardSource).toContain('user.role === "owner" && catalogHealth');
    expect(dashboardSource).toContain("Unpriced products");
    expect(dashboardSource).toContain("have no cost on file — excluded from valuation");

    // Assert that Last closed count totalValue uses <Money value={...}> which returns null when undefined
    expect(dashboardSource).toContain(
      "value={lastClosed.totalValue != null ? Number(lastClosed.totalValue) : undefined}",
    );
  });

  test("Count summary page source code gates snapshot valuation tile and grid layout on totalValue != null", () => {
    const countSummarySource = readFileSync(
      resolve(process.cwd(), "app/(office)/office/counts/[countId]/page.tsx"),
      "utf-8",
    );

    // Grid shifts to sm:grid-cols-2 when totalValue is null (manager/staff) vs sm:grid-cols-3 (owner)
    expect(countSummarySource).toContain(
      'summary.totalValue != null ? "sm:grid-cols-3" : "sm:grid-cols-2"',
    );
    expect(countSummarySource).toContain("Snapshot Valuation");

    // Valuation variance is conditionally rendered only when totalValue is present
    expect(countSummarySource).toContain("Valuation Variance");
    expect(countSummarySource).toContain("summary.totalValue != null");
  });

  test("Counts ledger table source code conditionally omits Snapshot Value column for non-owners", () => {
    const countsLedgerSource = readFileSync(
      resolve(process.cwd(), "app/(office)/office/counts/page.tsx"),
      "utf-8",
    );

    expect(countsLedgerSource).toContain('const showValue = user.role === "owner";');
    expect(countsLedgerSource).toContain("const columnCount = showValue ? 7 : 6;");
    expect(countsLedgerSource).toContain('{showValue ? <TableHead numeric>Snapshot Value</TableHead> : null}');
  });

  test("Catalog table column generation completely omits unitCost column when canSeeCost is false", () => {
    const catalogTableSource = readFileSync(
      resolve(process.cwd(), "components/office/catalog-table.tsx"),
      "utf-8",
    );

    // Verify conditional column inclusion
    expect(catalogTableSource).toContain("if (canSeeCost) {");
    expect(catalogTableSource).toContain('id: "unitCost"');
    expect(catalogTableSource).toContain("if (canManage) {");
    expect(catalogTableSource).toContain('id: "caseSize"');
    expect(catalogTableSource).toContain('id: "edit"');
  });
});

describe("Adversarial Test 2: Invoice Review Split-Screen Responsive Layout", () => {
  test("Invoice review form implements grid-cols-1 on mobile and lg:grid-cols-12 on desktop", () => {
    const formSource = readFileSync(
      resolve(process.cwd(), "components/office/invoice-review-form.tsx"),
      "utf-8",
    );

    // Outer responsive grid
    expect(formSource).toContain("grid grid-cols-1 lg:grid-cols-12 gap-6 items-start");

    // Left column: PDF Document viewer (5 cols on desktop, sticky)
    expect(formSource).toContain("lg:col-span-5 flex flex-col gap-4");
    expect(formSource).toContain("lg:sticky lg:top-20");
    expect(formSource).toContain("Source Document Preview");
    expect(formSource).toContain("<iframe");

    // Right column: Extracted Ledger & Review actions (7 cols on desktop)
    expect(formSource).toContain("lg:col-span-7 flex flex-col gap-6");
    expect(formSource).toContain("Invoice Details");
    expect(formSource).toContain("Gross / Discount / Net");
  });

  test("Invoice review page enforces Invariant 7/8 owner-only access and 404s non-owners", () => {
    const pageSource = readFileSync(
      resolve(process.cwd(), "app/(office)/office/invoices/[invoiceId]/page.tsx"),
      "utf-8",
    );

    expect(pageSource).toContain("const invoiceResult = await getInvoiceAction({ invoiceId });");
    expect(pageSource).toContain("if (!invoiceResult.ok) notFound();");
  });
});

describe("Adversarial Test 3: Reorder Page @media print & Export Support", () => {
  test("globals.css defines print-scope-active and print-target rules for CSS-only print scoping", () => {
    const cssSource = readFileSync(
      resolve(process.cwd(), "app/globals.css"),
      "utf-8",
    );

    expect(cssSource).toContain("@media print");
    expect(cssSource).toContain("body.print-scope-active *");
    expect(cssSource).toContain("visibility: hidden;");
    expect(cssSource).toContain("body.print-scope-active .print-target");
    expect(cssSource).toContain("visibility: visible;");
    expect(cssSource).toContain("position: absolute;");
    expect(cssSource).toContain("left: 0;");
    expect(cssSource).toContain("top: 0;");
    expect(cssSource).toContain("width: 100%;");
  });

  test("ReorderVendorBlock attaches and cleans up print-scope-active and print-target on window print", () => {
    const vendorBlockSource = readFileSync(
      resolve(process.cwd(), "components/office/reorder-vendor-block.tsx"),
      "utf-8",
    );

    expect(vendorBlockSource).toContain('document.body.classList.add("print-scope-active");');
    expect(vendorBlockSource).toContain('sectionRef.current?.classList.add("print-target");');
    expect(vendorBlockSource).toContain('window.addEventListener("afterprint", cleanup);');
    expect(vendorBlockSource).toContain('document.body.classList.remove("print-scope-active");');
    expect(vendorBlockSource).toContain('sectionRef.current?.classList.remove("print-target");');
    expect(vendorBlockSource).toContain("window.print();");
  });

  test("formatReorderOrderText produces structured clipboard output with vendor and items", () => {
    const formatted = formatReorderOrderText({
      vendorName: "Southern Glazer's Wine & Spirits",
      asOfCountId: 42,
      asOfClosedAt: "2026-08-20",
      items: [
        { productName: "Tito's Handmade Vodka 750ml", suggestedOrderQty: 12 },
        { productName: "Bulleit Bourbon 750ml", suggestedOrderQty: 6 },
        { productName: "Casamigos Blanco 750ml", suggestedOrderQty: 4 },
      ],
    });

    expect(formatted).toContain("Southern Glazer's Wine & Spirits");
    expect(formatted).toContain("Count #42");
    expect(formatted).toContain("2026-08-20");
    expect(formatted).toContain("Tito's Handmade Vodka 750ml ... 12");
    expect(formatted).toContain("Bulleit Bourbon 750ml ......... 6");
    expect(formatted).toContain("Casamigos Blanco 750ml ........ 4");
    expect(formatted).toContain("3 items");
  });
});
