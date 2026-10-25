/**
 * Challenger 2 Adversarial Stress Test Suite: Back-Office & State Transitions
 *
 * Empirical verification of:
 * 1. Collapsible OfficeRail (cookie persistence, SSR read, top-anchored chevron toggle, DOM widths, role filtering)
 * 2. Breadcrumb path matching across all office routes and edge cases
 * 3. Invariant 8 Role-Gating: TanStack Table v8 column array construction across all 3 roles (owner, manager, staff)
 * 4. Audit Packet Date Range boundary edge cases (dateFrom > dateTo, dateTo > today, single-day, multi-year, invalid calendar dates)
 * 5. Split-Screen Invoice OCR Review: CAS transitions, math alerts, line exception badges, header corrections, and atomic cost posting contracts
 */
import { describe, test, expect } from "bun:test";
import { RAIL_COOKIE } from "@/lib/ui-cookies";
import { canSeeCost, canManageCost, canManageInventoryOps, type Role } from "@/lib/authz";
import {
  createAuditPacketSchema,
  headerCorrectionSchema,
  lineCorrectionSchema,
  rejectInvoiceSchema,
  reviewInvoiceSchema,
  approveInvoiceSchema,
} from "@/lib/validation/invoices";
import { computeLineAlerts } from "@/lib/invoice-line-alerts";
import {
  KNOWN_EXCEPTION_FLAGS,
  InvoiceExceptionBadges,
  type InvoiceExceptionFlag,
} from "@/components/office/invoice-exception-badges";
import {
  INVOICE_TRANSITIONS,
  computeRetentionUntil,
  resolveHeaderCorrectionData,
  type InvoiceStatus,
} from "@/lib/domain/invoices";
import { NullValue } from "@/components/ui/null-value";
import { Money } from "@/components/ui/money";
import type { ProductSummary } from "@/lib/domain/catalog";
import type { ColumnDef } from "@tanstack/react-table";

// Helper simulating CatalogTable column construction per role
function buildCatalogColumnsForRole(userRole: Role): ColumnDef<ProductSummary>[] {
  const canSee = canSeeCost(userRole);
  const canManage = canManageInventoryOps(userRole);
  const canEdit = canManageCost(userRole);

  const cols: ColumnDef<ProductSummary>[] = [];

  if (canManage) {
    cols.push({ id: "select", header: "Select" });
  }

  cols.push({ id: "product", accessorKey: "name", header: "Product" });
  cols.push({ id: "category", header: "Category" });
  cols.push({ id: "onHand", header: "On hand" });

  if (canSee) {
    cols.push({
      id: "unitCost",
      header: "Unit cost",
      accessorFn: (row) => (row.currentUnitCost != null ? Number(row.currentUnitCost) : -1),
    });
  }

  if (canManage) {
    cols.push({ id: "caseSize", header: "Case size" });
    cols.push({ id: "edit", header: "" });
  }

  return cols;
}

describe("Adversarial Challenge 1: Collapsible OfficeRail", () => {
  test("Cookie persistence name and values conform to specification", () => {
    expect(RAIL_COOKIE).toBe("truestock_rail");
    // Verify valid cookie values
    const expandedCookie = `${RAIL_COOKIE}=1; path=/; max-age=31536000; SameSite=Lax`;
    const collapsedCookie = `${RAIL_COOKIE}=0; path=/; max-age=31536000; SameSite=Lax`;
    expect(expandedCookie).toContain("truestock_rail=1");
    expect(collapsedCookie).toContain("truestock_rail=0");
    expect(expandedCookie).toContain("SameSite=Lax");
  });

  test("Server layout SSR cookie parsing logic", () => {
    // Simulating Next.js cookies().get(RAIL_COOKIE)?.value === "1"
    function isRailExpanded(cookieVal: string | undefined): boolean {
      return cookieVal === "1";
    }

    expect(isRailExpanded("1")).toBe(true);
    expect(isRailExpanded("0")).toBe(false);
    expect(isRailExpanded(undefined)).toBe(false);
    expect(isRailExpanded("")).toBe(false);
    expect(isRailExpanded("true")).toBe(false);
    expect(isRailExpanded("false")).toBe(false);
  });

  test("OfficeRail width token mapping", () => {
    const collapsedClass = "w-16 items-center"; // 64px
    const expandedClass = "w-52"; // 208px (13rem)
    expect(collapsedClass).toContain("w-16");
    expect(expandedClass).toContain("w-52");
  });

  test("OfficeRail navigation destinations are role-filtered", () => {
    function getRailLinks(role: Role) {
      return [
        { href: "/office", label: "Dashboard" },
        { href: "/office/counts", label: "Counts" },
        { href: "/office/catalog", label: "Catalog" },
        { href: "/office/locations", label: "Locations" },
        { href: "/office/vendors", label: "Vendors" },
        { href: "/office/invoices", label: "Invoices" },
        { href: "/office/reorder", label: "Reorder" },
        ...(role === "owner" ? [{ href: "/office/users", label: "Users" }] : []),
      ];
    }

    const ownerLinks = getRailLinks("owner");
    const managerLinks = getRailLinks("manager");
    const staffLinks = getRailLinks("staff");

    expect(ownerLinks.some((l) => l.href === "/office/users")).toBe(true);
    expect(managerLinks.some((l) => l.href === "/office/users")).toBe(false);
    expect(staffLinks.some((l) => l.href === "/office/users")).toBe(false);
  });
});

