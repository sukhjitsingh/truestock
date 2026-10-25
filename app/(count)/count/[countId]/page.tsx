import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, CalendarDays, CheckCircle2 } from "lucide-react";
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
import { isCountWritable } from "@/lib/count-status";

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
  const writable = isCountWritable(count.status);

  return (
    <div className="pb-action-bar">
      <DetailHeader
        title={`Count #${count.id}`}
        leading={
          <Link
            href="/count"
            aria-label="Back to counts"
            className="flex size-11 items-center justify-center rounded-full border border-header-foreground/20 text-header-foreground transition-colors hover:bg-header-foreground/10"
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
        Invariant 1 Immutable Closed Count Audit Mode:
        Closed counts render a persistent immutable audit notification banner explaining
        that the record is permanent and cannot be modified.
      */}
      {count.status === "closed" ? (
        <div className="mx-bar-pad mt-4 flex items-start gap-3 rounded-lg border border-border bg-success-bg/20 p-3.5 text-foreground">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
          <div>
            <p className="text-row-subtitle font-semibold text-foreground">
              Immutable closed count record
            </p>
            <p className="mt-0.5 text-caption text-muted-foreground">
              {count.closedAt ? `Closed on ${formatDate(count.closedAt)}. ` : ""}
              This count record is permanently sealed. Discrepancies and corrections must be recorded as a new adjustment.
            </p>
          </div>
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
              <CountLineCard
                key={line.id}
                data={line}
                href={writable ? `/count/${count.id}/scan` : undefined}
              />
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

