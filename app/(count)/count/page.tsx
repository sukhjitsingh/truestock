import Link from "next/link";
import { ChevronRight, ClipboardList } from "lucide-react";
import { requireUser } from "@/lib/current-user";
import { getActiveCountAction, getCountTotalsAction } from "@/app/actions/counts";
import { Card } from "@/components/ui/card";
import { StatusPill, countStatusTone, countStatusLabel } from "@/components/ui/status-pill";
import { StartCountButton } from "@/components/count/start-count-button";
import { formatDate, formatUnits } from "@/lib/utils";
import { isCountWritable } from "@/lib/count-status";

export const metadata = { title: "Count · Truestock" };

/**
 * The counting app's home. One question: is there a count in flight, and can
 * I get into it in one tap?
 */
export default async function CountHomePage() {
  const user = await requireUser();
  const active = await getActiveCountAction();
  const activeCount = active.ok ? active.data : null;

  const totals = activeCount ? await getCountTotalsAction({ countId: activeCount.id }) : null;

  return (
    <div className="px-bar-pad pb-8 pt-6">
      <h1 className="text-header-title text-foreground">Truestock</h1>
      <p className="mt-1 text-row-subtitle text-muted-foreground">
        Signed in as {user.name}
      </p>

      <section className="mt-section-gap">
        <p className="mb-3 text-label uppercase text-muted-foreground">Current count</p>

        {activeCount ? (
          <Card className="flex items-start gap-3">
            <div className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <ClipboardList className="size-7" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-row-title text-card-foreground">Count #{activeCount.id}</h2>
                <Link
                  href={`/count/${activeCount.id}`}
                  aria-label={`View count #${activeCount.id}`}
                  className="flex size-tap-min shrink-0 items-center justify-center text-muted-foreground"
                >
                  <ChevronRight className="size-5" aria-hidden="true" />
                </Link>
              </div>
              <p className="text-row-subtitle text-muted-foreground">
                {activeCount.type.replace(/_/g, " ")} &middot; started{" "}
                {formatDate(activeCount.startedAt)}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusPill tone={countStatusTone(activeCount.status)}>
                  {countStatusLabel(activeCount.status)}
                </StatusPill>
                {totals?.ok ? (
                  <span className="text-caption text-muted-foreground">
                    {totals.data.lineCount} lines &middot;{" "}
                    {formatUnits(totals.data.totalUnits)} units
                  </span>
                ) : null}
              </div>
            </div>
          </Card>
        ) : (
          <Card>
            <p className="text-row-subtitle text-muted-foreground">
              No count is open right now.
            </p>
          </Card>
        )}
      </section>

      <section className="mt-section-gap">
        {/*
          A submitted or reviewed count takes no more scans, so the primary
          action stops being "keep counting". Offering it anyway would send
          someone to /scan, which now redirects straight back here — a button
          that visibly does nothing, which is worse than a button that is not
          there.
        */}
        {activeCount ? (
          isCountWritable(activeCount.status) ? (
            <Link
              href={`/count/${activeCount.id}/scan`}
              className="flex min-h-tap-primary w-full items-center justify-center rounded-md bg-primary text-label uppercase text-primary-foreground"
            >
              Continue counting
            </Link>
          ) : (
            <Link
              href={`/count/${activeCount.id}`}
              className="flex min-h-tap-primary w-full items-center justify-center rounded-md border border-input text-label uppercase text-foreground"
            >
              Review this count
            </Link>
          )
        ) : (
          <StartCountButton />
        )}
      </section>
    </div>
  );
}