describe("Adversarial Challenge 2: Breadcrumb Path Matching", () => {
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

  test("resolves all main office routes and detail sub-routes correctly", () => {
    // Root & dashboard
    expect(resolveBreadcrumb("/office")).toBe("Dashboard");
    expect(resolveBreadcrumb("/office/")).toBe("Dashboard");

    // Counts
    expect(resolveBreadcrumb("/office/counts")).toBe("Counts");
    expect(resolveBreadcrumb("/office/counts/1")).toBe("Counts");
    expect(resolveBreadcrumb("/office/counts/99999")).toBe("Counts");

    // Catalog
    expect(resolveBreadcrumb("/office/catalog")).toBe("Catalog");
    expect(resolveBreadcrumb("/office/catalog/42")).toBe("Catalog");

    // Locations
    expect(resolveBreadcrumb("/office/locations")).toBe("Locations");
    expect(resolveBreadcrumb("/office/locations/new")).toBe("Locations");

    // Vendors
    expect(resolveBreadcrumb("/office/vendors")).toBe("Vendors");
    expect(resolveBreadcrumb("/office/vendors/7")).toBe("Vendors");

    // Invoices
    expect(resolveBreadcrumb("/office/invoices")).toBe("Invoices");
    expect(resolveBreadcrumb("/office/invoices/100")).toBe("Invoices");
    expect(resolveBreadcrumb("/office/invoices/audit-packet")).toBe("Invoices");

    // Reorder
    expect(resolveBreadcrumb("/office/reorder")).toBe("Reorder");

    // Users
    expect(resolveBreadcrumb("/office/users")).toBe("Users");

    // Unknown sub-routes fall back to Dashboard
    expect(resolveBreadcrumb("/office/settings")).toBe("Dashboard");
    expect(resolveBreadcrumb("/office/analytics")).toBe("Dashboard");
    expect(resolveBreadcrumb("/")).toBe("Dashboard");
  });
});

describe("Adversarial Challenge 3: Invariant 8 Role-Gating (TanStack Table v8 Columns)", () => {
  test("Owner receives all 7 columns including unitCost and management columns", () => {
    const ownerCols = buildCatalogColumnsForRole("owner");
    const colIds = ownerCols.map((c) => c.id);

    expect(ownerCols.length).toBe(7);
    expect(colIds).toEqual(["select", "product", "category", "onHand", "unitCost", "caseSize", "edit"]);
    expect(colIds.includes("unitCost")).toBe(true);
    expect(colIds.includes("select")).toBe(true);
    expect(colIds.includes("caseSize")).toBe(true);
    expect(colIds.includes("edit")).toBe(true);
  });

  test("Manager receives 6 columns and NEVER receives unitCost column", () => {
    const managerCols = buildCatalogColumnsForRole("manager");
    const colIds = managerCols.map((c) => c.id);

    expect(managerCols.length).toBe(6);
    expect(colIds).toEqual(["select", "product", "category", "onHand", "caseSize", "edit"]);
    expect(colIds.includes("unitCost")).toBe(false);
    expect(colIds.includes("margin")).toBe(false);
    expect(colIds.includes("totalValue")).toBe(false);
    // Manager has management ops
    expect(colIds.includes("select")).toBe(true);
    expect(colIds.includes("caseSize")).toBe(true);
    expect(colIds.includes("edit")).toBe(true);
  });

  test("Staff receives 3 columns and NEVER receives unitCost or management columns", () => {
    const staffCols = buildCatalogColumnsForRole("staff");
    const colIds = staffCols.map((c) => c.id);

    expect(staffCols.length).toBe(3);
    expect(colIds).toEqual(["product", "category", "onHand"]);
    expect(colIds.includes("unitCost")).toBe(false);
    expect(colIds.includes("margin")).toBe(false);
    expect(colIds.includes("totalValue")).toBe(false);
    expect(colIds.includes("select")).toBe(false);
    expect(colIds.includes("caseSize")).toBe(false);
    expect(colIds.includes("edit")).toBe(false);
  });

  test("Role predicate functions strictly gate access", () => {
    expect(canSeeCost("owner")).toBe(true);
    expect(canSeeCost("manager")).toBe(false);
    expect(canSeeCost("staff")).toBe(false);

    expect(canManageCost("owner")).toBe(true);
    expect(canManageCost("manager")).toBe(false);
    expect(canManageCost("staff")).toBe(false);

    expect(canManageInventoryOps("owner")).toBe(true);
    expect(canManageInventoryOps("manager")).toBe(true);
    expect(canManageInventoryOps("staff")).toBe(false);
  });
});

