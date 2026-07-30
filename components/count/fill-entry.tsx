"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const TENTHS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

/**
 * Open-bottle fill entry, in tenths (spec §6).
 *
 * Tenths rather than full/half/empty: a "half" bucket spanning 30–70% carries
 * ±20% error on every open bottle, which across ~45 of them is more noise
 * than the shrinkage the count is trying to detect. Three big targets (Empty,
 * Half, Full) keep the common cases one tap, and the tenths row covers the
 * rest — the fast path without throwing away precision on ambiguous bottles.
 *
 * Each tap appends one bottle's reading. Several open bottles of the same
 * product on the same shelf is normal, and `partial_fills` is an array of
 * individual observations (`[0.3, 0.8]`), never a rolled-up total — so one
 * bottle can later be corrected without recounting the shelf.
 */
export function FillEntry({
  productName,
  existingFills,
  canCorrect,
  pending,
  onSubmit,
  onCorrect,
  onCancel,
}: {
  productName: string;
  existingFills: number[];
  /** True once the line exists server-side, which is what a correction edits. */
  canCorrect?: boolean;
  pending?: boolean;
  onSubmit: (newFills: number[]) => void;
  /** Replaces the whole array. See the correction block below for why. */
  onCorrect?: (allFills: number[]) => void;
  onCancel: () => void;
}) {
  const [fills, setFills] = useState<number[]>([]);
  /**
   * Correction mode replaces `partial_fills` outright instead of appending.
   *
   * Why this exists at all: every tap here is APPEND-only, so before this
   * there was no way to walk back a misread bottle. Tap 80% when you meant
   * 30% and the line carried an extra half-unit forever — the only remedy was
   * a second wrong reading to average it out, which is not a remedy.
   *
   * Sealed quantities have had an answer for exactly this since the start
   * (SET, with a live before/after on the button). Open bottles are the half
   * that needs it MORE, not less: a sealed count is a number anyone can
   * re-derive by looking at the shelf, while a fill level is a judgement call
   * recorded once by one person in a dim room.
   */
  const [correcting, setCorrecting] = useState(false);
  const [draft, setDraft] = useState<number[]>([]);

  const add = (value: number) =>
    correcting
      ? setDraft((prev) => [...prev, value])
      : setFills((prev) => [...prev, value]);
  const removeAt = (index: number) => setFills((prev) => prev.filter((_, i) => i !== index));

  const total = fills.reduce((sum, f) => sum + f, 0);

  if (correcting) {
    const was = existingFills.reduce((sum, f) => sum + f, 0);
    const now = draft.reduce((sum, f) => sum + f, 0);
    const delta = now - was;

    return (
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-label uppercase text-foreground">Correct the readings</p>
          <p className="mt-1 text-caption text-muted-foreground">
            This <strong className="text-foreground">replaces</strong> what is recorded for{" "}
            {productName} here — it does not add to it. Tap a chip to drop that bottle, or
            tap the pad below to add one back.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-card-pad">
          {draft.length === 0 ? (
            <p className="text-row-subtitle text-muted-foreground">
              No open bottles left here. Saving this records zero.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {draft.map((f, i) => (
                <button
                  key={`${f}-${i}`}
                  type="button"
                  onClick={() => setDraft((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove ${Math.round(f * 100)} percent reading`}
                  className="inline-flex min-h-tap-min items-center gap-2 rounded-full border border-input px-3 text-numeral-sm tabular-nums text-foreground"
                >
                  {Math.round(f * 100)}%<span aria-hidden="true">×</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <p className="mb-2 text-label uppercase text-muted-foreground">Add a reading back</p>
          <div className="grid grid-cols-6 gap-2">
            {TENTHS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => add(t)}
                aria-label={`${Math.round(t * 100)} percent full`}
                className="min-h-tap-min rounded-md border border-input bg-card text-numeral-sm tabular-nums text-foreground"
              >
                {Math.round(t * 100)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-3">
          <Button
            variant="outline"
            size="primary"
            className="flex-1"
            onClick={() => setCorrecting(false)}
          >
            Cancel
          </Button>
          {/*
            The button states the consequence as they edit, same rule as the
            quantity SET (CLAUDE.md): a replace that someone meant as an
            append loses bottles with nothing on screen looking wrong
            afterwards, because the line just reads its new total either way.
            No modal — a dialog on a control used this often gets clicked
            through blind inside a week, which is worse than no guard.
          */}
          <button
            type="button"
            disabled={pending}
            onClick={() => onCorrect?.(draft)}
            className="flex min-h-tap-primary flex-[1.4] flex-col items-center justify-center gap-0.5 rounded-md bg-primary px-2 text-primary-foreground disabled:opacity-50"
          >
            <span className="text-label uppercase">
              Replace with {draft.length} {draft.length === 1 ? "bottle" : "bottles"}
            </span>
            <span className="text-caption tabular-nums opacity-80">
              was {was.toFixed(1)} · {delta >= 0 ? "+" : "−"}
              {Math.abs(delta).toFixed(1)} units
            </span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {existingFills.length > 0 ? (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-caption text-muted-foreground">
            Already recorded here:{" "}
            <strong className="text-foreground">
              {existingFills.map((f) => `${Math.round(f * 100)}%`).join(", ")}
            </strong>
            . These add to that, they don&rsquo;t replace it.
          </p>
          {canCorrect && onCorrect ? (
            <button
              type="button"
              onClick={() => {
                setDraft(existingFills);
                setCorrecting(true);
              }}
              className="min-h-tap-min text-caption font-medium text-accent underline"
            >
              Correct these
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Empty", value: 0 },
          { label: "Half", value: 0.5 },
          { label: "Full", value: 1 },
        ].map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => add(preset.value)}
            className="min-h-tap-primary rounded-md border border-input bg-card text-label uppercase text-foreground"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div>
        <p className="mb-2 text-label uppercase text-muted-foreground">Or tap a tenth</p>
        <div className="grid grid-cols-6 gap-2">
          {TENTHS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => add(t)}
              aria-label={`${Math.round(t * 100)} percent full`}
              className="min-h-tap-min rounded-md border border-input bg-card text-numeral-sm tabular-nums text-foreground"
            >
              {Math.round(t * 100)}
            </button>
          ))}
        </div>
      </div>

      {fills.length > 0 ? (
        <div className="rounded-lg border border-border bg-card p-card-pad">
          <p className="text-label uppercase text-muted-foreground">
            {fills.length} {fills.length === 1 ? "bottle" : "bottles"} to add
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {fills.map((f, i) => (
              <button
                key={`${f}-${i}`}
                type="button"
                onClick={() => removeAt(i)}
                aria-label={`Remove ${Math.round(f * 100)} percent reading`}
                className="inline-flex min-h-tap-min items-center gap-2 rounded-full border border-input px-3 text-numeral-sm tabular-nums text-foreground"
              >
                {Math.round(f * 100)}%<span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-caption text-muted-foreground">
            Adds {total.toFixed(1)} units to {productName}. Tap a chip to remove it.
          </p>
        </div>
      ) : null}

      <div className="flex gap-3">
        <Button variant="outline" size="primary" className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
        <button
          type="button"
          disabled={pending || fills.length === 0}
          onClick={() => onSubmit(fills)}
          className={cn(
            "flex min-h-tap-primary flex-[1.4] flex-col items-center justify-center gap-0.5 rounded-md bg-primary px-2 text-primary-foreground disabled:opacity-50",
          )}
        >
          <span className="text-label uppercase">
            Add {fills.length || ""} {fills.length === 1 ? "bottle" : "bottles"}
          </span>
          {fills.length > 0 ? (
            <span className="text-caption tabular-nums opacity-80">+{total.toFixed(1)} units</span>
          ) : null}
        </button>
      </div>
    </div>
  );
}
