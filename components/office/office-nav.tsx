"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { Role } from "@/lib/authz";

/**
 * Back-office navigation. Built per role rather than rendered-then-filtered,
 * matching the design system's binding rule — there is no client-side role
 * state and nothing for a user to toggle.
 *
 * Today owner and manager see the same set: every screen behind these links
 * gates its own cost data server-side (a manager gets counts and reorder
 * without dollar figures), so hiding the link would remove a screen they are
 * entitled to use rather than protect anything.
 */
export function OfficeNav({ role }: { role: Role }) {
  const pathname = usePathname();

  const links = [
    { href: "/office", label: "Dashboard", exact: true },
    { href: "/office/counts", label: "Counts" },
    { href: "/office/catalog", label: "Catalog" },
    { href: "/office/reorder", label: "Reorder" },
  ];

  return (
    <nav className="flex items-center gap-1" aria-label="Back office">
      {links.map((link) => {
        const active = link.exact ? pathname === link.href : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-tap-min items-center rounded-md px-3 text-label uppercase",
              active ? "bg-secondary text-foreground" : "text-muted-foreground",
            )}
          >
            {link.label}
          </Link>
        );
      })}
      {/* The counting app is a link, not a tab — it is a different surface,
          on a different device, in a different theme. */}
      <Link
        href="/count"
        className="ml-2 flex min-h-tap-min items-center rounded-md border border-input px-3 text-label uppercase text-foreground"
      >
        Count
      </Link>
      <span className="sr-only">Signed in as {role}</span>
    </nav>
  );
}
