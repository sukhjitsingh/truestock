import Link from "next/link";
import { requireOfficeUser } from "@/lib/current-user";
import { getActiveCountAction, listCountsAction } from "@/app/actions/counts";
import { countSummaryAction, reorderListAction } from "@/app/actions/reports";
import { searchProductsAction } from "@/app/actions/catalog";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { StatusPill, countStatusTone, countStatusLabel } from "@/components/ui/status-pill";
import { formatDate, formatUnits } from "@/lib/utils";

export const metadata = { title: "Dashboard · Truestock" };

/**
 * The back-office landing screen. `/office` used to render the counts table
 * directly; that table now lives at `/office/counts` (components/office/
 * office-nav.tsx was updated alongside this move) and this route answers a
 * different question: "what needs my attention right now."
 *
 * Every read here is an existing server action — no new domain reads were
 * added, and no query runs directly against the database from this page
 * (CLAUDE.md invariant 9 lives entirely in lib/domain/*, not here). Role
 * gating for cost/value figures is likewise already decided server-side by
 * those actions (invariant 8) — this page never has an ungated dollar figure
 * to hide, only a present-or-absent one to render or not (design-system.md §8).
 *
 * Tiles are built PER ROLE (design-system.md's binding "no role switcher"
 * rule), not rendered-then-hidden: the "Unpriced products" tile is gated on
 * `user.role === "owner"` in this file, not on the data happening to be
 * empty — a manager's `searchProducts` payload never carries a `needs_cost`
 * reason at all (lib/domain/catalog.ts's `incompleteReasons`), so checking
 * data presence alone would still be correct today but would silently stop
 * being a role gate if that invariant ever moved.
 */
export default async function OfficeDashboardPage() {
  const user = await requireOfficeUser();

  const [activeResult, countsResult, reorderResult, productsResult] = await Promise.all([
    getActiveCountAction(),
    listCountsAction({ limit: 50 }),
    reorderListAction(),
    // Same call the catalog table makes (limit 100, active only) — reused
    // rather than duplicated so a future limit/shape change only has one
    // place to track. 100 covers the full 97-product seed catalog; a bigger
    // org would need pagination here too, same as the catalog page itself.
    searchProductsAction({ activeOnly: true, limit: 100, includeOnHand: false }),
  ]);

  const active = activeResult.ok ? activeResult.data : null;
  const counts = countsResult.ok ? countsResult.data : [];
  const products = productsResult.ok ? productsResult.data : [];
  const reorder = reorderResult.ok ? reorderResult.data : { asOfCountId: null, items: [] };

  // The most recently CLOSED count, by close time — not simply the first
  // "closed" row in a list ordered by start time, which could misorder two
  // counts closed out of the order they were started in.
  const lastClosed = counts
    .filter((c) => c.status === "closed" && c.closedAt != null)
    .sort((a, b) => (b.closedAt as Date).getTime() - (a.closedAt as Date).getTime())[0] ?? null;

  const lastClosedSummary = lastClosed
    ? await countSummaryAction({ countId: lastClosed.id })
    : null;
  const summary = lastClosedSummary?.ok ? lastClosedSummary.data : null;

  const incompleteCount = products.filter((p) => p.incomplete.length > 0).length;
  const uncostedCount = products.filter((p) => p.incomplete.includes("needs_cost")).length;

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
                <span className="flex min-h-tap-min items-center rounded-md bg-primary px-4 text-label uppercase text-primary-foreground">
                  Resume
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
        {/* Last closed count — value and vs-previous delta come from
            countSummary's own `previous` comparison (lib/domain/reports.ts),
            which already compares this count against the one closed before
            it, so there is no second aggregation to write here. */}
        <Card>
          <p className="text-label uppercase text-muted-foreground">Last closed count</p>
          {!lastClosed || !summary ? (
            <p className="mt-2 text-row-subtitle text-muted-foreground">
              No count has been closed yet.
            </p>
          ) : (
            <>
              <p className="mt-1 text-caption text-muted-foreground">
                #{lastClosed.id} &middot;{" "}
                {lastClosed.closedAt ? formatDate(lastClosed.closedAt) : ""}
              </p>
              <p className="mt-2 text-numeral-md text-card-foreground">
                {formatUnits(summary.totalUnits)} units
              </p>
              {/* Owner only — summary.totalValue arrives undefined for a
                  manager (invariant 8), and Money renders nothing for
                  undefined rather than $0.00 (design-system.md §8). */}
              <Money value={summary.totalValue} className="text-numeral-sm text-muted-foreground" />
              {summary.previous ? (
                <p className="mt-2 text-caption text-muted-foreground">
                  {summary.previous.unitsDelta > 0 ? "+" : summary.previous.unitsDelta < 0 ? "−" : ""}
                  {formatUnits(Math.abs(summary.previous.unitsDelta))} units vs #{summary.previous.countId}
                  {/* Both figures gated by the same `showCost` boolean in
                      lib/domain/reports.ts, so present or absent together —
                      checking both keeps this from ever half-rendering. */}
                  {summary.totalValue != null && summary.previous.valueDelta != null ? (
                    <>
                      {" "}
                      &middot; {summary.previous.valueDelta > 0 ? "+" : summary.previous.valueDelta < 0 ? "−" : ""}
                      ${Math.abs(summary.previous.valueDelta).toFixed(2)}
                    </>
                  ) : null}
                </p>
              ) : null}
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
            quantities only), so both roles see the same figure. */}
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
            only living inside the catalog page itself. */}
        <Card>
          <p className="text-label uppercase text-muted-foreground">Catalog health</p>
          <p className="mt-2 text-numeral-md text-card-foreground">{products.length} active products</p>
          <p className="text-caption text-muted-foreground">
            {incompleteCount} {incompleteCount === 1 ? "needs" : "need"} attention
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
            not on `uncostedCount` happening to be zero — a manager's
            `products` never carries the `needs_cost` reason in the first
            place (lib/domain/catalog.ts), so this tile would be silently
            empty for them even without this check; the check is what keeps
            that an intentional decision rather than an accident of the data.
            A valuation that goes quiet about how much of the catalog has no
            price is exactly the plausible-but-wrong number this app exists
            to avoid — currently most of the 97-product seed catalog. */}
        {user.role === "owner" ? (
          <Card>
            <p className="text-label uppercase text-muted-foreground">Unpriced products</p>
            <p className="mt-2 text-numeral-md text-card-foreground">
              {uncostedCount} of {products.length}
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
