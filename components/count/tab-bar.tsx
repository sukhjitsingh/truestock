"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClipboardList, Search, BarChart3, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Role } from "@/lib/authz";

/**
 * Bottom tab bar — docs/design-system.md §9.
 *
 * Active is `text-foreground` + a filled icon; inactive is
 * `text-muted-foreground`. Never `--accent` for the active tab: that would
 * blur the brand/status rule at the app's single most-repeated touchpoint.
 *
 * The tab set is built PER ROLE rather than rendered-then-filtered — staff is
 * count-only (spec §4) and simply has no Reports tab in their DOM, matching
 * the binding rule at the end of the design system. `role` comes from the
 * server layout, not from client state.
 */
export function CountTabBar({ role }: { role: Role }) {
  const pathname = usePathname();

  const tabs = [
    { href: "/count", label: "Count", icon: ClipboardList },
    { href: "/count/catalog", label: "Catalog", icon: Search },
    ...(role === "staff"
      ? []
      : [{ href: "/office", label: "Reports", icon: BarChart3 }]),
    { href: "/count/account", label: "Account", icon: UserRound },
  ];

  return (
    <nav
      className="sticky bottom-0 z-30 border-t border-border bg-background"
      aria-label="Primary"
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`, display: "grid" }}
    >
      {tabs.map((tab) => {
        const active = tab.href === "/count" ? pathname === "/count" : pathname.startsWith(tab.href);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-tap-min flex-col items-center justify-center gap-1 pb-[env(safe-area-inset-bottom)]",
              active ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <Icon className="size-6" strokeWidth={active ? 2.5 : 1.75} aria-hidden="true" />
            <span className={cn("text-label", !active && "font-normal")}>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
