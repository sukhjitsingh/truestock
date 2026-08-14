import { cn } from "@/lib/utils";
import { NullValue, type NullValueReason } from "@/components/ui/null-value";

/**
 * Meter / Sparkline / Stat tile — docs/design-system.md §9,
 * docs/plans/phase-2-ui-redesign/ui-spec-web.md §9.
 *
 * Dependency-free per library-comparison.md: plain `<div>` and inline
 * `<svg>` against the existing tokens, no charting library. None of these
 * three consume a `--chart-*` token by default — color comes from a status
 * token (docs/design-system.md §3) or `--foreground`/`--muted-foreground`.
 * Only a genuine multi-series chart (Phase 4) needs the chart palette, and
 * that palette is still owed (`app/globals.css`) — nothing here may reach
 * for `--chart-2` through `--chart-5`.
 */

export type MeterTone = "success" | "warning" | "negative" | "neutral";

const METER_FILL: Record<MeterTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  negative: "bg-negative",
  neutral: "bg-foreground",
};

/**
 * The stock-cell bar, and any future par-vs-on-hand meter.
 *
 * **No-par-no-bar, enforced here, not just by callers.** When `max` is
 * absent or non-positive, this primitive renders nothing at all — there is
 * no "draw at 0%" fallback. A bar at zero width and a bar for a genuinely
 * empty product are visually identical and mean opposite things
 * (ui-spec-web.md §3's binding rule), so the only safe behavior for an
 * absent denominator is to not draw a bar at all.
 */
export function Meter({
  value,
  max,
  tone = "neutral",
  className,
}: {
  value: number;
  /** The denominator (e.g. par level). Absent or <= 0 means "don't draw." */
  max?: number | null;
  tone?: MeterTone;
  className?: string;
}) {
  if (max == null || max <= 0) return null;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      className={cn("h-0.5 w-full overflow-hidden rounded-full bg-muted", className)}
      role="presentation"
    >
      <div className={cn("h-full rounded-full", METER_FILL[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * A single inline-SVG sparkline. `stroke="currentColor"` so it inherits
 * `text-muted-foreground` (or a status token) through the cascade and
 * re-themes for free under `.dark` with no JS. No fill, no axes, no
 * interactivity — that's Phase 4 chart territory (visx), not this
 * primitive's job.
 *
 * Purely decorative unless `ariaLabel` is passed (e.g. a trend summary
 * sentence) — a sparkline with no `ariaLabel` is marked `aria-hidden` so it
 * isn't announced as an unlabeled image; pass a real, specific label
 * ("Rising over the last 4 counts") when the trend itself is information the
 * screen depends on, not just a decorative echo of a number stated in text
 * nearby.
 */
export function Sparkline({
  values,
  width = 64,
  height = 20,
  ariaLabel,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  ariaLabel?: string;
  className?: string;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  });

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("text-muted-foreground", className)}
      {...(ariaLabel ? { role: "img", "aria-label": ariaLabel } : { "aria-hidden": "true" })}
    >
      <path
        d={`M${points.join(" L")}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A dashboard stat card: label + one number, optionally with a sparkline.
 * Reuses the existing card token set — no new spec.
 *
 * Follows §6's null-value rule (ui-spec-web.md) for the underlying figure:
 * pass either `value` (already-formatted, present data) or `emptyReason`
 * (one of `NullValueReason`) — never both. A `role-gated` reason omits the
 * WHOLE tile (a labelled tile with nothing beside it would still leak "a
 * number exists here you can't see," the same leak §8 refuses for `Money`).
 */
export function StatTile({
  label,
  value,
  emptyReason,
  size = "md",
  sparkline,
  className,
}: {
  label: string;
  value?: React.ReactNode;
  emptyReason?: NullValueReason;
  size?: "md" | "lg";
  sparkline?: React.ReactNode;
  className?: string;
}) {
  if (value == null && emptyReason === "role-gated") return null;

  const valueSizeClass = size === "lg" ? "text-numeral-lg" : "text-numeral-md";

  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-lg border border-border bg-card p-card-pad",
        className,
      )}
    >
      <span className="text-label uppercase text-muted-foreground">{label}</span>
      {value != null ? (
        <span className={cn(valueSizeClass, "text-card-foreground")}>{value}</span>
      ) : (
        <NullValue reason={emptyReason ?? "not-entered"} className={valueSizeClass} />
      )}
      {sparkline}
    </div>
  );
}
