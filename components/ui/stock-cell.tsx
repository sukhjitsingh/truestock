import { cn, formatUnits } from "@/lib/utils";
import { Meter, type MeterTone } from "@/components/ui/meter";

/**
 * The stock cell — docs/plans/phase-2-ui-redesign/ui-spec-web.md §3,
 * `docs/design-reference.md` Part B (named there as the best idea in the
 * reference shot).
 *
 * ```
 * 20 unit · Low
 * ▰▱▱▱▱▱▱▱▱▱          ← 2px bar, width = on-hand ÷ par, color = status
 * ```
 *
 * **No-par-no-bar, binding and stated hard:** `ProductPar.location_id` is
 * nullable and the MVP writes NULL rows only — most products currently have
 * no par. No par means no bar AND no status word. With no par this renders
 * the unit count alone (`20 unit`), nothing else in the cell. `Meter`
 * already refuses to draw at all when its denominator is absent (see
 * components/ui/meter.tsx) — this component adds no separate check that
 * could drift from that one, it just doesn't compute or show a status word
 * when there's no ratio to base it on.
 */

export interface StockStatus {
  tone: MeterTone;
  label: string;
}

/**
 * Status classification is presentation, not domain logic: it turns two
 * already-supplied numbers (on-hand, par) into a tone + word, the same kind
 * of mapping `countStatusTone` already does for count status
 * (components/ui/status-pill.tsx). It computes nothing the caller didn't
 * already have and writes nothing back — no business-logic change.
 */
export function stockStatus(onHand: number, par: number): StockStatus {
  if (onHand <= 0) return { tone: "negative", label: "Out" };
  if (onHand / par < 0.5) return { tone: "warning", label: "Low" };
  return { tone: "success", label: "In stock" };
}

export function StockCell({
  onHand,
  par,
  unitLabel = "unit",
  isPartial = false,
  className,
}: {
  onHand: number;
  /** Absent or <= 0 means "no par set" — renders the unit count alone. */
  par?: number | null;
  unitLabel?: string;
  /**
   * True when `onHand` is a floor, not a total (an indeterminate line — see
   * lib/domain/on-hand.ts). Renders a trailing "+" on the number; never
   * silently rounds or hides the uncertainty.
   */
  isPartial?: boolean;
  className?: string;
}) {
  const hasPar = par != null && par > 0;
  const status = hasPar ? stockStatus(onHand, par) : null;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className="text-numeral-sm tabular-nums text-foreground">
        {formatUnits(onHand)}
        {isPartial ? "+" : ""} {unitLabel}
        {status ? (
          <>
            {" "}
            · <StatusWord tone={status.tone}>{status.label}</StatusWord>
          </>
        ) : null}
      </span>
      {hasPar ? <Meter value={onHand} max={par} tone={status!.tone} /> : null}
    </div>
  );
}

const STATUS_TEXT: Record<MeterTone, string> = {
  success: "text-success",
  warning: "text-warning",
  negative: "text-negative",
  neutral: "text-foreground",
};

function StatusWord({ tone, children }: { tone: MeterTone; children: React.ReactNode }) {
  return <span className={STATUS_TEXT[tone]}>{children}</span>;
}
