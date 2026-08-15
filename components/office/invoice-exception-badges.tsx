import { StatusPill, type PillTone } from "@/components/ui/status-pill";

/**
 * The four exception flags a review-invoice line can carry
 * (docs/plans/phase-2.5-invoice-automation/04-slices.md, Slice 2 §"What's
 * new"). Exactly these four, never more, never fewer, in this slice — the
 * extraction pipeline (lib/domain/invoice-lines.ts, out of scope for this
 * file) is the only writer of `invoice_line.exception_flags`.
 */
export const KNOWN_EXCEPTION_FLAGS = [
  "price jump",
  "duplicate",
  "doesn't add up",
  "unmatched item",
] as const;

export type InvoiceExceptionFlag = (typeof KNOWN_EXCEPTION_FLAGS)[number];

const EXCEPTION_FLAG_LABEL: Record<InvoiceExceptionFlag, string> = {
  "price jump": "Price jump",
  duplicate: "Duplicate",
  "doesn't add up": "Doesn't add up",
  "unmatched item": "Unmatched item",
};

/**
 * Tone split, not a single shared color — docs/design-system.md §3's binding
 * rule limits pills to success/warning/negative/neutral, and "success" is
 * never correct for an exception. `duplicate` and `doesn't add up` are both
 * arithmetic/data-integrity problems (something is actually wrong with the
 * extracted numbers) — `negative`, the same tone a blocked count step gets.
 * `price jump` and `unmatched item` need a human's judgement but aren't
 * necessarily wrong — `warning`, the "needs attention" tone.
 */
const EXCEPTION_FLAG_TONE: Record<InvoiceExceptionFlag, PillTone> = {
  "price jump": "warning",
  "unmatched item": "warning",
  duplicate: "negative",
  "doesn't add up": "negative",
};

function isKnownFlag(value: string): value is InvoiceExceptionFlag {
  return (KNOWN_EXCEPTION_FLAGS as readonly string[]).includes(value);
}

/**
 * The "Chip" reuse of `StatusPill` documented in docs/design-system.md §9
 * ("Chip") — same component, a reason/action label rather than a stock/count
 * status, exactly like `catalog-table.tsx`'s `REASON_LABEL` pills.
 *
 * Renders nothing (not an empty wrapper) when there are no flags, so a clean
 * line's row doesn't reserve a blank badge track.
 *
 * An unrecognized flag string (a future exception type the badge map hasn't
 * been taught yet) still renders, in `neutral` tone, rather than silently
 * disappearing — the same "don't hide a fact you can't classify" discipline
 * `NullValue`'s doc comment states for missing values applies here to an
 * unexpected-but-present one.
 */
export function InvoiceExceptionBadges({
  flags,
  className,
}: {
  flags: string[] | null | undefined;
  className?: string;
}) {
  if (!flags || flags.length === 0) return null;
  return (
    <div className={className ?? "flex flex-wrap gap-1.5"}>
      {flags.map((flag) =>
        isKnownFlag(flag) ? (
          <StatusPill key={flag} tone={EXCEPTION_FLAG_TONE[flag]}>
            {EXCEPTION_FLAG_LABEL[flag]}
          </StatusPill>
        ) : (
          <StatusPill key={flag} tone="neutral">
            {flag}
          </StatusPill>
        ),
      )}
    </div>
  );
}
