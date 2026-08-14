"use client";

import { useState } from "react";
import { cn, formatUnits } from "@/lib/utils";
import { isCountedByCase } from "@/lib/pack-level";
import { Button } from "@/components/ui/button";

export type QuantityMode = "add" | "set";

export interface QuantitySubmission {
  mode: QuantityMode;
  cases: number;
  eaches: number;
}

/**
 * Sealed-quantity entry for one product on one line.
 *
 * ADD and SET take the same numbers in the same boxes, and afterwards the
 * line reads "3 ea" either way — so a SET the user meant as an ADD loses
 * bottles with nothing on screen looking wrong. CLAUDE.md's answer is that
 * the submit button states the consequence as they type, and that there is
 * deliberately NO confirmation modal: a dialog on a control used ~150 times
 * per count gets clicked through blind inside a week, which is worse than no
 * guard because it feels like one.
 *
 * Cases and eaches stay separate all the way through (invariant 4). The
 * combined unit figure shown below the fields is reference only and is never
 * what gets written.
 *
 * Only bottled beer gets a Cases box (`isCountedByCase`). Rendering one for a
 * spirit hinting "No case size on file" invites a number into a field the
 * catalog leaves NULL on purpose — and a case count on a product with no case
 * size is the one input `computeLineUnits` cannot resolve, so it would take
 * the line out of the valuation entirely. Case entry for spirits is deferred
 * to Phase 2.0.
 */
