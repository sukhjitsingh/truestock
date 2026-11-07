import { cn } from "@/lib/utils";

/**
 * Status pill — docs/design-system.md §9.
 *
 * The tone names are deliberately status words, not colors. §3's binding rule:
 * green/amber/red are status-only and blue is brand-only, so a component that
 * took `color="green"` would be one careless call away from a green pill that
 * means "selected". `neutral` exists for pills that carry no judgement at all
 * (a location name, a size) and must not borrow a status tint to look lively.
 */
export type PillTone = "success" | "warning" | "negative" | "neutral";

const TONES: Record<PillTone, string> = {
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  negative: "bg-negative-bg text-negative",
  neutral: "bg-muted text-muted-foreground",
};

export function StatusPill({
  tone = "neutral",
  children,
  className,
}: {
  tone?: PillTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full px-3 py-1 text-label uppercase",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Count lifecycle status -> pill tone. One mapping, used by every screen. */
export function countStatusTone(status: string): PillTone {
  switch (status) {
    case "closed":
      return "success";
    case "in_progress":
    case "submitted":
    case "reviewed":
      return "warning";
    default:
      return "neutral";
  }
}

export function countStatusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

/**
 * Invoice lifecycle status -> pill tone (Phase 2.5). Mirrors
 * `countStatusTone`'s reasoning: `needs_review` and `reviewed` are "not
 * done yet, wants a look" the same way a count's `in_progress`/`submitted`/
 * `reviewed` do, so they share the warning tone; `approved` is terminal
 * (`lib/domain/invoices.ts`'s `INVOICE_TRANSITIONS`), matching a closed
 * count's success tone; `rejected` is the one invoice status that is
 * genuinely blocked, matching `negative`. `uploaded` has nothing happening
 * yet — neutral, same as a count's `draft` default below.
 */
export function invoiceStatusTone(status: string): PillTone {
  switch (status) {
    case "approved":
      return "success";
    case "processing":
    case "needs_review":
    case "reviewed":
      return "warning";
    case "rejected":
      return "negative";
    default:
      return "neutral";
  }
}

export function invoiceStatusLabel(status: string): string {
  return status.replace(/_/g, " ");
}
