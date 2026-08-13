"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Role } from "@/lib/authz";

/**
 * The back-office icon rail — `prototypes/office-catalog.html`'s `.rail`,
 * which is the layout every office screen was specified against
 * (`ui-spec-web.md` §2, "the Part B shell"). It replaces the horizontal
 * `OfficeNav` that shipped in the Phase 2 layout; navigation belongs on the
 * left on this surface, and the top bar carries breadcrumb + account only.
 *
 * ## Why the expand toggle is real rather than decorative
 *
 * The prototype's rail is icon-only at 64px with a chevron that does nothing.
 * Shipping that chevron inert is exactly what `ui-audit.md` P0.7 forbids — a
 * focusable control that announces as interactive and isn't. But dropping it
 * leaves seven destinations behind seven unlabelled glyphs, which is a
 * discoverability problem the four-item prototype never had to answer.
 *
 * So it toggles. Collapsed is the prototype's 64px icon rail; expanded is the
 * same rail at 13rem with the labels shown. That satisfies P0.7 by making the
 * control do the thing its icon promises, and it means the icon-only default
 * is a preference rather than a guessing game.
 *
 * The state is component state, not persisted. It survives every client-side
 * navigation inside the office (this component sits in the layout and is not
 * remounted), and resets on a full page load. Persisting it in localStorage
 * would mean reading storage after mount and re-rendering, i.e. a visible
 * width flip on every cold load — worse than the thing it fixes.
 *
 * Roles: built per role rather than rendered-then-filtered, same rule as the
 * nav it replaces. Owner and manager see the same destinations; each screen
 * gates its own cost data server-side, so hiding a link would remove a screen
 * a manager is entitled to use rather than protect anything.
 */

type RailIcon = (props: { className?: string }) => React.ReactElement;

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  "aria-hidden": true,
} as const;

const DashboardIcon: RailIcon = ({ className }) => (
  <svg {...iconProps} className={className}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </svg>
);

const CountsIcon: RailIcon = ({ className }) => (
  <svg {...iconProps} className={className}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 8h8M8 12h8M8 16h5" strokeLinecap="round" />
  </svg>
);

const CatalogIcon: RailIcon = ({ className }) => (
  <svg {...iconProps} className={className}>
    <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
  </svg>
);

const LocationsIcon: RailIcon = ({ className }) => (
  <svg {...iconProps} className={className}>
    <path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z" strokeLinejoin="round" />
    <circle cx="12" cy="10" r="2.5" />
  </svg>
);

const VendorsIcon: RailIcon = ({ className }) => (
  <svg {...iconProps} className={className}>
    <path d="M3 21V9l9-6 9 6v12" strokeLinejoin="round" />
    <path d="M9 21v-6h6v6" strokeLinejoin="round" />
  </svg>
);

const ReorderIcon: RailIcon = ({ className }) => (
  <svg {...iconProps} className={className}>
    <path
      d="M3 3h2l2.4 12.4a2 2 0 0 0 2 1.6h7.2a2 2 0 0 0 2-1.6L20 8H6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="9" cy="20" r="1.4" />
    <circle cx="17" cy="20" r="1.4" />
  </svg>
);

const UsersIcon: RailIcon = ({ className }) => (
  <svg {...iconProps} className={className}>
    <circle cx="9" cy="8" r="3.25" />
    <path d="M3.5 20a5.5 5.5 0 0 1 11 0" strokeLinecap="round" />
    <path d="M16 5.6a3.25 3.25 0 0 1 0 6.3M17.5 20a5.5 5.5 0 0 0-2.2-4.4" strokeLinecap="round" />
  </svg>
);

const CountAppIcon: RailIcon = ({ className }) => (
  <svg {...iconProps} className={className}>
    <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
    <path d="M10.5 18.5h3" strokeLinecap="round" />
  </svg>
);

const ChevronIcon: RailIcon = ({ className }) => (
  <svg {...iconProps} strokeWidth={2} className={className}>
    <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function OfficeRail({ role }: { role: Role }) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(false);

  const links: { href: string; label: string; icon: RailIcon; exact?: boolean }[] = [
    { href: "/office", label: "Dashboard", icon: DashboardIcon, exact: true },
    { href: "/office/counts", label: "Counts", icon: CountsIcon },
    { href: "/office/catalog", label: "Catalog", icon: CatalogIcon },
    { href: "/office/locations", label: "Locations", icon: LocationsIcon },
    { href: "/office/vendors", label: "Vendors", icon: VendorsIcon },
    { href: "/office/reorder", label: "Reorder", icon: ReorderIcon },
    ...(role === "owner" ? [{ href: "/office/users", label: "Users", icon: UsersIcon }] : []),
  ];

  // Shared between the nav links and the Count link below so the two cannot
  // drift apart visually — they are the same 44px target in the same rail.
  //
  // `border border-transparent` on every item, not just the active one: the
  // active state adds a hairline, and without a transparent border reserving
  // that pixel on the others, the active item's icon sits 1px in from the rest
  // of the column. One item out of alignment in a vertical strip of icons is
  // visible even when you can't name what changed.
  const itemClass = cn(
    "flex min-h-tap-min items-center rounded-md border border-transparent text-muted-foreground",
    expanded ? "gap-3 px-3" : "w-tap-min justify-center",
  );

  return (
    <nav
      aria-label="Back office"
      className={cn(
        "flex shrink-0 flex-col items-stretch gap-1 border-r border-border bg-card px-2.5 py-3",
        expanded ? "w-52" : "w-16 items-center",
      )}
    >
      {links.map((link) => {
        const active = link.exact ? pathname === link.href : pathname.startsWith(link.href);
        const Icon = link.icon;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            // The label is the accessible name when collapsed and the visible
            // text when expanded — never both, or a screen reader reads it twice.
            aria-label={expanded ? undefined : link.label}
            title={expanded ? undefined : link.label}
            className={cn(itemClass, active && "border-border bg-background text-accent")}
          >
            <Icon className="size-5 shrink-0" />
            {expanded ? (
              <span className="truncate text-label uppercase">{link.label}</span>
            ) : null}
          </Link>
        );
      })}

      <div className="flex-1" />

      {/* The counting app is a link out, not a section — a different surface,
          on a different device, in a different theme. A real separator element
          rather than a top border on the link itself, so the rule spans the
          rail rather than only the 44px item, and so it does not fight the
          transparent border every item reserves. */}
      <hr className="my-1 w-full border-t border-border" />
      <Link
        href="/count"
        aria-label={expanded ? undefined : "Counting app"}
        title={expanded ? undefined : "Counting app"}
        className={cn(itemClass, "text-foreground")}
      >
        <CountAppIcon className="size-5 shrink-0" />
        {expanded ? <span className="truncate text-label uppercase">Count</span> : null}
      </Link>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
        className={cn(itemClass, "cursor-pointer")}
      >
        <ChevronIcon className={cn("size-4 shrink-0 transition-transform", expanded && "rotate-180")} />
        {expanded ? <span className="truncate text-label uppercase">Collapse</span> : null}
      </button>
    </nav>
  );
}
