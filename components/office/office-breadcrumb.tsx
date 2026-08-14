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

const SECTIONS: { prefix: string; label: string }[] = [
  { prefix: "/office/counts", label: "Counts" },
  { prefix: "/office/catalog", label: "Catalog" },
  { prefix: "/office/locations", label: "Locations" },
  { prefix: "/office/vendors", label: "Vendors" },
  { prefix: "/office/reorder", label: "Reorder" },
  { prefix: "/office/users", label: "Users" },
];

export function OfficeBreadcrumb() {
  const pathname = usePathname();
  const section = SECTIONS.find((s) => pathname.startsWith(s.prefix));
  const label = section ? section.label : "Dashboard";

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-row-subtitle">
      <Link href="/office" className="shrink-0 font-semibold text-foreground">
        Truestock
      </Link>
      <span aria-hidden className="text-muted-foreground">
        /
      </span>
      <span className="truncate text-muted-foreground" aria-current="page">
        {label}
      </span>
    </nav>
  );
}
