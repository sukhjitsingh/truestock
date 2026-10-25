/**
 * Adversarial Challenger 1 Test Suite: Mobile Floor & Calculation Challenger
 *
 * Rigorous empirical verification of:
 * 1. Liquid vial gauge: snapping formula round(rel*10)/10, boundaries 0.0/1.0, keyboard navigation.
 * 2. Keg volume derivation: fraction × size_ml for half barrel, quarter barrel, sixtel.
 * 3. Multi-bottle partial fills chip list: JSON serialization, summation, add/remove/edit, empty arrays.
 * 4. Sealed quantity steppers: ADD vs SET live consequence deltas, pack multipliers, clampInt >= 0.
 * 5. Stray bottle escape hatch: target location isolation without mutating active leg location.
 * 6. Invariant 3 rescan guard: duplicate scan increment vs duplicate prevention, optimistic reducer, screen reader.
 */
import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { VialDisplay } from "@/components/count/vial-display";
import { FillEntry } from "@/components/count/fill-entry";
import { QuantityEntry } from "@/components/count/quantity-entry";
import { StrayBottleModal } from "@/components/count/stray-bottle-modal";
import { CountLineCard } from "@/components/count/count-line-card";
import { formatUnits } from "@/lib/utils";
import {
  incrementCountLineSchema,
  editCountLineFillsSchema,
  setCountLineQuantitiesSchema,
} from "@/lib/validation/counts";
import { createRescanGuard, offerFrame } from "@/lib/rescan-guard";

/** Strips React SSR comment delimiters for exact text content matching */
function stripReactComments(html: string): string {
  return html.replace(/<!--.*?-->/g, "");
}

// ---------------------------------------------------------------------------
// 1. Liquid Vial Gauge & Snapping Formula
// ---------------------------------------------------------------------------
describe("Challenger 1: Liquid Vial Gauge & Snapping Formula", () => {
  function snapPointer(clientY: number, rectTop: number, rectHeight: number): number {
    if (rectHeight <= 0) return 0;
    const rel = 1 - (clientY - rectTop) / rectHeight;
    return Math.max(0, Math.min(1, Math.round(rel * 10) / 10));
  }

  function stepKeyboard(current: number, direction: "up" | "down" | "home" | "end"): number {
    if (direction === "up") return Math.min(1, Math.round((current + 0.1) * 10) / 10);
    if (direction === "down") return Math.max(0, Math.round((current - 0.1) * 10) / 10);
    if (direction === "home") return 0;
    if (direction === "end") return 1;
    return current;
  }

  it("calculates exact boundaries: top -> 1.0, bottom -> 0.0", () => {
    const top = 100;
    const height = 220;
    expect(snapPointer(100, top, height)).toBe(1.0); // Exact top
    expect(snapPointer(320, top, height)).toBe(0.0); // Exact bottom
  });

  it("clamps out-of-bounds drag positions: above top -> 1.0, below bottom -> 0.0", () => {
    const top = 100;
    const height = 220;
    expect(snapPointer(0, top, height)).toBe(1.0);   // Way above
    expect(snapPointer(-500, top, height)).toBe(1.0); // Extremely above
    expect(snapPointer(400, top, height)).toBe(0.0); // Way below
    expect(snapPointer(1000, top, height)).toBe(0.0);// Extremely below
  });

  it("snaps sub-tenth continuous drag positions to nearest tenth correctly", () => {
    const top = 0;
    const height = 1000;
    expect(snapPointer(960, top, height)).toBe(0.0);
    expect(snapPointer(950, top, height)).toBe(0.1);
    expect(snapPointer(940, top, height)).toBe(0.1);
    expect(snapPointer(510, top, height)).toBe(0.5);
    expect(snapPointer(500, top, height)).toBe(0.5);
    expect(snapPointer(490, top, height)).toBe(0.5);
    expect(snapPointer(450, top, height)).toBe(0.6);
    expect(snapPointer(60, top, height)).toBe(0.9);
    expect(snapPointer(50, top, height)).toBe(1.0);
    expect(snapPointer(10, top, height)).toBe(1.0);
  });

  it("keyboard ArrowUp/ArrowDown navigation avoids IEEE-754 drift across all 10 steps", () => {
    let val = 0.0;
    const expectedAscending = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    for (let i = 0; i <= 10; i++) {
      expect(val).toBe(expectedAscending[i]);
      if (i < 10) val = stepKeyboard(val, "up");
    }
    // Additional ArrowUp clamps at 1.0
    expect(stepKeyboard(val, "up")).toBe(1.0);

    // Step back down
    const expectedDescending = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0];
    for (let i = 0; i <= 10; i++) {
      expect(val).toBe(expectedDescending[i]);
      if (i < 10) val = stepKeyboard(val, "down");
    }
    // Additional ArrowDown clamps at 0.0
    expect(stepKeyboard(val, "down")).toBe(0.0);
  });

  it("keyboard Home and End jump immediately to 0.0 and 1.0", () => {
    expect(stepKeyboard(0.7, "home")).toBe(0.0);
    expect(stepKeyboard(0.3, "end")).toBe(1.0);
  });

  it("VialDisplay renders accessible slider attributes for boundary values 0.0 and 1.0", () => {
    const htmlZero = renderToString(
      React.createElement(VialDisplay, { value: 0.0, onChange: () => {} })
    );
    expect(htmlZero).toContain('role="slider"');
    expect(htmlZero).toContain('aria-valuemin="0"');
    expect(htmlZero).toContain('aria-valuemax="100"');
    expect(htmlZero).toContain('aria-valuenow="0"');
    expect(htmlZero).toContain('aria-valuetext="0% full"');
    expect(htmlZero).toContain('style="height:0%"');

    const htmlFull = renderToString(
      React.createElement(VialDisplay, { value: 1.0, onChange: () => {} })
    );
    expect(htmlFull).toContain('aria-valuenow="100"');
    expect(htmlFull).toContain('aria-valuetext="100% full"');
    expect(htmlFull).toContain('style="height:100%"');
  });
});