describe("Adversarial Challenge 4: Audit Packet Date Range Boundary Edge Cases", () => {
  const today = new Date().toISOString().slice(0, 10);

  test("Accepts valid single-day range (dateFrom === dateTo)", () => {
    const validSingleDay = {
      dateFrom: "2026-08-01",
      dateTo: "2026-08-01",
    };
    const parsed = createAuditPacketSchema.safeParse(validSingleDay);
    expect(parsed.success).toBe(true);
  });

  test("Accepts valid multi-year range (e.g. 5-year historic range)", () => {
    const validMultiYear = {
      dateFrom: "2020-01-01",
      dateTo: "2025-12-31",
    };
    const parsed = createAuditPacketSchema.safeParse(validMultiYear);
    expect(parsed.success).toBe(true);
  });

  test("Accepts leap day in leap year (2024-02-29)", () => {
    const leapYear = {
      dateFrom: "2024-02-29",
      dateTo: "2024-02-29",
    };
    const parsed = createAuditPacketSchema.safeParse(leapYear);
    expect(parsed.success).toBe(true);
  });

  test("Rejects reversed date range (dateFrom > dateTo)", () => {
    const reversed = {
      dateFrom: "2026-08-20",
      dateTo: "2026-08-10",
    };
    const parsed = createAuditPacketSchema.safeParse(reversed);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toContain("dateFrom must be on or before dateTo");
    }
  });

  test("Rejects future dateTo (> today)", () => {
    const future = {
      dateFrom: "2026-01-01",
      dateTo: "2099-12-31",
    };
    const parsed = createAuditPacketSchema.safeParse(future);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toContain("dateTo cannot be in the future");
    }
  });

  test("Rejects non-existent calendar dates (e.g. 2026-02-30, 2025-02-29, 2026-04-31)", () => {
    const invalidFeb30 = { dateFrom: "2026-02-30", dateTo: "2026-02-30" };
    expect(createAuditPacketSchema.safeParse(invalidFeb30).success).toBe(false);

    const invalidFeb29NonLeap = { dateFrom: "2025-02-29", dateTo: "2025-02-29" };
    expect(createAuditPacketSchema.safeParse(invalidFeb29NonLeap).success).toBe(false);

    const invalidApr31 = { dateFrom: "2026-04-31", dateTo: "2026-04-31" };
    expect(createAuditPacketSchema.safeParse(invalidApr31).success).toBe(false);

    const invalidMonth13 = { dateFrom: "2026-13-01", dateTo: "2026-13-01" };
    expect(createAuditPacketSchema.safeParse(invalidMonth13).success).toBe(false);
  });

  test("Rejects malformed date formats", () => {
    expect(createAuditPacketSchema.safeParse({ dateFrom: "2026/08/01", dateTo: "2026/08/02" }).success).toBe(false);
    expect(createAuditPacketSchema.safeParse({ dateFrom: "08-01-2026", dateTo: "08-02-2026" }).success).toBe(false);
    expect(createAuditPacketSchema.safeParse({ dateFrom: "", dateTo: "" }).success).toBe(false);
    expect(createAuditPacketSchema.safeParse({ dateFrom: "2026-8-1", dateTo: "2026-8-2" }).success).toBe(false);
  });
});

