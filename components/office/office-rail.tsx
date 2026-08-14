"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { RAIL_COOKIE } from "@/lib/ui-cookies";
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
 * ## Why the state sticks, and why it is a cookie
 *
 * The choice sticks across full page loads, not just client-side navigation —
 * a sidebar that silently re-collapses every time you hit refresh is a
 * setting the user has to re-make forever.
 *
 * It is stored in a cookie rather than `localStorage` because the layout is a
 * SERVER component: it reads the cookie during render and hands the answer
 * down as `defaultExpanded`, so the first painted frame is already the right
 * width. `localStorage` cannot do that — it is only readable after mount, so
 * every cold load would paint 64px and then jump to 208px, which is a visible
 * flash on the single most persistent element on the screen.
 *
 * The name itself lives in `lib/ui-cookies.ts`, not here — a constant exported
 * from a `"use client"` module reaches a server component as a client-reference
 * proxy rather than the string, which makes `cookies().get(...)` silently miss.
 * See that file; it is a trap worth reading once.
 *
 * `SameSite=Lax`, no `Secure` flag hardcoded, one year, path `/`. It carries
 * a single boolean about a personal layout preference — no identifier, nothing
 * derived from the session — so it is a functional cookie, not one that needs
 * consent, and it must stay that way.
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

export function OfficeRail({
  role,
  defaultExpanded = false,
}: {
  role: Role;
  /** Read from the `RAIL_COOKIE` cookie server-side, so the rail renders at
   *  its remembered width on the very first frame rather than flipping. */
  defaultExpanded?: boolean;
}) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(defaultExpanded);

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    // One year. Written client-side rather than through a server action
    // because nothing on the server needs to react to it mid-session — the
    // cookie exists only so the NEXT document request starts at this width.
    document.cookie = `${RAIL_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; SameSite=Lax`;
  }

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
      {/* The toggle leads the rail; it must NOT sit at the bottom.
          It shipped in the bottom-left corner and was unclickable there — the
          handler fired fine when the event was dispatched at the node, and a
          real click never reached it, because the bottom-left corner of the
          viewport is the busiest real estate in a browser window. Next's
          dev-tools indicator (`<nextjs-portal>`) parks there in every dev
          session and swallowed the click outright, and Chrome draws its
          link-hover status bubble in the same spot, so in production merely
          hovering any rail link covers the control. The rail's own state was
          never the bug, which is why it looked like the cookie was broken.
          Keep it top-anchored. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
        className={cn(itemClass, "cursor-pointer")}
      >
        <ChevronIcon className={cn("size-4 shrink-0 transition-transform", expanded && "rotate-180")} />
        {expanded ? <span className="truncate text-label uppercase">Collapse</span> : null}
      </button>
      <hr className="my-1 w-full border-t border-border" />

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

      {/* The counting app is a link out, not a section — a different surface,
          on a different device, in a different theme. A real separator element
          rather than a top border on the link itself, so the rule spans the
          rail rather than only the 44px item, and so it does not fight the
          transparent border every item reserves.

          There is deliberately no `flex-1` spacer above this. Pinning the last
          item to the bottom of the rail puts an interactive control in the
          bottom-left corner, which is the exact position that made the toggle
          unclickable (see the comment on it). Nothing in this rail should end
          up there again. */}
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
    </nav>
  );
}
