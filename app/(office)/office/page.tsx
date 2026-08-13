import Link from "next/link";
import { requireOfficeUser } from "@/lib/current-user";
import { getActiveCountAction } from "@/app/actions/counts";
import { lastClosedCountAction, reorderListAction } from "@/app/actions/reports";
import { catalogHealthAction } from "@/app/actions/catalog";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { StatusPill, countStatusTone, countStatusLabel } from "@/components/ui/status-pill";
import { formatDate } from "@/lib/utils";
import { isCountWritable } from "@/lib/count-status";

export const metadata = { title: "Dashboard · Truestock" };

/**
 * The back-office landing screen. `/office` used to render the counts table
 * directly; that table now lives at `/office/counts` (components/office/
 * office-nav.tsx was updated alongside this move) and this route answers a
 * different question: "what needs my attention right now."
 *
 * Every read here is an existing server action — no query runs directly
 * against the database from this page (CLAUDE.md invariant 9 lives entirely
 * in lib/domain/*, not here). Role gating for cost/value figures is likewise
 * already decided server-side by those actions (invariant 8) — this page
 * never has an ungated dollar figure to hide, only a present-or-absent one to
 * render or not (design-system.md §8).
 *
 * Slice 5 (#14) replaced THREE capped/50-row reads that used to live here —
 * `searchProductsAction({ limit: 100 })`, `listCountsAction({ limit: 50 })`,
 * and `countSummaryAction` derived from that list's first closed row — with
 * two dedicated, uncapped aggregate reads: `catalogHealthAction()` and
 * `lastClosedCountAction()`. That is the actual fix for #14: the old
 * "Catalog health" tile read `products.length` off a 100-row-capped array,
 * so it silently read 100 with 101 rows in the catalog. Raising the cap
 * would only postpone the same bug at the next catalog size
 * (02-architecture.md Decision 10) — the fix is a `COUNT(*)` with no cap at
 * all. Nothing on this page counts a capped array's `.length` any more.
 *
 * Tiles are built PER ROLE (design-system.md's binding "no role switcher"
 * rule), not rendered-then-hidden: the "Unpriced products" tile is gated on
 * `user.role === "owner"` in this file, not on `catalogHealth.unpricedCount`
 * happening to be zero or null — `getCatalogHealth` never even runs that
 * query for a non-owner caller (invariant 8), so checking data presence
 * alone would still be correct today but would silently stop being a role
 * gate if that invariant ever moved.
 */
