"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClipboardList, Search, BarChart3, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Role } from "@/lib/authz";
import { hideTabBar, isTabBarHidden, subscribeTabBarHidden } from "@/lib/tab-bar-visibility";

/**
 * Hide the tab bar for as long as `hidden` is true and this component is
 * mounted. Used by the entry and enroll screens, where a tab tap would bypass
 * the discard guard (lib/tab-bar-visibility.ts). Layout effect, so the bar is
 * gone before the entry screen paints rather than flashing for a frame.
 */
export function useHideTabBar(hidden: boolean): void {
  useLayoutEffect(() => {
    if (!hidden) return;
    return hideTabBar();
  }, [hidden]);
}

/**
 * Mobile Bottom Tab Bar (docs/design-system.md §9)
 *
 * Active is `text-foreground` + bold weight + solid icon. Inactive is `text-muted-foreground`.
 * Never `--accent` for active tab color (preserves brand vs status invariant).
 *
 * Role-gating DOM omission: staff role omits Reports tab entirely from rendered DOM.
 */
export function CountTabBar({ role }: { role: Role }) {
  const pathname = usePathname();
  // Server snapshot is `false`: the leg never starts in entry/enroll, so the
  // server-rendered bar and the first client render agree.
  const hidden = useSyncExternalStore(subscribeTabBarHidden, isTabBarHidden, () => false);
  if (hidden) return null;

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
      className="sticky bottom-0 z-30 border-t border-border/70 bg-card/85 backdrop-blur-xl shadow-lg"
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
              "flex min-h-tap-min flex-col items-center justify-center gap-1 pb-safe-bottom transition-colors",
              active ? "text-foreground font-semibold" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-6" strokeWidth={active ? 2.5 : 1.75} aria-hidden="true" />
            <span className="text-label uppercase tracking-wider">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
