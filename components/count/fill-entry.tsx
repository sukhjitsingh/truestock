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
   * screen existed, the only way to fix a wrong reading was to scan the
   * bottle again and go negative — which is wrong in a different way and
   * produces a −0.3 reading the next count's valuation has to explain. A
   * correction replaces the whole array instead, from a draft that starts
   * pre-loaded with what is currently recorded so the counter just drops
   * the wrong reading and taps save.
   */
  const [correcting, setCorrecting] = useState(false);
  const [draft, setDraft] = useState<number[]>([]);

  const add = (v: number) => setFills((prev) => [...prev, v]);
  const removeAt = (i: number) => setFills((prev) => prev.filter((_, j) => j !== i));
  const total = fills.reduce((s, f) => s + f, 0);

  // ---- correction mode -------------------------------------------------------

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
          {/*
            Three big shortcuts — the main row, same as the normal pad.
            Correction mode has the same one-hand constraint; the targets need
            to be just as generous.
          */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Empty", value: 0, sub: "0%" },
              { label: "Half", value: 0.5, sub: "50%" },
              { label: "Full", value: 1, sub: "100%" },
            ].map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => setDraft((prev) => [...prev, preset.value])}
                className="flex h-20 flex-col items-center justify-center gap-1 rounded-xl border border-input bg-card text-foreground active:bg-muted"
              >
                <span className="text-row-title font-semibold">{preset.label}</span>
                <span className="text-caption text-muted-foreground">{preset.sub}</span>
              </button>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-6 gap-2">
            {TENTHS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setDraft((prev) => [...prev, t])}
                aria-label={`${Math.round(t * 100)} percent full`}
                className="flex min-h-[56px] items-center justify-center rounded-lg border border-input bg-card text-numeral-sm tabular-nums text-foreground active:bg-muted"
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
            onClick={() => {
              setCorrecting(false);
              setDraft([]);
            }}
          >
            Cancel
          </Button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onCorrect?.(draft)}
            className="flex min-h-tap-primary flex-[1.4] flex-col items-center justify-center gap-0.5 rounded-md bg-primary px-2 text-primary-foreground disabled:opacity-50"
          >
            <span className="flex items-baseline gap-1">
              <span className="text-label uppercase">Replace with</span>
              <span className="text-numeral-sm uppercase tabular-nums">
                {draft.length} {draft.length === 1 ? "bottle" : "bottles"}
              </span>
            </span>
            <span className="text-caption tabular-nums text-primary-foreground/70">
              was {was.toFixed(1)} ·{" "}
              <span className={delta >= 0 ? "text-success" : "text-negative"}>
                {delta >= 0 ? "+" : "−"}
                {Math.abs(delta).toFixed(1)} units
              </span>
            </span>
          </button>
        </div>
      </div>
    );
  }

  // ---- normal add mode -------------------------------------------------------

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

      {/*
        Three dominant shortcuts: the most common readings in a real bar.
        Tall enough (h-20 = 80px) to hit one-handed while holding a bottle.
        The tenths row sits below as precision without being the first target.
      */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Empty", value: 0, sub: "0%" },
          { label: "Half", value: 0.5, sub: "50%" },
          { label: "Full", value: 1, sub: "100%" },
        ].map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => add(preset.value)}
            className="flex h-20 flex-col items-center justify-center gap-1 rounded-xl border border-input bg-card text-foreground active:bg-muted"
          >
            <span className="text-row-title font-semibold">{preset.label}</span>
            <span className="text-caption text-muted-foreground">{preset.sub}</span>
          </button>
        ))}
      </div>

      <div>
        <p className="mb-2 text-label uppercase text-muted-foreground">Or tap a tenth</p>
        {/*
          6-column grid so each cell is ~55px wide on a 375px phone — above the
          44px touch floor. min-h-[56px] = tap-primary minimum per design system.
        */}
        <div className="grid grid-cols-6 gap-2">
          {TENTHS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => add(t)}
              aria-label={`${Math.round(t * 100)} percent full`}
              className="flex min-h-[56px] items-center justify-center rounded-lg border border-input bg-card text-numeral-sm tabular-nums text-foreground active:bg-muted"
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
          <span className="flex items-baseline gap-1">
            <span className="text-label uppercase">Add</span>
            {fills.length > 0 ? (
              <span className="text-numeral-sm uppercase tabular-nums">
                {fills.length} {fills.length === 1 ? "bottle" : "bottles"}
              </span>
            ) : null}
          </span>
          {fills.length > 0 ? (
            <span className="text-caption tabular-nums text-primary-foreground/70">
              +{total.toFixed(1)} units
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}