export function QuantityEntry({
  currentCases,
  currentEaches,
  caseSize,
  category,
  unitType,
  canSet,
  pending,
  onSubmit,
  onCancel,
}: {
  currentCases: number;
  currentEaches: number;
  /** Snapshot case size, if known. Null is normal — most of the catalog has none. */
  caseSize: number | null;
  /**
   * The product's identity, not a `showCases` boolean, so `isCountedByCase`
   * stays the single definition of what a case is. A boolean prop would let a
   * caller answer the question a second way, which is the drift
   * lib/pack-level.ts exists to prevent.
   */
  category: string;
  unitType: string;
  /**
   * SET maps to `setCountLineQuantitiesAction`, which needs an existing
   * count line. A product not yet on this count can only be ADDed.
   */
  canSet: boolean;
  pending?: boolean;
  onSubmit: (submission: QuantitySubmission) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<QuantityMode>("add");
  const [caseInput, setCaseInput] = useState(0);
  const [eaches, setEaches] = useState(0);

  const countsByCase = isCountedByCase({ category, unitType });

  /**
   * Zero when there is no Cases box, derived rather than zeroed at the
   * `onSubmit` call. Everything downstream — the consequence line, the unit
   * figure, the disabled test — then reads the same number the server gets,
   * so the button cannot promise a case the write does not make. Clearing the
   * state instead would leave that gap open for one render, and would depend
   * on an effect firing.
   */
  const cases = countsByCase ? caseInput : 0;

  const nextCases = mode === "add" ? currentCases + cases : cases;
  const nextEaches = mode === "add" ? currentEaches + eaches : eaches;

  const describe = (c: number, e: number) => {
    const parts: string[] = [];
    if (c > 0) parts.push(`${c} ${c === 1 ? "case" : "cases"}`);
    if (e > 0 || parts.length === 0) parts.push(`${e} ea`);
    return parts.join(", ");
  };

  /**
   * The same, for the AFTER side of a SET, where either count falling to
   * zero is precisely what has to be said out loud. `describe` drops a zero
   * case count AND drops a zero each count whenever the other part is
   * present, so a line already carrying both would go from "2 cases, 3 ea"
   * to "3 ea" (cases dropped) or from "1 case, 12 ea" to "1 case" (eaches
   * dropped) — either way the loss reads as formatting, not as data going to
   * zero. That is the SET-mistaken-for-ADD failure wearing a different hat.
   * The guard is per axis, not one combined special case, because cases and
   * eaches fall to zero independently: a case-only SET zeroes loose bottles
   * without touching cases, and a bottled-beer product with cases already
   * on the line can have either wiped on its own.
   */
  const describeAfter = (c: number, e: number) => {
    const parts: string[] = [];
    // Each axis is guarded on its own condition, not folded into one
    // combined check, because cases and eaches reach zero independently — a
    // case-only SET wipes loose bottles without touching cases, and either
    // one can be the count that was already sitting on the line.
    if (c > 0 || currentCases > 0) parts.push(`${c} ${c === 1 ? "case" : "cases"}`);
    if (e > 0 || currentEaches > 0 || parts.length === 0) parts.push(`${e} ea`);
    return parts.join(", ");
  };

  // Units are only computable when a case size is known — or when there are
  // no cases at all, where "zero cases of an unknown size" is unambiguously
  // zero (lib/domain/valuation.ts). Never guess a case size to fill this in.
  const unitsKnown = caseSize != null || nextCases === 0;
  const nextUnits = unitsKnown ? nextCases * (caseSize ?? 0) + nextEaches : null;
  const currentUnits =
    caseSize != null || currentCases === 0
      ? currentCases * (caseSize ?? 0) + currentEaches
      : null;

  const nothingEntered = cases === 0 && eaches === 0;

  return (
    <div className="flex flex-col gap-4">
      {canSet ? (
        <div
          role="tablist"
          aria-label="Entry mode"
          className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1"
        >
          {(["add", "set"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "min-h-tap-primary rounded-sm text-label uppercase",
                // Brand blue marks the selected segment. design-system.md §3
                // sanctions accent for selected states in forms and nav —
                // this is a UI mode, not a stock status, so amber (which
                // would read as "in progress") is deliberately avoided.
                mode === m
                  ? "bg-accent text-accent-foreground"
                  : "bg-transparent text-muted-foreground",
              )}
            >
              {m === "add" ? "Add (+)" : "Set exact (=)"}
            </button>
          ))}
        </div>
      ) : null}

      {/*
        Deliberately reports `currentCases` even where the Cases box is
        hidden. Hiding the input must not hide cases the line already holds —
        an invisible real number is worse than a field nobody should type in.
      */}
      <p className="text-caption text-muted-foreground">
        {canSet ? (
          <>
            Already on this line: <strong className="text-foreground">
              {describe(currentCases, currentEaches)}
            </strong>
            {currentUnits != null ? ` (${formatUnits(currentUnits)} units)` : ""}.
          </>
        ) : (
          "Not on this count yet — this creates the line."
        )}
      </p>

      {/*
        One column when there are no cases, so eaches is the input rather than
        the left-hand half of a grid with a hole in it. A dim bar and one free
        hand do not need a layout that reads as something failing to load.
      */}
      <div className={cn("grid gap-3", countsByCase ? "grid-cols-2" : "grid-cols-1")}>
        {countsByCase ? (
          <Stepper
            label="Cases"
            value={caseInput}
            onChange={setCaseInput}
            hint={caseSize != null ? `× ${caseSize} per case` : "No case size on file"}
          />
        ) : null}
        <Stepper
          label="Eaches"
          value={eaches}
          onChange={setEaches}
          hint={countsByCase ? "Loose bottles, not part of a case" : "Sealed bottles"}
        />
      </div>

      <div className="flex gap-3">
        <Button variant="outline" size="primary" className="flex-1" onClick={onCancel}>
          Cancel
        </Button>

        {/*
          The consequence, stated live. Two lines: what will happen, and what
          it does to the line. No modal — see the component doc above.
        */}
        <button
          type="button"
          disabled={pending || nothingEntered}
          onClick={() => onSubmit({ mode, cases, eaches })}
          className="flex min-h-tap-primary flex-[1.4] flex-col items-center justify-center gap-0.5 rounded-md bg-primary px-2 text-primary-foreground disabled:opacity-50"
        >
          <span className="flex items-baseline gap-1">
            <span className="text-label uppercase">{mode === "add" ? "Add" : "Set to"}</span>
            <span className="text-numeral-sm uppercase tabular-nums">
              {mode === "add" ? describe(cases, eaches) : describeAfter(cases, eaches)}
            </span>
          </span>
          <span className="text-caption tabular-nums text-primary-foreground/70">
            {mode === "add"
              ? `${describe(currentCases, currentEaches)} → ${describe(nextCases, nextEaches)}`
              : `was ${describe(currentCases, currentEaches)}${
                  currentUnits != null && nextUnits != null
                    ? ` · ${nextUnits >= currentUnits ? "+" : "−"}${formatUnits(
                        Math.abs(nextUnits - currentUnits),
                      )}`
                    : ""
                }`}
          </span>
        </button>
      </div>
    </div>
  );
}

function Stepper({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  hint: string;
}) {
  const id = `qty-${label.toLowerCase()}`;
  return (
    <div className="rounded-lg border border-border bg-card p-card-pad">
      <span className="text-label uppercase text-muted-foreground">{label}</span>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          aria-label={`Decrease ${label.toLowerCase()}`}
          onClick={() => onChange(Math.max(0, value - 1))}
          className="flex size-14 shrink-0 items-center justify-center rounded-md border border-input text-numeral-md text-foreground active:bg-muted"
        >
          –
        </button>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          aria-label={label}
          value={value}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-2 text-center text-numeral-md tabular-nums text-foreground"
        />
        <button
          type="button"
          aria-label={`Increase ${label.toLowerCase()}`}
          onClick={() => onChange(value + 1)}
          className="flex size-14 shrink-0 items-center justify-center rounded-md border border-input text-numeral-md text-foreground active:bg-muted"
        >
          +
        </button>
      </div>
      <p className="mt-2 text-caption text-muted-foreground">{hint}</p>
    </div>
  );
}
