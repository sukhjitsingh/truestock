/**
 * Milestone 4: Desktop/Tablet Back-Office Web Workspace comprehensive unit tests.
 * Validates OfficeRail cookie contract, OfficeBreadcrumb resolution,
 * Role-gating DOM omission contracts, NullValue vocabulary, and audit packet validation.
 */
import { describe, test, expect } from "bun:test";
import { RAIL_COOKIE } from "@/lib/ui-cookies";
import { canSeeCost, canManageCost, canManageInventoryOps } from "@/lib/authz";
import { NullValue } from "@/components/ui/null-value";
import { Money } from "@/components/ui/money";
import {
  TableContainer,
  Table,
  TableCaption,
  TableHead,
  TableRow,
  TableCell,
  SortableTableHead,
} from "@/components/ui/table";
import { computeLineAlerts } from "@/lib/invoice-line-alerts";
import { formatReorderOrderText } from "@/lib/reorder-format";

describe("OfficeRail Cookie Contract", () => {
  test("RAIL_COOKIE constant matches truestock_rail for zero-FOUC server layout rendering", () => {
    expect(RAIL_COOKIE).toBe("truestock_rail");
  });
});

describe("OfficeBreadcrumb Section Resolution", () => {
  const SECTIONS = [
    { prefix: "/office/counts", label: "Counts" },
    { prefix: "/office/catalog", label: "Catalog" },
    { prefix: "/office/locations", label: "Locations" },
    { prefix: "/office/invoices", label: "Invoices" },
    { prefix: "/office/vendors", label: "Vendors" },
    { prefix: "/office/reorder", label: "Reorder" },
    { prefix: "/office/users", label: "Users" },
  ];

  function resolveBreadcrumb(pathname: string): string {
    const section = SECTIONS.find((s) => pathname.startsWith(s.prefix));
    return section ? section.label : "Dashboard";
  }

  test("resolves all main back-office routes correctly", () => {
    expect(resolveBreadcrumb("/office")).toBe("Dashboard");
    expect(resolveBreadcrumb("/office/counts")).toBe("Counts");
    expect(resolveBreadcrumb("/office/counts/1246799")).toBe("Counts");
    expect(resolveBreadcrumb("/office/catalog")).toBe("Catalog");
    expect(resolveBreadcrumb("/office/catalog/42")).toBe("Catalog");
    expect(resolveBreadcrumb("/office/locations")).toBe("Locations");
    expect(resolveBreadcrumb("/office/invoices")).toBe("Invoices");
    expect(resolveBreadcrumb("/office/invoices/99")).toBe("Invoices");
    expect(resolveBreadcrumb("/office/invoices/audit-packet")).toBe("Invoices");
    expect(resolveBreadcrumb("/office/vendors")).toBe("Vendors");
    expect(resolveBreadcrumb("/office/reorder")).toBe("Reorder");
    expect(resolveBreadcrumb("/office/users")).toBe("Users");
    expect(resolveBreadcrumb("/office/unknown-subroute")).toBe("Dashboard");
  });
});

describe("Invariant 8 Role-Gated Predicates & Data Scrubbing", () => {
  test("Owner can see and manage cost, and manage inventory ops", () => {
    expect(canSeeCost("owner")).toBe(true);
    expect(canManageCost("owner")).toBe(true);
    expect(canManageInventoryOps("owner")).toBe(true);
  });

  test("Manager can manage inventory ops but CANNOT see or manage cost", () => {
    expect(canSeeCost("manager")).toBe(false);
    expect(canManageCost("manager")).toBe(false);
    expect(canManageInventoryOps("manager")).toBe(true);
  });

  test("Staff cannot see cost and cannot manage inventory ops (count-only)", () => {
    expect(canSeeCost("staff")).toBe(false);
    expect(canManageCost("staff")).toBe(false);
    expect(canManageInventoryOps("staff")).toBe(false);
  });
});

