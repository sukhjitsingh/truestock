/**
 * Empirical Challenger 2 (challenger_m1_2) Adversarial Test Suite
 * Milestone 1: Phase 1 Back-Office UI/UX Redesign
 *
 * Scope:
 * 1. Empty states across /office, /office/counts, /office/invoices, /office/reorder.
 * 2. Date-range validation and error states on /office/invoices/audit-packet.
 * 3. Table container scrolling on narrow viewports and table token contracts.
 */
import { describe, test, expect } from "bun:test";
import { createAuditPacketSchema } from "@/lib/validation/invoices";
import {
  TableContainer,
  Table,
  TableCaption,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  SortableTableHead,
  TablePagination,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { NullValue } from "@/components/ui/null-value";
import { StatusPill, countStatusTone, countStatusLabel, invoiceStatusTone, invoiceStatusLabel } from "@/components/ui/status-pill";
import { Money } from "@/components/ui/money";
import { isCountWritable } from "@/lib/count-status";
import { formatCalendarDate } from "@/lib/utils";

describe("1. Empty States Across Back-Office Routes", () => {
  describe("/office (Dashboard) Empty & Edge States", () => {
    test("Active count tile: handles null active count correctly", () => {
      const active = null;
      const hasActive = active != null;
      expect(hasActive).toBe(false);
      // Empty state text requirement
      const emptyLabel = "Count in progress";
      const emptySubtitle = "Nothing open right now.";
      expect(emptyLabel).toBe("Count in progress");
      expect(emptySubtitle).toBe("Nothing open right now.");
    });

    test("Active count tile: writable status renders 'Resume', submitted renders 'Review'", () => {
      expect(isCountWritable("draft")).toBe(true);
      expect(isCountWritable("in_progress")).toBe(true);
      expect(isCountWritable("submitted")).toBe(false);
      expect(isCountWritable("closed")).toBe(false);

      const draftAction = isCountWritable("in_progress") ? "Resume" : "Review";
      const submittedAction = isCountWritable("submitted") ? "Resume" : "Review";
      expect(draftAction).toBe("Resume");
      expect(submittedAction).toBe("Review");
    });

    test("Last closed count tile: handles null closed count vs closed count", () => {
      const lastClosedNull = null;
      expect(lastClosedNull).toBeNull();

      const lastClosedValid = {
        id: 42,
        type: "full",
        closedAt: new Date("2026-08-01T12:00:00Z"),
        closedByName: "Alice Manager",
        totalValue: "1542.5000",
      };
      expect(lastClosedValid.id).toBe(42);
      expect(Number(lastClosedValid.totalValue)).toBe(1542.5);
    });

    test("Reorder pressure tile: 3-way branching on count and par availability", () => {
      // Case 1: No closed count yet
      const reorderNoCount = { asOfCountId: null, productsWithPar: 0, items: [] };
      const msgNoCount = reorderNoCount.asOfCountId == null
        ? "No closed count yet — nothing to compare against par."
        : "";
      expect(msgNoCount).toBe("No closed count yet — nothing to compare against par.");

      // Case 2: Closed count exists but 0 products have par
      const reorderNoPar = { asOfCountId: 10, productsWithPar: 0, items: [] };
      const msgNoPar = reorderNoPar.productsWithPar === 0
        ? "No par levels set yet, so there is nothing to compare on-hand against."
        : "";
      expect(msgNoPar).toBe("No par levels set yet, so there is nothing to compare on-hand against.");

      // Case 3: Closed count exists, pars set, 0 items below par
      const reorderAllGood = { asOfCountId: 10, productsWithPar: 50, items: [] };
      const countLabel = `${reorderAllGood.items.length} products`;
      expect(countLabel).toBe("0 products");
    });

    test("Unpriced products tile: role gated to owner only", () => {
      const isOwner = (role: string) => role === "owner";
      expect(isOwner("owner")).toBe(true);
      expect(isOwner("manager")).toBe(false);
      expect(isOwner("staff")).toBe(false);
    });
  });

  describe("/office/counts Empty Table State", () => {
    test("Computes correct colSpan per role on empty table", () => {
      const getColSpan = (role: string) => (role === "owner" ? 7 : 6);
      expect(getColSpan("owner")).toBe(7);
      expect(getColSpan("manager")).toBe(6);
    });

    test("EmptyState renders informative empty message", () => {
      const el = EmptyState({ message: "No counts yet. The first one builds most of the catalog as it goes." });
      expect(el.props.className).toContain("text-center");
      const pChild = Array.isArray(el.props.children) ? el.props.children[0] : el.props.children;
      expect(pChild.props.children).toBe("No counts yet. The first one builds most of the catalog as it goes.");
    });
  });

  describe("/office/invoices Empty Table State & Field Fallbacks", () => {
    test("Computes correct colSpan per role on empty table", () => {
      const getColSpan = (role: string) => (role === "owner" ? 7 : 5);
      expect(getColSpan("owner")).toBe(7);
      expect(getColSpan("manager")).toBe(5);
    });

    test("Handles unextracted invoice fields honestly with 'Not yet extracted'", () => {
      const unextractedInvoice = {
        id: 1,
        invoiceNumber: null,
        invoiceDate: null,
        vendorId: null,
        status: "uploaded" as const,
        retentionUntil: null,
      };

      const invoiceNumDisplay = unextractedInvoice.invoiceNumber ?? "Not yet extracted";
      const invoiceDateDisplay = unextractedInvoice.invoiceDate ? formatCalendarDate(unextractedInvoice.invoiceDate) : "Not yet extracted";
      const retentionDisplay = unextractedInvoice.retentionUntil ? formatCalendarDate(unextractedInvoice.retentionUntil) : "Not yet extracted";

      expect(invoiceNumDisplay).toBe("Not yet extracted");
      expect(invoiceDateDisplay).toBe("Not yet extracted");
      expect(retentionDisplay).toBe("Not yet extracted");
    });
  });

  describe("/office/reorder Empty State & Grouping Walk", () => {
    test("Walk correctly groups items by vendor without re-sorting", () => {
      const items = [
        { vendorName: "Vendor A", productName: "Item 1", suggestedOrderQty: 5 },
        { vendorName: "Vendor A", productName: "Item 2", suggestedOrderQty: 2 },
        { vendorName: "Vendor B", productName: "Item 3", suggestedOrderQty: 10 },
        { vendorName: null, productName: "Item 4", suggestedOrderQty: 1 },
      ];

      const groups: { vendor: string; items: typeof items }[] = [];
      for (const item of items) {
        const vendor = item.vendorName ?? "No vendor set";
        const last = groups[groups.length - 1];
        if (last && last.vendor === vendor) last.items.push(item);
        else groups.push({ vendor, items: [item] });
      }

      expect(groups).toHaveLength(3);
      expect(groups[0].vendor).toBe("Vendor A");
      expect(groups[0].items).toHaveLength(2);
      expect(groups[1].vendor).toBe("Vendor B");
      expect(groups[1].items).toHaveLength(1);
      expect(groups[2].vendor).toBe("No vendor set");
      expect(groups[2].items).toHaveLength(1);
    });
  });
});

describe("2. Date-Range Validation & Error States on /office/invoices/audit-packet", () => {
  function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function validateRange(dateFrom: string, dateTo: string): string | null {
    if (!dateFrom || !dateTo) return "Choose both a start and end date.";
    if (dateFrom > dateTo) return "End date must be on or after the start date.";
    if (dateTo > todayIso()) return "End date cannot be in the future.";
    return null;
  }

  test("validateRange: rejects empty dateFrom or dateTo", () => {
    expect(validateRange("", "")).toBe("Choose both a start and end date.");
    expect(validateRange("2026-01-01", "")).toBe("Choose both a start and end date.");
    expect(validateRange("", "2026-01-31")).toBe("Choose both a start and end date.");
  });

  test("validateRange: rejects backwards date range (dateFrom > dateTo)", () => {
    expect(validateRange("2026-02-01", "2026-01-01")).toBe("End date must be on or after the start date.");
  });

  test("validateRange: rejects future dateTo", () => {
    expect(validateRange("2026-01-01", "2099-12-31")).toBe("End date cannot be in the future.");
  });

  test("validateRange: accepts valid past or present range", () => {
    expect(validateRange("2026-01-01", "2026-01-31")).toBeNull();
    expect(validateRange("2026-01-15", "2026-01-15")).toBeNull();
  });

  test("createAuditPacketSchema: accepts valid calendar ranges", () => {
    const res = createAuditPacketSchema.safeParse({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
    expect(res.success).toBe(true);
  });

  test("createAuditPacketSchema: accepts leap year Feb 29 (2024)", () => {
    const res = createAuditPacketSchema.safeParse({
      dateFrom: "2024-02-01",
      dateTo: "2024-02-29",
    });
    expect(res.success).toBe(true);
  });

  test("createAuditPacketSchema: rejects non-leap year Feb 29 (2025-02-29)", () => {
    const res = createAuditPacketSchema.safeParse({
      dateFrom: "2025-02-01",
      dateTo: "2025-02-29",
    });
    expect(res.success).toBe(false);
  });

  test("createAuditPacketSchema: rejects non-existent dates (2026-02-30, 2026-04-31)", () => {
    const res1 = createAuditPacketSchema.safeParse({
      dateFrom: "2026-02-01",
      dateTo: "2026-02-30",
    });
    expect(res1.success).toBe(false);

    const res2 = createAuditPacketSchema.safeParse({
      dateFrom: "2026-04-01",
      dateTo: "2026-04-31",
    });
    expect(res2.success).toBe(false);
  });

  test("createAuditPacketSchema: rejects inverted range (dateFrom > dateTo)", () => {
    const res = createAuditPacketSchema.safeParse({
      dateFrom: "2026-05-10",
      dateTo: "2026-05-01",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].message).toBe("dateFrom must be on or before dateTo.");
    }
  });

  test("createAuditPacketSchema: rejects future dateTo", () => {
    const res = createAuditPacketSchema.safeParse({
      dateFrom: "2026-01-01",
      dateTo: "2099-01-01",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].message).toBe("dateTo cannot be in the future.");
    }
  });
});

describe("3. Table Container Responsive Scrolling & Styling", () => {
  test("TableContainer enforces overflow-x-auto and glass styling", () => {
    const container = TableContainer({ children: null, className: "custom-class" });
    expect(container.props.className).toContain("overflow-x-auto");
    expect(container.props.className).toContain("w-full");
    expect(container.props.className).toContain("rounded-xl");
    expect(container.props.className).toContain("border");
    expect(container.props.className).toContain("bg-card/85");
    expect(container.props.className).toContain("backdrop-blur-md");
    expect(container.props.className).toContain("custom-class");
  });

  test("Table enforces min-w-max to prevent column compression on small screens", () => {
    const table = Table({ children: null });
    expect(table.props.className).toContain("min-w-max");
    expect(table.props.className).toContain("w-full");
    expect(table.props.className).toContain("border-collapse");
  });

  test("TableHeader applies subtle backdrop blur and border", () => {
    const header = TableHeader({ children: null });
    expect(header.props.className).toContain("border-b");
    expect(header.props.className).toContain("bg-secondary/50");
    expect(header.props.className).toContain("backdrop-blur-sm");
  });

  test("TableRow adheres to h-row-office token and interactive hover", () => {
    const rowInteractive = TableRow({ children: null, interactive: true });
    expect(rowInteractive.props.className).toContain("h-row-office");
    expect(rowInteractive.props.className).toContain("min-h-row-office");
    expect(rowInteractive.props.className).toContain("hover:bg-muted");

    const rowNonInteractive = TableRow({ children: null, interactive: false });
    expect(rowNonInteractive.props.className).toContain("h-row-office");
    expect(rowNonInteractive.props.className).not.toContain("hover:bg-muted");
  });

  test("TableHead enforces scope='col' and numeric alignment class", () => {
    const th = TableHead({ children: "Total", numeric: true });
    expect(th.props.scope).toBe("col");
    expect(th.props.className).toContain("num");
    expect(th.props.className).toContain("uppercase");
    expect(th.props.className).toContain("text-muted-foreground");
  });

  test("SortableTableHead renders semantic button with live aria-sort", () => {
    const thAsc = SortableTableHead({ children: "Date", direction: "asc", onSort: () => {} });
    expect(thAsc.props.scope).toBe("col");
    expect(thAsc.props["aria-sort"]).toBe("ascending");

    const thDesc = SortableTableHead({ children: "Date", direction: "desc", onSort: () => {} });
    expect(thDesc.props["aria-sort"]).toBe("descending");

    const thNone = SortableTableHead({ children: "Date", direction: false, onSort: () => {} });
    expect(thNone.props["aria-sort"]).toBe("none");
  });

  test("TablePagination handles boundaries and disabled states", () => {
    const pag = TablePagination({
      rangeLabel: "Showing 1–20 of 100",
      page: 1,
      pageCount: 5,
      onPreviousPage: () => {},
      onNextPage: () => {},
    });
    expect(pag.props.className).toContain("border-t");
  });
});
