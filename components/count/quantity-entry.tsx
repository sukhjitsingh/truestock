"use client";

import { useEffect, useState } from "react";
import { cn, formatUnits } from "@/lib/utils";
import { isCountedByCase } from "@/lib/pack-level";
import { hasUnsavedQuantity } from "@/lib/entry-drafts";
import { describeAddedUnits, describeUnitDelta } from "@/lib/quantity-summary";
import { Button } from "@/components/ui/button";

export type QuantityMode = "add" | "set";

export interface QuantitySubmission {
  mode: QuantityMode;
  cases: number;
  eaches: number;
}

export interface QuantityEntryProps {
  productId?: number;
  productName?: string;
  currentCases?: number;
  currentEaches?: number;
  existingCaseQty?: number;
  existingEachQty?: number;
  caseSize?: number | null;
  category?: string;
  unitType?: string;
  canSet?: boolean;
  canSeeCost?: boolean;
  unitCost?: number | string | null;
  pending?: boolean;
  onCommitQuantity?: (delta: {
    caseQty: number;
    eachQty: number;
    mode: "add" | "set";
  }) => Promise<void> | void;
  onSubmit?: (submission: QuantitySubmission) => Promise<void> | void;
  /**
   * Reports whether anything typed here is still unsaved, so the entry screen
   * can refuse to unmount this editor (and discard it) behind the user's back.
   */
  onDirtyChange?: (dirty: boolean) => void;
  onCancel: () => void;
}

function clampInt(v: string | number): number {
  const n = typeof v === "number" ? v : parseInt(v, 10);
  return isNaN(n) || n < 0 ? 0 : Math.floor(n);
}

/**
 * Sealed Backstock Stepper & Quantity Entry (spec §6, prototypes/count-sealed-qty.html)
 *
 * Enforces:
 * 1. 56px primary tap floor on steppers, mode toggles, and commit buttons.
 * 2. Independent Cases and Loose Eaches storage and counting (Invariant 4).
 * 3. Pack multipliers (e.g. × 12 per case).
 * 4. Live consequence deltas on submit button (e.g. `SET TO 3 EA / was 12 ea · −9` or `ADD 3 EA / 12 → 15`).
 * 5. Negative number disallowance (`clampInt >= 0`).
 * 6. Role-gated value display on submit button (design-system.md §8).
 */
