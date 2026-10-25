/**
 * Unit tests for Milestone 2: Design tokens, Breadcrumb, and Standardized Office Tables.
 * (components/office/office-breadcrumb.tsx, components/ui/table.tsx,
 *  components/office/locations-table.tsx, components/office/vendors-list.tsx,
 *  components/office/users-list.tsx)
 */
import { describe, test, expect } from "bun:test";
import {
  TableContainer,
  Table,
  TableCaption,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { StatusPill } from "@/components/ui/status-pill";
import { NullValue } from "@/components/ui/null-value";

describe("Office Breadcrumb Section Matching", () => {
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

  test("matches /office/invoices to Invoices", () => {
    expect(resolveBreadcrumb("/office/invoices")).toBe("Invoices");
    expect(resolveBreadcrumb("/office/invoices/123")).toBe("Invoices");
    expect(resolveBreadcrumb("/office/invoices/audit-packet")).toBe("Invoices");
  });

  test("matches all other standard office sections", () => {
    expect(resolveBreadcrumb("/office/counts")).toBe("Counts");
    expect(resolveBreadcrumb("/office/catalog")).toBe("Catalog");
    expect(resolveBreadcrumb("/office/locations")).toBe("Locations");
    expect(resolveBreadcrumb("/office/vendors")).toBe("Vendors");
    expect(resolveBreadcrumb("/office/reorder")).toBe("Reorder");
    expect(resolveBreadcrumb("/office/users")).toBe("Users");
    expect(resolveBreadcrumb("/office")).toBe("Dashboard");
    expect(resolveBreadcrumb("/office/unknown")).toBe("Dashboard");
  });
});

describe("Table Primitives", () => {
  test("TableContainer renders overflow-x-auto wrapper", () => {
    const el = TableContainer({ children: "content" });
    expect(el.props.className).toContain("overflow-x-auto");
  });

  test("Table renders table with min-w-max border-collapse", () => {
    const el = Table({ children: "content" });
    expect(el.props.className).toContain("border-collapse");
  });

  test("TableCaption renders sr-only accessible name", () => {
    const el = TableCaption({ children: "Locations, 5 active" });
    expect(el.props.className).toContain("sr-only");
    expect(el.props.children).toBe("Locations, 5 active");
  });

  test("TableHead carries scope='col' unconditionally", () => {
    const el = TableHead({ children: "Header" });
    expect(el.props.scope).toBe("col");
  });

  test("TableHead numeric applies .num class", () => {
    const el = TableHead({ children: "Sort Order", numeric: true });
    expect(el.props.className).toContain("num");
  });

  test("TableRow interactive applies hover:bg-muted and 57px row height", () => {
    const el = TableRow({ children: "row", interactive: true });
    expect(el.props.className).toContain("h-row-office");
    expect(el.props.className).toContain("min-h-row-office");
    expect(el.props.className).toContain("hover:bg-muted");
  });

  test("TableRow non-interactive omits hover:bg-muted", () => {
    const el = TableRow({ children: "row", interactive: false });
    expect(el.props.className).not.toContain("hover:bg-muted");
  });

  test("TableCell numeric applies .num class", () => {
    const el = TableCell({ children: "123", numeric: true });
    expect(el.props.className).toContain("num");
  });
});

describe("Semantic Status Badges & NullValue Integration", () => {
  test("StatusPill supports success, warning, negative, and neutral tones", () => {
    const successPill = StatusPill({ tone: "success", children: "Active" });
    expect(successPill.props.className).toContain("bg-success-bg");
    expect(successPill.props.className).toContain("text-success");

    const warningPill = StatusPill({ tone: "warning", children: "Pending" });
    expect(warningPill.props.className).toContain("bg-warning-bg");
    expect(warningPill.props.className).toContain("text-warning");

    const negativePill = StatusPill({ tone: "negative", children: "Retired" });
    expect(negativePill.props.className).toContain("bg-negative-bg");
    expect(negativePill.props.className).toContain("text-negative");

    const neutralPill = StatusPill({ tone: "neutral", children: "Draft" });
    expect(neutralPill.props.className).toContain("bg-muted");
    expect(neutralPill.props.className).toContain("text-muted-foreground");
  });

  test("NullValue not-entered provides non-empty text", () => {
    const el = NullValue({ reason: "not-entered" })!;
    expect(el.props.children).toBe("Not entered");
  });
});
