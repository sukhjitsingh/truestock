import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, CalendarDays, Check } from "lucide-react";
import { requireUser } from "@/lib/current-user";
import { getCountAction, getCountTotalsAction } from "@/app/actions/counts";
import { DetailHeader, HeaderPill } from "@/components/ui/detail-header";
import { StatusPill, countStatusTone, countStatusLabel } from "@/components/ui/status-pill";
import { CardStack } from "@/components/ui/card";
import { ProgressCard } from "@/components/count/progress-card";
import { StatusTimeline } from "@/components/count/status-timeline";
import { CountLineCard } from "@/components/count/count-line-card";
import { SessionActions } from "@/components/count/session-actions";
import { formatDate } from "@/lib/utils";

export default async function CountSessionPage({
  params,
}: {
  params: Promise<{ countId: string }>;
}) {
  const user = await requireUser();
  const countId = Number((await params).countId);
  if (!Number.isInteger(countId) || countId <= 0) notFound();

  const [detail, totals] = await Promise.all([
    getCountAction({ countId }),
    getCountTotalsAction({ countId }),
  ]);

  if (!detail.ok || !totals.ok) {
    notFound();
  }

  const { count, lines } = detail.data;
  const locations = [...new Set(lines.map((l) => l.locationName))];

  return (
    <div className="pb-action-bar">
      <DetailHeader
        title={`Count #${count.id}`}
        leading={
          <Link
            href="/count"
            aria-label="Back to counts"
            className="flex size-11 items-center justify-center rounded-full border border-header-foreground/20"
          >
            <ChevronLeft className="size-5" aria-hidden="true" />
          </Link>
        }
        pills={
          <>
            <HeaderPill>{count.type.replace(/_/g, " ")}</HeaderPill>
            <StatusPill tone={countStatusTone(count.status)}>
              {countStatusLabel(count.status)}
            </StatusPill>
          </>
        }
        meta={
          <>
            <CalendarDays className="size-4" aria-hidden="true" />
            <span>
              Started {formatDate(count.startedAt)}
              {locations.length > 0 ? ` · ${locations.join(", ")}` : ""}
            </span>
          </>
        }
      />

      {/*
        Invariant 1 made visible. A closed count shows why there is no edit
        path rather than leaving the missing action bar unexplained.
      */}
      {count.status === "closed" ? (
        <div className="mx-bar-pad mt-3 flex items-start gap-2 rounded-md border border-border bg-muted p-3">
          <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
          <p className="text-caption text-muted-foreground">
            {count.closedAt ? `Closed ${formatDate(count.closedAt)}. ` : ""}
            This record is permanent — corrections happen as a new adjustment, never by
            editing this count.
          </p>
        </div>
      ) : null}

      <section className="px-bar-pad pt-5">
        <p className="mb-3 text-label uppercase text-muted-foreground">Progress</p>
        <ProgressCard totals={totals.data} />
      </section>

      <section className="px-bar-pad pt-5">
        <p className="mb-3 text-label uppercase text-muted-foreground">Status</p>
        <StatusTimeline
          status={count.status}
          startedAt={count.startedAt}
          closedAt={count.closedAt}
        />
      </section>

      <section className="px-bar-pad pt-5">
        <div className="mb-3 flex items-baseline justify-between">
          <p className="text-label uppercase text-muted-foreground">Counted lines</p>
          <p className="text-caption text-muted-foreground">{lines.length}</p>
        </div>
        {lines.length === 0 ? (
          <p className="text-row-subtitle text-muted-foreground">
            Nothing counted yet. Tap <strong className="text-foreground">Keep counting</strong> to
            start a section.
          </p>
        ) : (
          <CardStack>
            {lines.map((line) => (
              <CountLineCard key={line.id} data={line} />
            ))}
          </CardStack>
        )}
      </section>

      <SessionActions
        countId={count.id}
        status={count.status}
        role={user.role}
        totalValue={totals.data.totalValue}
      />
    </div>
  );
}