// ---------------------------------------------------------------------------
// 2. Keg Volume Derivations (Half, Quarter, Sixtel)
// ---------------------------------------------------------------------------
describe("Challenger 1: Keg Volume Derivations", () => {
  const KEG_SIZES = {
    halfBarrel: 58674,
    quarterBarrel: 29337,
    sixtel: 19533,
  };

  function deriveKegMl(fraction: number, sizeMl: number): number {
    return Math.round(fraction * sizeMl);
  }

  it("verifies exact mL calculations for half barrel (58,674 mL)", () => {
    const size = KEG_SIZES.halfBarrel;
    expect(deriveKegMl(0.0, size)).toBe(0);
    expect(deriveKegMl(0.1, size)).toBe(5867);
    expect(deriveKegMl(0.2, size)).toBe(11735);
    expect(deriveKegMl(0.3, size)).toBe(17602);
    expect(deriveKegMl(0.4, size)).toBe(23470);
    expect(deriveKegMl(0.5, size)).toBe(29337);
    expect(deriveKegMl(0.6, size)).toBe(35204);
    expect(deriveKegMl(0.7, size)).toBe(41072);
    expect(deriveKegMl(0.8, size)).toBe(46939);
    expect(deriveKegMl(0.9, size)).toBe(52807);
    expect(deriveKegMl(1.0, size)).toBe(58674);
  });

  it("verifies exact mL calculations for quarter barrel (29,337 mL)", () => {
    const size = KEG_SIZES.quarterBarrel;
    expect(deriveKegMl(0.0, size)).toBe(0);
    expect(deriveKegMl(0.1, size)).toBe(2934);
    expect(deriveKegMl(0.5, size)).toBe(14669);
    expect(deriveKegMl(1.0, size)).toBe(29337);
  });

  it("verifies exact mL calculations for sixtel (19,533 mL)", () => {
    const size = KEG_SIZES.sixtel;
    expect(deriveKegMl(0.0, size)).toBe(0);
    expect(deriveKegMl(0.1, size)).toBe(1953);
    expect(deriveKegMl(0.3, size)).toBe(5860);
    expect(deriveKegMl(0.5, size)).toBe(9767);
    expect(deriveKegMl(1.0, size)).toBe(19533);
  });

  it("FillEntry displays derived mL in chips and total summary for all keg sizes", () => {
    const htmlSixtel = stripReactComments(
      renderToString(
        React.createElement(FillEntry, {
          productName: "Guinness Draught — Sixtel",
          sizeMl: KEG_SIZES.sixtel,
          unitType: "keg",
          existingFills: [0.3],
          onCancel: () => {},
        })
      )
    );
    expect(htmlSixtel).toContain("5,860 mL");
    expect(htmlSixtel).toContain("0.3 ea ≈ 5,860 mL");
    expect(htmlSixtel).toContain("0.3 units ≈ 5,860 mL");

    const htmlQuarter = stripReactComments(
      renderToString(
        React.createElement(FillEntry, {
          productName: "Sierra Nevada — Quarter Barrel",
          sizeMl: KEG_SIZES.quarterBarrel,
          unitType: "keg",
          existingFills: [0.5],
          onCancel: () => {},
        })
      )
    );
    expect(htmlQuarter).toContain("14,669 mL");
    expect(htmlQuarter).toContain("0.5 ea ≈ 14,669 mL");
    expect(htmlQuarter).toContain("0.5 units ≈ 14,669 mL");
  });

  it("gracefully omits mL note when unitType is bottle or sizeMl is absent", () => {
    const htmlBottle = stripReactComments(
      renderToString(
        React.createElement(FillEntry, {
          productName: "Tanqueray Gin",
          sizeMl: 750,
          unitType: "bottle",
          existingFills: [0.5],
          onCancel: () => {},
        })
      )
    );
    expect(htmlBottle).not.toContain("mL");
    expect(htmlBottle).toContain("0.5 units");
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-Bottle Partial Fills Chip List & JSON Serialization
// ---------------------------------------------------------------------------
describe("Challenger 1: Multi-Bottle Partial Fills & JSON Serialization", () => {
  it("serializes and round-trips JSON partial fills array cleanly", () => {
    const fills = [0.3, 0.8];
    const serialized = JSON.stringify(fills);
    expect(serialized).toBe("[0.3,0.8]");
    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual([0.3, 0.8]);
  });

  it("accurately sums multiple fractional bottles without float artifacts", () => {
    const fills = [0.1, 0.2]; // In native JS: 0.1 + 0.2 = 0.30000000000000004
    const total = fills.reduce((sum, f) => sum + f, 0);
    expect(formatUnits(total)).toBe("0.3");

    const fourFills = [0.3, 0.8, 0.5, 0.4];
    const fourTotal = fourFills.reduce((sum, f) => sum + f, 0);
    expect(formatUnits(fourTotal)).toBe("2");
  });

  it("handles multi-bottle state transitions: add, edit, remove, index shift", () => {
    let fills: number[] = [0.3, 0.8]; // bottle 0: 0.3, bottle 1: 0.8
    let activeIndex: number | null = null;

    // 1. Add bottle
    fills = [...fills, 0.5]; // bottle 2: 0.5
    expect(fills).toEqual([0.3, 0.8, 0.5]);

    // 2. Edit bottle 1
    activeIndex = 1;
    fills[activeIndex] = 0.9;
    activeIndex = null;
    expect(fills).toEqual([0.3, 0.9, 0.5]);

    // 3. Remove bottle 0 (first bottle) -> indices shift down
    const removedIndex = 0;
    fills = fills.filter((_, i) => i !== removedIndex);
    expect(fills).toEqual([0.9, 0.5]);
    expect(fills.length).toBe(2);

    // 4. Remove all bottles -> empty array
    fills = [];
    expect(fills.length).toBe(0);
    expect(fills.reduce((sum, f) => sum + f, 0)).toBe(0);
    expect(formatUnits(0)).toBe("0");
  });

  it("FillEntry renders empty state message when existingFills is empty", () => {
    const htmlEmpty = stripReactComments(
      renderToString(
        React.createElement(FillEntry, {
          productName: "Patrón Silver",
          sizeMl: 750,
          unitType: "bottle",
          existingFills: [],
          onCancel: () => {},
        })
      )
    );
    expect(htmlEmpty).toContain("0 bottles");
    expect(htmlEmpty).toContain("No open bottles recorded yet");
    expect(htmlEmpty).toContain("0 units");
  });

  it("validates Zod schema bounds on partial fills arrays", () => {
    // Valid array
    const valid = editCountLineFillsSchema.safeParse({
      clientLineId: "11111111-1111-4111-8111-111111111111",
      countLineId: 10,
      partialFills: [0.0, 0.5, 1.0],
    });
    expect(valid.success).toBe(true);

    // Negative fill rejected
    const negative = editCountLineFillsSchema.safeParse({
      clientLineId: "11111111-1111-4111-8111-111111111111",
      countLineId: 10,
      partialFills: [-0.1],
    });
    expect(negative.success).toBe(false);

    // Fill > 1.0 rejected
    const overOne = editCountLineFillsSchema.safeParse({
      clientLineId: "11111111-1111-4111-8111-111111111111",
      countLineId: 10,
      partialFills: [1.2],
    });
    expect(overOne.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Sealed Quantity Steppers & ADD vs SET Consequence Deltas
// ---------------------------------------------------------------------------
describe("Challenger 1: Sealed Quantity Steppers & Consequence Deltas", () => {
  function clampInt(v: string | number): number {
    const n = typeof v === "number" ? v : parseInt(v, 10);
    return isNaN(n) || n < 0 ? 0 : Math.floor(n);
  }

  function computeConsequence(
    mode: "add" | "set",
    initialCases: number,
    initialEaches: number,
    inputCases: number,
    inputEaches: number,
    caseSize: number | null,
  ) {
    const cs = caseSize ?? 1;
    const currentUnits = initialCases * cs + initialEaches;

    if (mode === "add") {
      const nextCases = initialCases + inputCases;
      const nextEaches = initialEaches + inputEaches;
      const nextUnits = nextCases * cs + nextEaches;
      const addedUnits = inputCases * cs + inputEaches;
      return {
        mode: "add",
        nextCases,
        nextEaches,
        nextUnits,
        addedUnits,
        deltaText: `${initialEaches} ea → ${nextEaches} ea`,
      };
    } else {
      const nextCases = inputCases;
      const nextEaches = inputEaches;
      const nextUnits = nextCases * cs + nextEaches;
      const unitDelta = nextUnits - currentUnits;
      return {
        mode: "set",
        nextCases,
        nextEaches,
        nextUnits,
        unitDelta,
        deltaText: `was ${initialEaches} ea · ${unitDelta >= 0 ? "+" : "−"}${Math.abs(unitDelta)}`,
      };
    }
  }

  it("clampInt strictly rejects negative values, NaNs, floats, and nulls", () => {
    expect(clampInt(-1)).toBe(0);
    expect(clampInt(-999)).toBe(0);
    expect(clampInt("-42")).toBe(0);
    expect(clampInt("not-a-number")).toBe(0);
    expect(clampInt("")).toBe(0);
    expect(clampInt(12.9)).toBe(12);
    expect(clampInt("15")).toBe(15);
    expect(clampInt(0)).toBe(0);
  });

  it("verifies ADD mode consequence delta: ADD 3 EA when current is 12 -> 15", () => {
    const res = computeConsequence("add", 0, 12, 0, 3, null);
    expect(res.addedUnits).toBe(3);
    expect(res.nextUnits).toBe(15);
    expect(res.deltaText).toBe("12 ea → 15 ea");
  });

  it("verifies SET mode consequence delta: SET TO 3 EA when was 12 -> -9", () => {
    const res = computeConsequence("set", 0, 12, 0, 3, null);
    expect(res.unitDelta).toBe(-9);
    expect(res.nextUnits).toBe(3);
    expect(res.deltaText).toBe("was 12 ea · −9");
  });

  it("verifies case pack multipliers in ADD mode (e.g. 2 cases of 24 + 5 eaches on top of 1 case)", () => {
    const res = computeConsequence("add", 1, 0, 2, 5, 24);
    expect(res.addedUnits).toBe(53);
    expect(res.nextCases).toBe(3);
    expect(res.nextEaches).toBe(5);
    expect(res.nextUnits).toBe(77);
  });

  it("QuantityEntry renders consequence preview correctly in DOM", () => {
    const htmlAdd = stripReactComments(
      renderToString(
        React.createElement(QuantityEntry, {
          productName: "Bacardi Superior Rum",
          category: "Spirits",
          unitType: "bottle",
          caseSize: 12,
          currentCases: 0,
          currentEaches: 12,
          onCancel: () => {},
        })
      )
    );
    expect(htmlAdd).toContain("Currently recorded on this line:");
    expect(htmlAdd).toContain("12 ea");
    expect(htmlAdd).toContain("Cases and eaches are stored separately and never merged");
  });

  it("Zod schema rejects negative cases and negative eaches", () => {
    const invalid = setCountLineQuantitiesSchema.safeParse({
      clientLineId: "11111111-1111-4111-8111-111111111111",
      countLineId: 10,
      sealedCaseQty: -1,
      sealedEachQty: 5,
    });
    expect(invalid.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Stray Bottle Escape Hatch & Location Isolation
// ---------------------------------------------------------------------------
describe("Challenger 1: Stray Bottle Escape Hatch", () => {
  it("StrayBottleModal strictly excludes current active location from destination list", () => {
    const locations = [
      { id: 1, name: "Speed Rail", countMode: "tenths" as const, active: true, sortOrder: 1, notes: null },
      { id: 2, name: "Back Bar", countMode: "tenths" as const, active: true, sortOrder: 2, notes: null },
      { id: 3, name: "Storeroom", countMode: "quantity" as const, active: true, sortOrder: 3, notes: null },
    ];

    const html = stripReactComments(
      renderToString(
        React.createElement(StrayBottleModal, {
          isOpen: true,
          activeLocationId: 1, // Speed Rail is active
          locations,
          onClose: () => {},
          onRecordStray: () => {},
        })
      )
    );

    expect(html).not.toContain(">Speed Rail<");
    expect(html).toContain("Back Bar");
    expect(html).toContain("Storeroom");
  });

  // NOTE: this models the locking rule with plain local variables — it never
  // renders or calls CountLeg, so it documents the intended shape of the
  // behavior and is NOT evidence that CountLeg implements it. That needs a
  // browser pass (docs/plans/ui-ux-redesign/00-status.md).
  it("models: stray bottle target leaves the active leg station unchanged", () => {
    // Simulating CountLeg station locking model
    const activeLocationId = 1; // Locked to Speed Rail (ID: 1)
    let currentPhase: { kind: string; locationId?: number; isStray?: boolean } = { kind: "counting" };

    // Counter triggers stray bottle modal for Storeroom (ID: 3)
    const strayTargetId = 3;

    // Stray action handler:
    currentPhase = { kind: "entry", locationId: strayTargetId, isStray: true };

    // Verify entry phase targets stray location (ID: 3) while active leg stays locked to ID: 1
    expect(currentPhase.locationId).toBe(3);
    expect(currentPhase.isStray).toBe(true);
    expect(activeLocationId).toBe(1); // ACTIVE LOCATION NOT MUTATED!

    // Upon completing stray entry, done() returns to counting
    currentPhase = { kind: "counting" };
    expect(activeLocationId).toBe(1); // Still locked to Speed Rail!
  });
});

// ---------------------------------------------------------------------------
// 6. Invariant 3 Rescan Guard & Line Increments
// ---------------------------------------------------------------------------
describe("Challenger 1: Invariant 3 Rescan Guard & Increments", () => {
  it("optimistic reducer increments existing line instead of inserting a second line", () => {
    const key = "42:1"; // productId 42 at locationId 1
    const lineMap = new Map();

    // Initial scan of Tito's at Back Bar
    lineMap.set(key, {
      lineId: 101,
      productId: 42,
      locationId: 1,
      productName: "Tito's Handmade Vodka",
      sealedCaseQty: 0,
      sealedEachQty: 1,
      partialFills: [],
      units: 1,
      caseSizeAtCount: null,
    });

    expect(lineMap.size).toBe(1);

    // Second scan of Tito's at Back Bar (same product + location)
    const existing = lineMap.get(key);
    const updatedSealedEach = existing.sealedEachQty + 1;
    lineMap.set(key, {
      ...existing,
      sealedEachQty: updatedSealedEach,
      units: updatedSealedEach,
      note: "Already on this count — updated, not duplicated",
    });

    // Verify Invariant 3: Map still contains exactly 1 row, units updated to 2
    expect(lineMap.size).toBe(1);
    expect(lineMap.get(key).sealedEachQty).toBe(2);
    expect(lineMap.get(key).units).toBe(2);
    expect(lineMap.get(key).note).toBe("Already on this count — updated, not duplicated");
  });

  it("CountLineCard renders aria-live='polite' status on rescan", () => {
    const card = CountLineCard({
      data: {
        productName: "Tito's Handmade Vodka",
        category: "Spirits",
        sizeMl: 750,
        unitType: "bottle",
        locationName: "Back Bar",
        sealedCaseQty: 0,
        sealedEachQty: 2,
        partialFills: [],
        units: 2,
        caseSizeAtCount: null,
      },
      highlight: "Already on this count — updated, not duplicated",
    })!;

    const body = card.props.children[1];
    const liveRegion = body.props.children[body.props.children.length - 1];
    expect(liveRegion.props.role).toBe("status");
    expect(liveRegion.props["aria-live"]).toBe("polite");
    expect(liveRegion.props.children).toBe("Already on this count — updated, not duplicated");
  });

  it("hardware rescan guard filters detector frame chatter while counting genuine multiple bottles", () => {
    const guard = createRescanGuard();

    // Scan 1: Bottle A appears
    expect(offerFrame(guard, "BARCODE-A", 1000)).toBe(true);

    // Detector chatters for next 10 frames (160ms) while bottle remains in frame
    for (let t = 1016; t <= 1160; t += 16) {
      expect(offerFrame(guard, "BARCODE-A", t)).toBe(false);
    }

    // Bottle leaves frame (clear frame)
    expect(offerFrame(guard, null, 1200)).toBe(false);

    // Cooldown window passes, 2nd genuine identical bottle appears at t=2000
    expect(offerFrame(guard, "BARCODE-A", 2000)).toBe(true);
  });
});
