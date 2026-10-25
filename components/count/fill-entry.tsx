"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { cn, formatUnits } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { VialDisplay } from "@/components/count/vial-display";
import { fillsEqual } from "@/lib/fill-save";

const TENTHS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

export interface FillEntryProps {
  productId?: number;
  productName: string;
  sizeMl?: number | null;
  unitType?: "bottle" | "keg" | "can" | "pack" | string;
  locationName?: string;
  existingFills: number[];
  /** True once the line exists server-side. */
  canCorrect?: boolean;
  canSeeCost?: boolean;
  unitCost?: number | string | null;
  pending?: boolean;
  /** Primary save callback passing all confirmed fill fractions [0.0 - 1.0] */
  onSaveFills?: (fills: number[]) => Promise<void> | void;
  /** Backwards-compatible aliases */
  onSubmit?: (newFills: number[]) => Promise<void> | void;
  onCorrect?: (allFills: number[]) => Promise<void> | void;
  onCancel: () => void;
}

/**
 * Liquid Vial Simulation & Tenths Keypad (spec §6, prototypes/count-fill-tenths.html)
 *
 * Enforces:
 * 1. 56px primary tap floor on keypad, presets, and commit actions.
 * 2. Continuous fluid vial visualization (`VialDisplay`) with fluid gradient transitions.
 * 3. Discrete tenths keypad (.1 - 1.0) and rapid presets (Full, Half, Empty).
 * 4. Multi-bottle partial fills chip list allowing adding new bottles, selecting/inspecting
 *    individual bottles, editing levels, and removing bottles.
 * 5. Keg volume derivation: tenths fraction × size_ml (e.g. 0.7 × 58674 = 41072 mL).
 * 6. Role-gated single-line vs two-line save button (design-system.md §8).
 */
