import Link from "next/link";
import { ChevronRight, ClipboardList, MapPin } from "lucide-react";
import { requireUser } from "@/lib/current-user";
import {
  getActiveCountAction,
  getCountTotalsAction,
  getCountAction,
} from "@/app/actions/counts";
import { listLocationsAction } from "@/app/actions/catalog";
import { Card, CardStack } from "@/components/ui/card";
import { StatusPill, countStatusTone, countStatusLabel } from "@/components/ui/status-pill";
import { StartCountButton } from "@/components/count/start-count-button";
import { formatDate, formatUnits, formatMoney } from "@/lib/utils";
import { isCountWritable } from "@/lib/count-status";

export const metadata = { title: "Floor Count · Truestock" };

/**
 * Floor Count Hub (`/count`, Target 8)
 *
 * Provides:
 * 1. Top header bar with brand mark, shift role badge, and preflight diagnostic link.
 * 2. Active session hero card with metrics grid (Lines / Units / Valuation) and 56px resume action.
 * 3. Location section checklist with progress indicators per bar station.
 * 4. Empty state with 56px Start Count trigger when no session is active.
 */
export default async function CountHomePage() {
  const user = await requireUser();
  const active = await getActiveCountAction();
  const activeCount = active.ok ? active.data : null;

  const [totals, detail, locationsResult] = activeCount
    ? await Promise.all([
        getCountTotalsAction({ countId: activeCount.id }),
        getCountAction({ countId: activeCount.id }),
        listLocationsAction(),
      ])
    : [null, null, null];

  const locations = locationsResult?.ok ? locationsResult.data : [];
  const lines = detail?.ok ? detail.data.lines : [];

  // Compute lines counted per location
  const locationLinesMap = new Map<number, { count: number; units: number }>();
  for (const line of lines) {
    const prev = locationLinesMap.get(line.locationId) ?? { count: 0, units: 0 };
    locationLinesMap.set(line.locationId, {
      count: prev.count + 1,
      units: prev.units + (line.units ?? 0),
    });
  }

  const roleLabel =
    user.role === "owner" ? "Owner" : user.role === "manager" ? "Manager" : "Staff";

  return (
    <div className="px-bar-pad pb-8 pt-4">
      {/* Top Header Bar */}
      <header className="flex items-center justify-between gap-2 border-b border-border/60 pb-3.5">
        <div className="flex items-center gap-2">
          <span className="text-row-title text-accent">●</span>
          <span className="text-row-title font-bold tracking-tight text-foreground">Truestock</span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/count/account"
            className="inline-flex min-h-tap-min items-center rounded-full border border-border/80 bg-card/90 px-3 py-1 text-label uppercase text-muted-foreground font-semibold transition-colors hover:border-accent/40 hover:text-foreground"
            aria-label={`Signed in as ${user.name}, role ${roleLabel}. Open account settings.`}
          >
            <span>{roleLabel}</span>
            <span className="ml-1.5" aria-hidden="true">👤</span>
          </Link>
          <Link
            href="/count/preflight"
            className="inline-flex min-h-tap-min items-center gap-1 rounded-md border border-border/80 bg-secondary/80 px-2.5 py-1 text-caption font-semibold text-foreground transition-all hover:bg-muted active:scale-95"
            aria-label="Open hardware & storage preflight diagnostics"
          >
            <span>Preflight</span>
            <span aria-hidden="true">⚙️</span>
          </Link>
        </div>
      </header>

      {/* Screen Title & User Subtitle */}
      <div className="pt-4">
        <h1 className="text-header-title text-foreground">Floor Count</h1>
        <p className="mt-0.5 text-row-subtitle text-muted-foreground">
          {user.name ? `Signed in as ${user.name}` : "Mobile inventory counting"}
        </p>
      </div>

      {/* Active Session Hero Section */}
      <section className="mt-section-gap">
        <div className="mb-3 flex items-baseline justify-between">
          <p className="text-label uppercase text-muted-foreground font-semibold">Active Session</p>
          {activeCount ? (
            <Link
              href={`/count/${activeCount.id}`}
              className="text-caption text-accent hover:underline"
            >
              Session Details →
            </Link>
          ) : null}
        </div>

        {activeCount ? (
          <div className="glass-card border-accent/60 relative overflow-hidden">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <StatusPill tone={countStatusTone(activeCount.status)}>
                  {activeCount.status === "in_progress" ? "● " : ""}
                  {countStatusLabel(activeCount.status)}
                </StatusPill>
                <h2 className="mt-2 text-row-title font-bold text-card-foreground">
                  Count #{activeCount.id} · {activeCount.type.replace(/_/g, " ")}
                </h2>
                <p className="text-caption text-muted-foreground">
                  Started {formatDate(activeCount.startedAt)}
                </p>
              </div>
              <Link
                href={`/count/${activeCount.id}`}
                aria-label={`View details for Count #${activeCount.id}`}
                className="flex size-tap-min shrink-0 items-center justify-center text-accent hover:text-foreground"
              >
                <ChevronRight className="size-6" aria-hidden="true" />
              </Link>
            </div>

            {/* 2-Column Metrics Grid */}
            <div className="my-1 grid grid-cols-2 gap-3 border-y border-border/80 py-3">
              <div>
                <p className="text-label uppercase text-muted-foreground">Lines Counted</p>
                <p className="text-numeral-md font-bold text-card-foreground">
                  {totals?.ok ? `${totals.data.lineCount} lines` : "0 lines"}
                </p>
              </div>
              <div>
                <p className="text-label uppercase text-muted-foreground">Total Units</p>
                <p className="text-numeral-md font-bold text-card-foreground">
                  {totals?.ok ? `${formatUnits(totals.data.totalUnits)} units` : "0 units"}
                </p>
              </div>
            </div>

            {/* Role-Gated Total Valuation (Owner only) */}
            {user.role === "owner" && totals?.ok && totals.data.totalValue != null ? (
              <div className="mb-2 flex items-baseline justify-between text-caption">
                <span className="text-muted-foreground">Current Valuation:</span>
                <span className="font-semibold tabular-nums text-card-foreground">
                  {formatMoney(totals.data.totalValue)}
                </span>
              </div>
            ) : null}

            {/* Resume Action Button (56px Primary Floor) */}
            {isCountWritable(activeCount.status) ? (
              <Link
                href={`/count/${activeCount.id}/scan`}
                className="flex min-h-tap-primary w-full items-center justify-center rounded-md bg-primary px-4 text-label uppercase text-primary-foreground font-bold shadow-md transition-all hover:opacity-95 active:scale-[0.985]"
              >
                Resume Count #{activeCount.id} →
              </Link>
            ) : (
              <Link
                href={`/count/${activeCount.id}`}
                className="flex min-h-tap-primary w-full items-center justify-center rounded-md border border-input bg-card px-4 text-label uppercase text-foreground font-bold transition-all hover:bg-muted active:scale-[0.985]"
              >
                Review Count #{activeCount.id} →
              </Link>
            )}
          </div>
        ) : (
          <Card className="glass-card text-center py-6">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <ClipboardList className="size-6" aria-hidden="true" />
            </div>
            <h3 className="mt-3 text-row-title text-card-foreground font-semibold">No Open Count</h3>
            <p className="mt-1 text-row-subtitle text-muted-foreground">
              There is no inventory count session currently in flight.
            </p>
            <div className="mt-4">
              <StartCountButton />
            </div>
          </Card>
        )}
      </section>

      {/* Location Section Checklist (When Count is Active) */}
      {activeCount && locations.length > 0 ? (
        <section className="mt-section-gap">
          <div className="mb-3 flex items-baseline justify-between">
            <p className="text-label uppercase text-muted-foreground font-semibold">
              Sections to Count
            </p>
            <span className="text-caption text-muted-foreground">
              {locations.filter((l) => (locationLinesMap.get(l.id)?.count ?? 0) > 0).length} of{" "}
              {locations.length} started
            </span>
          </div>

          <CardStack>
            {locations.map((loc) => {
              const locData = locationLinesMap.get(loc.id);
              const count = locData?.count ?? 0;
              const isDone = count > 0;

              return (
                <div
                  key={loc.id}
                  className="glass-card flex items-center justify-between gap-3 p-card-pad"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-accent">
                      <MapPin className="size-4" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-row-title font-semibold text-card-foreground">
                        {loc.name}
                      </p>
                      <p className="text-caption text-muted-foreground">
                        {loc.countMode === "tenths" ? "Fill levels (tenths)" : "Quantities only"}
                      </p>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <StatusPill tone={isDone ? "success" : "neutral"}>
                      {isDone ? `${count} ${count === 1 ? "line" : "lines"}` : "Pending"}
                    </StatusPill>
                    {isCountWritable(activeCount.status) ? (
                      <Link
                        href={`/count/${activeCount.id}/scan`}
                        aria-label={`Count ${loc.name}`}
                        className="flex size-tap-min items-center justify-center text-muted-foreground hover:text-accent"
                      >
                        <ChevronRight className="size-5" aria-hidden="true" />
                      </Link>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </CardStack>
        </section>
      ) : null}
    </div>
  );
}

