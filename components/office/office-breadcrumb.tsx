"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The top bar's `Truestock / <section>` crumb —
 * `prototypes/office-catalog.html`'s `.topbar-crumbs`.
 *
 * Section-level only, on purpose. It names the rail destination you are
 * inside, so `/office/catalog/42` reads "Truestock / Catalog", not
 * ".../Catalog/42": the record's own identity belongs to the page, and
 * `PageHeader` already takes a `breadcrumb` prop that detail screens use to
 * point back at their list. Two competing breadcrumbs on one screen is worse
 * than one that stops at the section.
 *
 * The section list mirrors `OfficeRail`'s. It is deliberately not shared with
 * it: the rail is role-filtered and this is not, because a crumb describes the
 * URL you are actually on — a user who somehow reaches a page gets an honest
 * label for it rather than a blank.
 */

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

const SECTIONS: { prefix: string; label: string }[] = [
  { prefix: "/office/counts", label: "Counts" },
  { prefix: "/office/catalog", label: "Catalog" },
  { prefix: "/office/locations", label: "Locations" },
  { prefix: "/office/invoices", label: "Invoices" },
  { prefix: "/office/vendors", label: "Vendors" },
  { prefix: "/office/reorder", label: "Reorder" },
  { prefix: "/office/users", label: "Users" },
];

function OfficeBreadcrumbContent() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const section = SECTIONS.find((s) => pathname === s.prefix || pathname.startsWith(s.prefix + "/"));
  
  // Check if we are on a detail, subpage, or specific view state
  let subLabel: string | null = null;
  if (section) {
    if (pathname !== section.prefix) {
      const remainder = pathname.slice(section.prefix.length).replace(/^\//, "");
      if (remainder) {
        if (section.label === "Catalog") {
          subLabel = remainder === "new" ? "New Product" : "Edit Product";
        } else if (section.label === "Invoices") {
          subLabel = remainder === "audit-packet" ? "Audit Packet" : `Invoice #${remainder}`;
        } else if (section.label === "Counts") {
          subLabel = `Count #${remainder}`;
        } else if (section.label === "Locations") {
          subLabel = remainder === "new" ? "New Location" : `Location #${remainder}`;
        } else if (section.label === "Vendors") {
          subLabel = remainder === "new" ? "New Vendor" : `Vendor #${remainder}`;
        } else if (section.label === "Users") {
          subLabel = remainder === "new" ? "New User" : `User #${remainder}`;
        } else if (section.label === "Reorder") {
          subLabel = remainder === "print" ? "Print PO" : `Order #${remainder}`;
        } else {
          subLabel = remainder.charAt(0).toUpperCase() + remainder.slice(1);
        }
      }
    } else {
      // Check query params for section sub-views
      const view = searchParams?.get("view");
      const edit = searchParams?.get("edit");
      if (view === "attention") {
        subLabel = "Needs Attention";
      } else if (edit) {
        if (section.label === "Locations") subLabel = "Edit Location";
        else if (section.label === "Vendors") subLabel = "Edit Vendor";
      }
    }
  }

  return (
    <nav aria-label="Breadcrumb" className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/80 bg-background/60 px-3 py-1.5 backdrop-blur-md shadow-xs transition-all">
      <Link
        href="/office"
        className="flex items-center gap-1.5 text-row-subtitle font-semibold text-foreground/80 transition-colors hover:text-accent hover:underline decoration-accent/40 underline-offset-4"
      >
        <span className="flex size-5 items-center justify-center rounded-full bg-accent/15 text-[10px] font-bold text-accent">T</span>
        <span>Truestock</span>
      </Link>

      {section ? (
        <>
          <span aria-hidden className="text-muted-foreground/60 select-none text-caption">
            /
          </span>
          {subLabel ? (
            <Link
              href={section.prefix}
              className="text-row-subtitle font-semibold text-foreground/80 transition-colors hover:text-accent hover:underline decoration-accent/40 underline-offset-4"
            >
              {section.label}
            </Link>
          ) : (
            <span
              className="truncate font-semibold text-foreground text-row-subtitle px-1.5 py-0.5 rounded-md bg-secondary/70"
              aria-current="page"
            >
              {section.label}
            </span>
          )}
        </>
      ) : (
        <>
          <span aria-hidden className="text-muted-foreground/60 select-none text-caption">
            /
          </span>
          <span
            className="truncate font-semibold text-foreground text-row-subtitle px-1.5 py-0.5 rounded-md bg-secondary/70"
            aria-current="page"
          >
            Dashboard
          </span>
        </>
      )}

      {subLabel ? (
        <>
          <span aria-hidden className="text-muted-foreground/60 select-none text-caption">
            /
          </span>
          <span
            className="truncate font-semibold text-foreground text-row-subtitle px-1.5 py-0.5 rounded-md bg-secondary/70"
            aria-current="page"
          >
            {subLabel}
          </span>
        </>
      ) : null}
    </nav>
  );
}

export function OfficeBreadcrumb() {
  return (
    <Suspense
      fallback={
        <nav aria-label="Breadcrumb" className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/80 bg-background/60 px-3 py-1.5 backdrop-blur-md shadow-xs">
          <span className="flex items-center gap-1.5 text-row-subtitle font-semibold text-foreground/80">
            <span className="flex size-5 items-center justify-center rounded-full bg-accent/15 text-[10px] font-bold text-accent">T</span>
            <span>Truestock</span>
          </span>
        </nav>
      }
    >
      <OfficeBreadcrumbContent />
    </Suspense>
  );
}