export function FillEntry({
  sizeMl,
  unitType = "bottle",
  existingFills,
  canSeeCost = false,
  unitCost = null,
  pending = false,
  onSaveFills,
  onSubmit,
  onCorrect,
  onCancel,
}: FillEntryProps) {
  // Staged fills array representing all open containers on this line
  const [fills, setFills] = useState<number[]>(() => [...existingFills]);
  // Current draft level in the vial/keypad editor (0.0 to 1.0). `null` means
  // nobody has chosen a level yet, and it stays that way until they do: a
  // preselected 50% is a plausible-but-wrong default (AGENTS.md) — one tap of
  // "+ Add bottle" would record a half-full bottle nobody looked at.
  const [draftValue, setDraftValue] = useState<number | null>(null);
  // activeIndex === null means editing a new bottle observation; number means editing an existing bottle chip
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const isKeg = unitType === "keg";

  // Derive total units and milliliters
  const totalUnits = fills.reduce((sum, f) => sum + f, 0);
  const totalMl = isKeg && sizeMl ? Math.round(totalUnits * sizeMl) : null;
  const numericUnitCost =
    typeof unitCost === "number"
      ? unitCost
      : unitCost != null && !isNaN(Number(unitCost))
        ? Number(unitCost)
        : null;
  const isPriced = canSeeCost && numericUnitCost != null;
  const lineValue = isPriced && numericUnitCost != null ? totalUnits * numericUnitCost : null;

  const handleSetDraft = (v: number) => {
    const clamped = Math.max(0, Math.min(1, Math.round(v * 10) / 10));
    setDraftValue(clamped);
  };

  const handleAddBottleToLine = () => {
    if (draftValue == null) return;
    setFills((prev) => [...prev, draftValue]);
    setDraftValue(null);
  };

  const handleUpdateActiveBottle = () => {
    if (activeIndex == null || draftValue == null) return;
    setFills((prev) => {
      const next = [...prev];
      next[activeIndex] = draftValue;
      return next;
    });
    setActiveIndex(null);
    setDraftValue(null);
  };

  const handleRemoveActiveBottle = () => {
    if (activeIndex == null) return;
    setFills((prev) => prev.filter((_, i) => i !== activeIndex));
    setActiveIndex(null);
    setDraftValue(null);
  };

  const handleRemoveBottleAtIndex = (index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setFills((prev) => prev.filter((_, i) => i !== index));
    if (activeIndex === index) {
      setActiveIndex(null);
      setDraftValue(null);
    } else if (activeIndex !== null && activeIndex > index) {
      setActiveIndex(activeIndex - 1);
    }
  };

  const handleSelectBottleChip = (index: number) => {
    setActiveIndex(index);
    setDraftValue(fills[index] ?? null);
  };

  const handleCommitSave = async () => {
    if (onSaveFills) {
      await onSaveFills(fills);
    } else if (onCorrect) {
      await onCorrect(fills);
    } else if (onSubmit) {
      await onSubmit(fills);
    }
  };

  const percent = draftValue == null ? null : Math.round(draftValue * 100);
  // Nothing to save until the staged list differs from what is already on the
  // line. Seeded with the existing fills, an untouched editor would otherwise
  // offer a Save that re-sends them.
  const changed = !fillsEqual(existingFills, fills);

  return (
    <div className="flex flex-col gap-5">
      {/* Editor Section */}
      <div className="rounded-lg border border-border bg-card p-card-pad">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-label uppercase text-muted-foreground">
            {activeIndex === null
              ? "Setting fill level — new bottle"
              : `Editing bottle #${activeIndex + 1}`}
          </span>
          {activeIndex !== null ? (
            <button
              type="button"
              onClick={() => {
                setActiveIndex(null);
                setDraftValue(null);
              }}
              className="text-caption font-medium text-accent underline"
            >
              + New bottle
            </button>
          ) : null}
        </div>

        {/* Big Numeral Display */}
        <div className="mb-4 text-center">
          <div className="text-numeral-lg text-foreground">
            {percent == null ? "—" : `${percent}%`}
          </div>
          <div className="mt-1 text-caption text-muted-foreground">
            {draftValue == null
              ? "Tap a level below"
              : `${draftValue.toFixed(1)} ${isKeg ? "of a keg" : "of a bottle"}${
                  isKeg && sizeMl
                    ? ` (≈ ${Math.round(draftValue * sizeMl).toLocaleString()} mL)`
                    : ""
                }`}
          </div>
        </div>

        {/* Liquid Vial Simulation Visualizer */}
        <div className="mb-4">
          <VialDisplay
            value={draftValue ?? 0}
            onChange={handleSetDraft}
            disabled={pending}
          />
        </div>

        {/* Quick Preset Buttons (Full / Half / Empty) — 56px Primary Floor */}
        <div className="grid grid-cols-3 gap-2.5">
          {[
            { label: "Full", value: 1.0 },
            { label: "Half", value: 0.5 },
            { label: "Empty", value: 0.0 },
          ].map((preset) => {
            const isActive = draftValue === preset.value;
            return (
              <button
                key={preset.label}
                type="button"
                disabled={pending}
                onClick={() => handleSetDraft(preset.value)}
                className={cn(
                  "flex min-h-tap-primary items-center justify-center rounded-md border text-body font-semibold uppercase tracking-wider transition-colors",
                  isActive
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-secondary text-foreground active:bg-muted",
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        {/* Discrete Tenths Keypad (.1 through 1.0) — 56px Primary Floor */}
        <div className="mt-3">
          <span className="mb-2 block text-label uppercase text-muted-foreground">
            Or tap a tenth
          </span>
          <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
            {TENTHS.map((t) => {
              const isActive = draftValue === t;
              return (
                <button
                  key={t}
                  type="button"
                  disabled={pending}
                  onClick={() => handleSetDraft(t)}
                  aria-label={`${Math.round(t * 100)} percent full`}
                  className={cn(
                    "flex min-h-tap-primary items-center justify-center rounded-md border text-numeral-sm tabular-nums transition-colors",
                    isActive
                      ? "border-accent bg-accent text-accent-foreground font-bold"
                      : "border-input bg-card text-foreground hover:bg-muted active:bg-muted",
                  )}
                >
                  {t === 1.0 ? "1.0" : t.toFixed(1).replace(/^0/, "")}
                </button>
              );
            })}
          </div>
        </div>

        {/* Stage / Update Row */}
        <div className="mt-4 flex gap-2.5">
          {activeIndex === null ? (
            <Button
              type="button"
              variant="primary"
              size="primary"
              className="w-full text-label uppercase"
              disabled={pending || draftValue == null}
              onClick={handleAddBottleToLine}
            >
              {percent == null ? "+ Add bottle to line" : `+ Add bottle to line (${percent}%)`}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="destructive"
                size="primary"
                className="flex-1 text-label uppercase"
                disabled={pending}
                onClick={handleRemoveActiveBottle}
              >
                Remove
              </Button>
              <Button
                type="button"
                variant="primary"
                size="primary"
                className="flex-[1.5] text-label uppercase"
                disabled={pending || draftValue == null}
                onClick={handleUpdateActiveBottle}
              >
                Update bottle #{activeIndex + 1}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Multi-Bottle Partial Fills Chip List Section */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-label uppercase text-muted-foreground">
            Open on this line
          </span>
          <span className="text-caption text-muted-foreground">
            {fills.length} {fills.length === 1 ? (isKeg ? "keg" : "bottle") : isKeg ? "kegs" : "bottles"}
          </span>
        </div>

        {fills.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-card-pad text-center">
            <p className="text-row-subtitle text-muted-foreground">
              No open bottles recorded yet. Adjust level and tap &ldquo;+ Add bottle to line&rdquo;.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {fills.map((f, i) => {
              const isSelected = activeIndex === i;
              return (
                <div
                  key={i}
                  className={cn(
                    "flex min-h-tap-primary items-center justify-between gap-3 rounded-lg border bg-card px-card-pad transition-colors",
                    isSelected ? "border-accent ring-1 ring-accent" : "border-border",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSelectBottleChip(i)}
                    className="flex min-h-tap-primary flex-1 items-center gap-3 text-left focus-visible:outline-none"
                    aria-label={`Inspect bottle ${i + 1}: ${Math.round(f * 100)} percent full`}
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-caption font-bold text-muted-foreground">
                      {i + 1}
                    </span>
                    <span className="text-numeral-sm font-semibold text-card-foreground">
                      {Math.round(f * 100)}% full
                      <span className="ml-2 text-caption font-normal text-muted-foreground">
                        ({f.toFixed(1)} ea{isKeg && sizeMl ? ` ≈ ${Math.round(f * sizeMl).toLocaleString()} mL` : ""})
                      </span>
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={(e) => handleRemoveBottleAtIndex(i, e)}
                    aria-label={`Remove bottle ${i + 1}`}
                    className="flex size-tap-min shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="size-5" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Line Summary & Keg Totals */}
        <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
          <span className="text-caption text-muted-foreground">Total open</span>
          <span className="text-numeral-sm font-semibold text-foreground">
            {formatUnits(totalUnits)} units
            {isKeg && totalMl ? ` ≈ ${totalMl.toLocaleString()} mL` : ""}
          </span>
        </div>

        {canSeeCost && unitCost == null ? (
          <p className="mt-1 text-caption text-muted-foreground">
            No cost on file — excluded from valuation
          </p>
        ) : null}
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
          disabled={pending || !changed}
          onClick={() => void handleCommitSave()}
          className={cn(
            "flex min-h-tap-primary flex-[1.5] flex-col items-center justify-center rounded-md bg-primary px-3 text-primary-foreground shadow-sm transition-opacity disabled:opacity-50",
            lineValue != null ? "gap-0.5 py-1.5" : "",
          )}
        >
          <span className="text-label uppercase">Save fill levels</span>
          {lineValue != null ? (
            <span className="text-numeral-sm tabular-nums text-primary-foreground">
              ${lineValue.toFixed(2)}
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}