export function QuantityEntry({
  currentCases: propCurrentCases,
  currentEaches: propCurrentEaches,
  existingCaseQty,
  existingEachQty,
  caseSize = null,
  category = "Spirits",
  unitType = "bottle",
  canSet = true,
  canSeeCost = false,
  unitCost = null,
  pending = false,
  onCommitQuantity,
  onSubmit,
  onDirtyChange,
  onCancel,
}: QuantityEntryProps) {
  const initialCases = propCurrentCases ?? existingCaseQty ?? 0;
  const initialEaches = propCurrentEaches ?? existingEachQty ?? 0;

  const [mode, setMode] = useState<QuantityMode>("add");
  // Each mode keeps its OWN inputs. Toggling Add -> Set -> Add used to zero the
  // numbers typed in the first mode, so one stray tap on the tab bar threw away
  // a half-entered quantity with nothing on screen saying so.
  const [addInputs, setAddInputs] = useState({ cases: 0, eaches: 0 });
  // `null` = untouched: SET starts from the line's recorded numbers and follows
  // them until the counter types, rather than snapshotting them at toggle time.
  const [setInputs, setSetInputs] = useState<{ cases: number | null; eaches: number | null }>({
    cases: null,
    eaches: null,
  });

  const caseInput = mode === "add" ? addInputs.cases : (setInputs.cases ?? initialCases);
  const eachInput = mode === "add" ? addInputs.eaches : (setInputs.eaches ?? initialEaches);
  const updateCases = (n: number) =>
    mode === "add"
      ? setAddInputs((p) => ({ ...p, cases: n }))
      : setSetInputs((p) => ({ ...p, cases: n }));
  const updateEaches = (n: number) =>
    mode === "add"
      ? setAddInputs((p) => ({ ...p, eaches: n }))
      : setSetInputs((p) => ({ ...p, eaches: n }));

  // Dirty means EITHER mode holds input — including the one not on screen,
  // because it comes back when the tab is toggled.
  const dirty =
    hasUnsavedQuantity({
      mode: "add",
      cases: addInputs.cases,
      eaches: addInputs.eaches,
      initialCases,
      initialEaches,
    }) ||
    hasUnsavedQuantity({
      mode: "set",
      cases: setInputs.cases ?? initialCases,
      eaches: setInputs.eaches ?? initialEaches,
      initialCases,
      initialEaches,
    });
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const countsByCase = isCountedByCase({ category, unitType });

  const cases = countsByCase ? caseInput : 0;
  const eaches = eachInput;

  const nextCases = mode === "add" ? initialCases + cases : cases;
  const nextEaches = mode === "add" ? initialEaches + eaches : eaches;

  const describe = (c: number, e: number) => {
    const parts: string[] = [];
    if (c > 0) parts.push(`${c} ${c === 1 ? "case" : "cases"}`);
    if (e > 0 || parts.length === 0) parts.push(`${e} ea`);
    return parts.join(", ");
  };

  const describeAfter = (c: number, e: number) => {
    const parts: string[] = [];
    if (c > 0 || initialCases > 0) parts.push(`${c} ${c === 1 ? "case" : "cases"}`);
    if (e > 0 || initialEaches > 0 || parts.length === 0) parts.push(`${e} ea`);
    return parts.join(", ");
  };

  // Units calculations
  const unitsKnown = caseSize != null || nextCases === 0;
  const nextUnits = unitsKnown ? nextCases * (caseSize ?? 0) + nextEaches : null;
  const currentUnits =
    caseSize != null || initialCases === 0
      ? initialCases * (caseSize ?? 0) + initialEaches
      : null;

  const unitDelta =
    nextUnits != null && currentUnits != null ? nextUnits - currentUnits : null;

  // Valuation calculations
  const numericUnitCost =
    typeof unitCost === "number"
      ? unitCost
      : unitCost != null && !isNaN(Number(unitCost))
        ? Number(unitCost)
        : null;
  const isPriced = canSeeCost && numericUnitCost != null;
  const totalValue = isPriced && numericUnitCost != null && nextUnits != null ? nextUnits * numericUnitCost : null;

  const handleModeChange = (nextMode: QuantityMode) => setMode(nextMode);

  const handleCommit = async () => {
    if (onSubmit) {
      await onSubmit({ mode, cases, eaches });
    } else if (onCommitQuantity) {
      await onCommitQuantity({
        caseQty: cases,
        eachQty: eaches,
        mode,
      });
    }
  };

  const nothingEntered = mode === "add" && cases === 0 && eaches === 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Mode Segmented Switcher — 56px Primary Floor */}
      {canSet ? (
        <div
          role="tablist"
          aria-label="Entry mode"
          className="grid grid-cols-2 gap-1 rounded-md border border-input bg-muted p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "add"}
            onClick={() => handleModeChange("add")}
            className={cn(
              "flex min-h-tap-primary items-center justify-center rounded-sm text-label font-bold uppercase tracking-wider transition-colors",
              mode === "add"
                ? "bg-accent text-accent-foreground shadow-sm"
                : "bg-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            Add (+)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "set"}
            onClick={() => handleModeChange("set")}
            className={cn(
              "flex min-h-tap-primary items-center justify-center rounded-sm px-2 text-center text-label font-bold uppercase tracking-wider transition-colors",
              mode === "set"
                ? "bg-accent text-accent-foreground shadow-sm"
                : "bg-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            Set exact count (=)
          </button>
        </div>
      ) : null}

      {/* Current Recorded Line Context */}
      <div className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground">
        {mode === "add" ? (
          <>
            Currently recorded on this line:{" "}
            <strong className="text-foreground">
              {describe(initialCases, initialEaches)}
            </strong>
            {currentUnits != null ? ` (${formatUnits(currentUnits)} units)` : ""}. This adds
            more on top.
          </>
        ) : (
          <>
            Correction mode: this <strong className="text-foreground">replaces</strong> the
            line total outright. Dial it to the true count on the shelf.
          </>
        )}
      </div>

      {/* Steppers Grid (Cases & Eaches). Stacked on phones: side by side, each
          card is ~175px wide and the two 56px buttons leave the number input a
          sliver too narrow to read or tap. */}
      <div className={cn("grid gap-3", countsByCase ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1")}>
        {countsByCase ? (
          <StepperCard
            label="Cases"
            value={caseInput}
            onChange={(v) => updateCases(clampInt(v))}
            hint={caseSize != null ? `× ${caseSize} per case` : "No case size on file"}
          />
        ) : null}
        <StepperCard
          label="Eaches"
          value={eachInput}
          onChange={(v) => updateEaches(clampInt(v))}
          hint={countsByCase ? "Loose bottles, not part of a case" : "Sealed bottles / units"}
        />
      </div>

      {/* Reference Summary */}
      <div className="rounded-lg border border-border bg-muted p-card-pad">
        <div className="flex items-baseline justify-between">
          <span className="text-caption text-muted-foreground">
            {mode === "add" ? "This write adds" : "Correction delta"}
          </span>
          <span className="text-numeral-sm font-semibold tabular-nums text-foreground">
            {mode === "add"
              ? describeAddedUnits({ cases, eaches, caseSize })
              : describeUnitDelta(unitDelta)}
          </span>
        </div>
        <div className="mt-1 flex items-baseline justify-between">
          <span className="text-caption text-muted-foreground">Line total after save</span>
          <span className="text-numeral-sm font-semibold tabular-nums text-foreground">
            {describeAfter(nextCases, nextEaches)}
            {nextUnits != null ? ` (${formatUnits(nextUnits)} units)` : ""}
          </span>
        </div>
        <p className="mt-2 text-caption text-muted-foreground">
          Cases and eaches are stored separately and never merged.
        </p>
      </div>

      {/* Bottom Action Bar — 56px Floor */}
      <div className="flex gap-3">
        <Button
          type="button"
          variant="outline"
          size="primary"
          className="flex-1"
          onClick={onCancel}
        >
          Cancel
        </Button>

        <button
          type="button"
          disabled={pending || nothingEntered}
          onClick={() => void handleCommit()}
          className={cn(
            "flex min-h-tap-primary flex-[1.5] flex-col items-center justify-center rounded-md bg-primary px-3 text-primary-foreground shadow-sm transition-opacity disabled:opacity-50",
            totalValue != null ? "gap-0.5 py-1.5" : "",
          )}
        >
          {/* Each part wraps as a unit: in the narrow half-width button "SAVE
              CORRECTION" and its "(11 EA)" otherwise broke mid-phrase and left
              the figure floating beside the label. */}
          <span className="flex flex-wrap items-baseline justify-center gap-x-1 text-center">
            <span className="whitespace-nowrap text-label uppercase">{mode === "add" ? "Save" : "Save correction"}</span>
            <span className="whitespace-nowrap text-numeral-sm uppercase tabular-nums">
              {mode === "add" ? `(${describe(cases, eaches)})` : `(${describeAfter(cases, eaches)})`}
            </span>
          </span>

          <span className="text-caption tabular-nums text-primary-foreground/75">
            {mode === "add"
              ? `${describe(initialCases, initialEaches)} → ${describe(nextCases, nextEaches)}`
              : `was ${describe(initialCases, initialEaches)}${
                  unitDelta != null
                    ? ` · ${unitDelta >= 0 ? "+" : "−"}${formatUnits(Math.abs(unitDelta))}`
                    : ""
                }`}
          </span>
          {totalValue != null ? (
            <span className="text-numeral-sm tabular-nums text-primary-foreground">
              ${totalValue.toFixed(2)}
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

function StepperCard({
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
      <label htmlFor={id} className="block text-label uppercase text-muted-foreground">
        {label}
      </label>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          aria-label={`Decrease ${label.toLowerCase()}`}
          onClick={() => onChange(clampInt(value - 1))}
          className="flex size-tap-primary shrink-0 items-center justify-center rounded-md border border-input bg-secondary text-numeral-md font-bold text-foreground transition-colors active:bg-muted"
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
          onChange={(e) => onChange(clampInt(e.target.value))}
          className="min-w-0 flex-1 rounded-md border border-input bg-background py-2 text-center text-numeral-md font-bold tabular-nums text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="button"
          aria-label={`Increase ${label.toLowerCase()}`}
          onClick={() => onChange(clampInt(value + 1))}
          className="flex size-tap-primary shrink-0 items-center justify-center rounded-md border border-input bg-secondary text-numeral-md font-bold text-foreground transition-colors active:bg-muted"
        >
          +
        </button>
      </div>
      <p className="mt-2 text-caption text-muted-foreground">{hint}</p>
    </div>
  );
}
