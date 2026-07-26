"use client";

import { useState } from "react";
import { cn, formatUnits } from "@/lib/utils";
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
 */
export function QuantityEntry({
  currentCases,
  currentEaches,
  caseSize,
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
   * SET maps to `setCountLineQuantitiesAction`, which needs an existing
   * count line. A product not yet on this count can only be ADDed.
   */
  canSet: boolean;
  pending?: boolean;
  onSubmit: (submission: QuantitySubmission) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<QuantityMode>("add");
  const [cases, setCases] = useState(0);
  const [eaches, setEaches] = useState(0);

  const nextCases = mode === "add" ? currentCases + cases : cases;
  const nextEaches = mode === "add" ? currentEaches + eaches : eaches;

  const describe = (c: number, e: number) => {
    const parts: string[] = [];
    if (c > 0) parts.push(`${c} ${c === 1 ? "case" : "cases"}`);
    if (e > 0 || parts.length === 0) parts.push(`${e} ea`);
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
                "min-h-tap-min rounded-sm text-label uppercase",
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

      <div className="grid grid-cols-2 gap-3">
        <Stepper
          label="Cases"
          value={cases}
          onChange={setCases}
          hint={caseSize != null ? `× ${caseSize} per case` : "No case size on file"}
        />
        <Stepper
          label="Eaches"
          value={eaches}
          onChange={setEaches}
          hint="Loose bottles, not part of a case"
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
          <span className="text-label uppercase">
            {mode === "add"
              ? `Add ${describe(cases, eaches)}`
              : `Set to ${describe(cases, eaches)}`}
          </span>
          <span className="text-caption tabular-nums opacity-80">
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
          className="flex size-11 shrink-0 items-center justify-center rounded-md border border-input text-numeral-sm text-foreground"
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
          className="flex size-11 shrink-0 items-center justify-center rounded-md border border-input text-numeral-sm text-foreground"
        >
          +
        </button>
      </div>
      <p className="mt-2 text-caption text-muted-foreground">{hint}</p>
    </div>
  );
}
