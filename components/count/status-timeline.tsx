import { cn, formatDate } from "@/lib/utils";

const STEPS = [
  { key: "draft", title: "Draft created" },
  { key: "in_progress", title: "In progress" },
  { key: "submitted", title: "Submitted" },
  { key: "reviewed", title: "Reviewed" },
  { key: "closed", title: "Closed" },
] as const;

const ORDER = STEPS.map((s) => s.key) as readonly string[];

/**
 * The count lifecycle, per docs/design-system.md §9.
 *
 * Done = filled `success`. Current = `accent`-ringed — brand, not status,
 * because "this is where you are" is not a judgement about whether that is
 * good. Upcoming = `input`-ringed and muted.
 */
export function StatusTimeline({
  status,
  startedAt,
  closedAt,
}: {
  status: string;
  startedAt: Date | string;
  closedAt: Date | string | null;
}) {
  const currentIndex = ORDER.indexOf(status);

  return (
    <ol className="flex flex-col">
      {STEPS.map((step, index) => {
        const done = index < currentIndex;
        const current = index === currentIndex;
        const last = index === STEPS.length - 1;

        const date =
          step.key === "draft" || step.key === "in_progress"
            ? formatDate(startedAt)
            : step.key === "closed" && closedAt
              ? formatDate(closedAt)
              : null;

        return (
          <li key={step.key} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "size-3 shrink-0 rounded-full",
                  done && "bg-success",
                  current && "border-2 border-accent bg-background",
                  !done && !current && "border-2 border-input bg-background",
                )}
              />
              {!last ? <span className="w-px flex-1 bg-border" style={{ minHeight: 20 }} /> : null}
            </div>
            <div className={last ? "" : "pb-5"}>
              <p
                className={cn(
                  "text-row-subtitle",
                  done || current ? "font-semibold text-foreground" : "text-muted-foreground",
                )}
              >
                {step.title}
              </p>
              {date && (done || current) ? (
                <p className="text-caption text-muted-foreground">{date}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