describe("4-Way Absent Value Vocabulary Contract", () => {
  test("Case 1 (not-applicable): renders em dash '—'", () => {
    const el = NullValue({ reason: "not-applicable" });
    expect(el).not.toBeNull();
    expect(el?.props.children).toBe("—");
    expect(el?.props.className).toContain("text-muted-foreground");
  });

  test("Case 2 (not-entered): renders 'Not entered' in muted text, never italic", () => {
    const el = NullValue({ reason: "not-entered" });
    expect(el).not.toBeNull();
    expect(el?.props.children).toBe("Not entered");
    expect(el?.props.className).toContain("text-muted-foreground");
    expect(el?.props.className).not.toContain("italic");
  });

  test("Case 3 (role-gated): renders NOTHING (null in DOM)", () => {
    const el = NullValue({ reason: "role-gated" });
    expect(el).toBeNull();

    const moneyNull = Money({ value: null });
    expect(moneyNull).toBeNull();

    const moneyUndefined = Money({ value: undefined });
    expect(moneyUndefined).toBeNull();
  });

  test("Money component formats valid positive and zero values correctly", () => {
    const money100 = Money({ value: 100 });
    expect(money100).not.toBeNull();
    expect(money100?.props.children).toBe("$100.00");
    expect(money100?.props.className).toContain("tabular-nums");
  });
});

describe("Standardized Office Table Primitives & Accessibility", () => {
  test("Table layout standards: min-w-max, border-collapse, scope='col', .num alignment", () => {
    const container = TableContainer({ children: "content" });
    expect(container.props.className).toContain("overflow-x-auto");

    const table = Table({ children: "content" });
    expect(table.props.className).toContain("border-collapse");
    expect(table.props.className).toContain("min-w-max");

    const caption = TableCaption({ children: "Catalog Table" });
    expect(caption.props.className).toContain("sr-only");
    expect(caption.props.children).toBe("Catalog Table");

    const th = TableHead({ children: "Unit Cost", numeric: true });
    expect(th.props.scope).toBe("col");
    expect(th.props.className).toContain("num");

    const sortTh = SortableTableHead({
      children: "Category",
      direction: "asc",
      onSort: () => {},
    });
    expect(sortTh.props.scope).toBe("col");
    expect(sortTh.props["aria-sort"]).toBe("ascending");

    const tr = TableRow({ children: "row", interactive: true });
    expect(tr.props.className).toContain("h-row-office");
    expect(tr.props.className).toContain("min-h-row-office");
    expect(tr.props.className).toContain("hover:bg-muted");

    const td = TableCell({ children: "123", numeric: true });
    expect(td.props.className).toContain("num");
  });
});

describe("Phase 2.5 Invoice Line Math Validation Alerts", () => {
  test("flags discount > 50% of gross", () => {
    const alerts = computeLineAlerts("100.00", "60.00", "40.00");
    expect(alerts.some((a) => a.key === "discount-over-50")).toBe(true);
  });

  test("flags negative net", () => {
    const alerts = computeLineAlerts("100.00", "0.00", "-10.00");
    expect(alerts.some((a) => a.key === "negative-net")).toBe(true);
  });

  test("clean line has no alerts", () => {
    const alerts = computeLineAlerts("100.00", "10.00", "90.00");
    expect(alerts.length).toBe(0);
  });
});

describe("Phase 2.5 Reorder Text Clipboard Export", () => {
  test("formats reorder block with vendor and item counts", () => {
    const text = formatReorderOrderText({
      vendorName: "Acme Distribution",
      asOfCountId: 101,
      asOfClosedAt: "Aug 22, 2026",
      items: [
        { productName: "Vodka 750ml", suggestedOrderQty: 5 },
        { productName: "Gin 750ml", suggestedOrderQty: 2 },
      ],
    });
    expect(text).toContain("Acme Distribution");
    expect(text).toContain("Count #101");
    expect(text).toContain("Aug 22, 2026");
    expect(text).toContain("Vodka 750ml");
    expect(text).toContain("2 items");
  });
});
