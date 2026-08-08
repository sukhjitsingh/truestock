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
 * Most screens behind these links gate their own cost data server-side (a
 * manager gets counts and reorder without dollar figures), so those links are
 * shown to owner and manager alike — hiding them would remove a screen they are
 * entitled to use rather than protect anything. The exception is Users, which
 * is an owner-only surface (spec §4): the page itself calls `requireRole("owner")`,
 * so a manager reaching it gets 403 — the link is omitted for managers so the
 * nav never offers a door that only opens for someone else.
 */
export function OfficeNav({ role }: { role: Role }) {
  const pathname = usePathname();

  const links = [
    { href: "/office", label: "Dashboard", exact: true },
    { href: "/office/counts", label: "Counts" },
    { href: "/office/catalog", label: "Catalog" },
    { href: "/office/reorder", label: "Reorder" },
    ...(role === "owner" ? [{ href: "/office/users", label: "Users" }] : []),
    { href: "/office/account", label: "Account" },
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
    </nav>
  );
}