export default async function OfficeDashboardPage() {
  const user = await requireOfficeUser();

  const [activeResult, catalogHealthResult, lastClosedResult, reorderResult] = await Promise.all([
    getActiveCountAction(),
    catalogHealthAction(),
    lastClosedCountAction(),
    reorderListAction(),
  ]);

  const active = activeResult.ok ? activeResult.data : null;
  const catalogHealth = catalogHealthResult.ok ? catalogHealthResult.data : null;
  const lastClosed = lastClosedResult.ok ? lastClosedResult.data : null;
  const reorder = reorderResult.ok ? reorderResult.data : { asOfCountId: null, items: [] };

  return (
    <div>
      <h1 className="text-header-title">Dashboard</h1>
      <p className="mt-1 text-row-subtitle text-muted-foreground">
        Welcome back, {user.name}.
      </p>

      {/* The single most useful thing on this screen: rejoin whatever count
          is already in flight, or start one. */}
      <section className="mt-section-gap">
        {active ? (
          <Link href="/count" className="block">
            <Card className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-label uppercase text-muted-foreground">Count in progress</p>
                <h2 className="mt-1 text-row-title text-card-foreground">Count #{active.id}</h2>
                <p className="text-row-subtitle text-muted-foreground">
                  {active.type.replace(/_/g, " ")} &middot; started {formatDate(active.startedAt)}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <StatusPill tone={countStatusTone(active.status)}>
                  {countStatusLabel(active.status)}
                </StatusPill>
                {/* "Resume" on a submitted count is a promise the write path
                    no longer keeps — it is waiting to be reviewed and closed,
                    not to be counted into. */}
                <span className="flex min-h-tap-min items-center rounded-md bg-primary px-4 text-label uppercase text-primary-foreground">
                  {isCountWritable(active.status) ? "Resume" : "Review"}
                </span>
              </div>
            </Card>
          </Link>
        ) : (
          <Card className="flex items-center justify-between gap-4">
            <div>
              <p className="text-label uppercase text-muted-foreground">Count in progress</p>
              <p className="mt-1 text-row-subtitle text-muted-foreground">
                Nothing open right now.
              </p>
            </div>
            <Link
              href="/count"
              className="flex min-h-tap-min shrink-0 items-center rounded-md bg-primary px-4 text-label uppercase text-primary-foreground"
            >
              Start a count
            </Link>
          </Card>
        )}
      </section>

      <div className="mt-section-gap grid gap-card-gap sm:grid-cols-2 lg:grid-cols-3">
        {/* Last closed count — `getLastClosedCount` (lib/domain/reports.ts)
            is a direct ORDER BY closed_at DESC LIMIT 1 query, not a
            client-side filter/sort over a 50-row list. It carries no
            totalUnits or vs-previous delta (those came from the now-removed
            countSummaryAction) — this tile shows only what a single-row
            lookup can answer: which count, when, who, and its value. */}
        <Card>
          <p className="text-label uppercase text-muted-foreground">Last closed count</p>
          {!lastClosed ? (
            <p className="mt-2 text-row-subtitle text-muted-foreground">
              No count has been closed yet.
            </p>
          ) : (
            <>
              <p className="mt-2 text-numeral-md text-card-foreground">
                Count #{lastClosed.id}
              </p>
              <p className="text-caption text-muted-foreground">
                {lastClosed.type.replace(/_/g, " ")} &middot; closed {formatDate(lastClosed.closedAt)}
                {lastClosed.closedByName ? <> by {lastClosed.closedByName}</> : null}
              </p>
              {/* Owner only — lastClosed.totalValue arrives undefined for a
                  manager (invariant 8), and Money renders nothing for
                  undefined rather than $0.00 (design-system.md §8). */}
              <Money
                value={lastClosed.totalValue != null ? Number(lastClosed.totalValue) : undefined}
                className="mt-1 text-numeral-sm text-muted-foreground"
              />
              <Link
                href={`/office/counts/${lastClosed.id}`}
                className="mt-3 inline-block text-caption text-foreground underline"
              >
                View summary
              </Link>
            </>
          )}
        </Card>

        {/* Reorder pressure — no cost data involved at all (par levels and
            quantities only), so both roles see the same figure. Already
            correct (Decision 11): `reorderList` queries unlimited, so it
            never had the #14 bug and is untouched by this slice. */}
        <Card>
          <p className="text-label uppercase text-muted-foreground">Reorder pressure</p>
          {reorder.asOfCountId == null ? (
            <p className="mt-2 text-row-subtitle text-muted-foreground">
              No closed count yet — nothing to compare against par.
            </p>
          ) : reorder.productsWithPar === 0 ? (
            // "0 products at or below par" is a reassuring sentence, and with
            // no par levels set it is not an answer at all — the figure is
            // structurally zero. Say which one this is.
            <p className="mt-2 text-row-subtitle text-muted-foreground">
              No par levels set yet, so there is nothing to compare on-hand against.
            </p>
          ) : (
            <>
              <p className="mt-2 text-numeral-md text-card-foreground">
                {reorder.items.length} {reorder.items.length === 1 ? "product" : "products"}
              </p>
              <p className="text-caption text-muted-foreground">at or below par</p>
              <Link href="/office/reorder" className="mt-3 inline-block text-caption text-foreground underline">
                View reorder list
              </Link>
            </>
          )}
        </Card>

        {/* Catalog health — the documented #1 killer of inventory systems is
            catalog decay, so this stays on the landing screen rather than
            only living inside the catalog page itself. `activeCount` is a
            dedicated, uncapped `COUNT(*)` (lib/domain/catalog.ts's
            `getCatalogHealth`) — this is the exact tile #14 named: it used to
            read `products.length` off a 100-row-capped search and silently
            undercounted a bigger catalog. There is no "needs attention"
            figure here (Amendment 1, 2026-08-12) — the catalog table's own
            attention view still derives that per-product from
            `incompleteReasons` on a real row read. */}
        <Card>
          <p className="text-label uppercase text-muted-foreground">Catalog health</p>
          <p className="mt-2 text-numeral-md text-card-foreground">
            {catalogHealth?.activeCount ?? 0} active products
          </p>
          <Link
            href="/office/catalog?view=attention"
            className="mt-3 inline-block text-caption text-foreground underline"
          >
            Review catalog
          </Link>
        </Card>

        {/* Unpriced products — owner only (CLAUDE.md invariant 8: "this has
            no cost set" is still a statement about cost). Gated on role here,
            not on `catalogHealth.unpricedCount` happening to be zero or null
            — `getCatalogHealth` never runs that query for a manager in the
            first place (lib/domain/catalog.ts), so this tile would be
            silently empty for them even without this check; the check is
            what keeps that an intentional decision rather than an accident of
            the data. A valuation that goes quiet about how much of the
            catalog has no price is exactly the plausible-but-wrong number
            this app exists to avoid. */}
        {user.role === "owner" && catalogHealth ? (
          <Card>
            <p className="text-label uppercase text-muted-foreground">Unpriced products</p>
            <p className="mt-2 text-numeral-md text-card-foreground">
              {catalogHealth.unpricedCount ?? 0} of {catalogHealth.activeCount}
            </p>
            <p className="text-caption text-muted-foreground">
              have no cost on file — their lines are excluded from every valuation, never
              counted as free.
            </p>
            <Link
              href="/office/catalog?view=attention"
              className="mt-3 inline-block text-caption text-foreground underline"
            >
              Price the catalog
            </Link>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