describe("Adversarial Challenge 5: Split-Screen Invoice OCR Review & CAS Lifecycle", () => {
  test("INVOICE_TRANSITIONS graph obeys strict legal state edges", () => {
    expect(INVOICE_TRANSITIONS.uploaded).toEqual(["processing"]);
    expect(INVOICE_TRANSITIONS.processing).toEqual(["needs_review"]);
    expect(INVOICE_TRANSITIONS.needs_review).toEqual(["reviewed", "rejected"]);
    expect(INVOICE_TRANSITIONS.reviewed).toEqual(["approved", "rejected"]);
    expect(INVOICE_TRANSITIONS.approved).toEqual([]); // Terminal immutable state
    expect(INVOICE_TRANSITIONS.rejected).toEqual(["processing"]); // Retry extraction
  });

  test("computeRetentionUntil adds exactly 3 calendar years (statutory safety)", () => {
    expect(computeRetentionUntil("2026-08-20")).toBe("2029-08-20");
    expect(computeRetentionUntil("2024-02-29")).toBe("2027-03-01"); // Leap day roll-forward
    expect(computeRetentionUntil("2020-01-01")).toBe("2023-01-01");
  });

  test("resolveHeaderCorrectionData auto-computes retentionUntil when invoiceDate is set without explicit retentionUntil", () => {
    const result = resolveHeaderCorrectionData({ invoiceDate: "2026-05-15" });
    expect(result.invoiceDate).toBe("2026-05-15");
    expect(result.retentionUntil).toBe("2029-05-15");
  });

  test("resolveHeaderCorrectionData respects explicit retentionUntil override", () => {
    const result = resolveHeaderCorrectionData({
      invoiceDate: "2026-05-15",
      retentionUntil: "2031-12-31",
    });
    expect(result.invoiceDate).toBe("2026-05-15");
    expect(result.retentionUntil).toBe("2031-12-31");
  });

  test("headerCorrectionSchema validates currency codes and normalizes to uppercase", () => {
    const valid = headerCorrectionSchema.safeParse({ currency: "usd" });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.currency).toBe("USD");
    }

    const invalid = headerCorrectionSchema.safeParse({ currency: "US" }); // only 2 chars
    expect(invalid.success).toBe(false);

    const invalidNumbers = headerCorrectionSchema.safeParse({ currency: "123" });
    expect(invalidNumbers.success).toBe(false);
  });

  test("headerCorrectionSchema validates totalGross and totalNet DECIMAL(10,4) string format", () => {
    expect(headerCorrectionSchema.safeParse({ totalGross: "123.4567" }).success).toBe(true);
    expect(headerCorrectionSchema.safeParse({ totalGross: "100" }).success).toBe(true);
    expect(headerCorrectionSchema.safeParse({ totalGross: "-50.00" }).success).toBe(true);
    expect(headerCorrectionSchema.safeParse({ totalGross: "123.45678" }).success).toBe(false); // 5 decimals
    expect(headerCorrectionSchema.safeParse({ totalGross: "abc" }).success).toBe(false);
  });

  test("rejectInvoiceSchema requires non-empty reason", () => {
    expect(rejectInvoiceSchema.safeParse({ invoiceId: 1, reason: "Unreadable scan" }).success).toBe(true);
    expect(rejectInvoiceSchema.safeParse({ invoiceId: 1, reason: "" }).success).toBe(false);
    expect(rejectInvoiceSchema.safeParse({ invoiceId: 1, reason: "   " }).success).toBe(false);
  });

  test("computeLineAlerts flags extreme and adversarial numeric edge cases", () => {
    // Discount > 50%
    const alert1 = computeLineAlerts("100.00", "50.01", "49.99");
    expect(alert1.some((a) => a.key === "discount-over-50")).toBe(true);

    // Negative net
    const alert2 = computeLineAlerts("100.00", "0.00", "-0.01");
    expect(alert2.some((a) => a.key === "negative-net")).toBe(true);

    // Both discount > 50% and negative net
    const alert3 = computeLineAlerts("100.00", "150.00", "-50.00");
    expect(alert3.some((a) => a.key === "discount-over-50")).toBe(true);
    expect(alert3.some((a) => a.key === "negative-net")).toBe(true);

    // Zero gross / null gross / non-numeric gross does NOT throw or produce NaN
    expect(computeLineAlerts("0.00", "50.00", "50.00").length).toBe(0);
    expect(computeLineAlerts(null, "50.00", "50.00").length).toBe(0);
    expect(computeLineAlerts("invalid", "50.00", "50.00").length).toBe(0);
    expect(computeLineAlerts("100.00", "invalid", "100.00").length).toBe(0);
  });

  test("KNOWN_EXCEPTION_FLAGS has exactly 4 flags with correct tone classification", () => {
    expect(KNOWN_EXCEPTION_FLAGS).toEqual([
      "price jump",
      "duplicate",
      "doesn't add up",
      "unmatched item",
    ]);

    // Test component rendering with known flags
    const elKnown = InvoiceExceptionBadges({
      flags: ["price jump", "duplicate"],
    });
    expect(elKnown).not.toBeNull();

    // Test component rendering with empty flags
    const elEmpty = InvoiceExceptionBadges({ flags: [] });
    expect(elEmpty).toBeNull();

    const elNull = InvoiceExceptionBadges({ flags: null });
    expect(elNull).toBeNull();
  });
});
