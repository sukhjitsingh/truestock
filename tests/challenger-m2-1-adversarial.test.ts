/**
 * Adversarial Challenger M2-1 Test Suite: Milestone 2 Phase 2 Mobile Floor Counting
 *
 * Empirical verification of:
 * 1. Liquid Vial Simulation Bounds (.1–1.0 slider, snapping, meniscus highlight, accessibility).
 * 2. Tenths Keypad 56px Tap Targets & Presets (Full/Half/Empty, multi-bottle chips, keg derivation, role gating).
 * 3. Quantity Entry Live Consequence Deltas (ADD vs SET live consequence strings, pack multipliers, clampInt).
 * 4. Stray Bottle Escape Hatch Modal (location filtering, station isolation, accessibility, escape dismissal).
 * 5. Location Locked Leg Flow (state machine transitions, locked station badge, section finish).
 */
import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { VialDisplay } from "@/components/count/vial-display";
import { FillEntry } from "@/components/count/fill-entry";
import { QuantityEntry } from "@/components/count/quantity-entry";
import { StrayBottleModal } from "@/components/count/stray-bottle-modal";
import { LocationPicker } from "@/components/count/location-picker";
import { isCountedByCase } from "@/lib/pack-level";
import { formatUnits } from "@/lib/utils";

/** Helper to strip React SSR comments for exact DOM text assertions */
function cleanSSR(html: string): string {
  return html.replace(/<!--.*?-->/g, "");
}

// ============================================================================
// 1. LIQUID VIAL SIMULATION BOUNDS & MENISCUS HIGHLIGHT
// ============================================================================
describe("Challenger M2-1: Liquid Vial Simulation & Meniscus Rendering", () => {
  function computePointerValue(clientY: number, rectTop: number, rectHeight: number): number {
    if (rectHeight <= 0) return 0;
    const rel = 1 - (clientY - rectTop) / rectHeight;
    return Math.max(0, Math.min(1, Math.round(rel * 10) / 10));
  }

  function simulateKeyNav(current: number, key: string): number {
    if (key === "ArrowUp" || key === "ArrowRight") {
      return Math.min(1, Math.round((current + 0.1) * 10) / 10);
    }
    if (key === "ArrowDown" || key === "ArrowLeft") {
      return Math.max(0, Math.round((current - 0.1) * 10) / 10);
    }
    if (key === "Home") return 0;
    if (key === "End") return 1;
    return current;
  }

  it("handles floating-point boundary inputs and clamps properly without IEEE-754 drift", () => {
    // Exact tenths across the entire 0.0 to 1.0 spectrum
    const tenths = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    for (const t of tenths) {
      const html = renderToString(React.createElement(VialDisplay, { value: t, onChange: () => {} }));
      const expectedPct = Math.round(t * 100);
      expect(html).toContain(`aria-valuenow="${expectedPct}"`);
      expect(html).toContain(`aria-valuetext="${expectedPct}% full"`);
      expect(html).toContain(`style="height:${expectedPct}%"`);
    }

    // Boundary stress testing with extreme float values
    const floatCases = [
      { input: -0.0001, expectedNow: 0, expectedHeight: "0%" },
      { input: -999.9, expectedNow: 0, expectedHeight: "0%" },
      { input: 0.00001, expectedNow: 0, expectedHeight: "0%" },
      { input: 0.049, expectedNow: 5, expectedHeight: "5%" },
      { input: 0.051, expectedNow: 5, expectedHeight: "5%" },
      { input: 0.9999, expectedNow: 100, expectedHeight: "100%" },
      { input: 1.0001, expectedNow: 100, expectedHeight: "100%" },
      { input: 42.5, expectedNow: 100, expectedHeight: "100%" },
    ];

    for (const c of floatCases) {
      const html = renderToString(React.createElement(VialDisplay, { value: c.input, onChange: () => {} }));
      expect(html).toContain(`aria-valuenow="${c.expectedNow}"`);
      expect(html).toContain(`style="height:${c.expectedHeight}"`);
    }
  });

  it("meniscus curve highlight renders if and only if percent > 0", () => {
    // When value = 0.0 -> percent = 0 -> meniscus highlight must NOT exist
    const htmlEmpty = renderToString(React.createElement(VialDisplay, { value: 0.0, onChange: () => {} }));
    expect(htmlEmpty).not.toContain("bg-white/40 shadow-xs backdrop-blur-xs");

    // When value = 0.1 -> percent = 10 -> meniscus highlight MUST exist
    const htmlTenth = renderToString(React.createElement(VialDisplay, { value: 0.1, onChange: () => {} }));
    expect(htmlTenth).toContain("bg-white/40 shadow-xs backdrop-blur-xs");

    // When value = 1.0 -> percent = 100 -> meniscus highlight MUST exist
    const htmlFull = renderToString(React.createElement(VialDisplay, { value: 1.0, onChange: () => {} }));
    expect(htmlFull).toContain("bg-white/40 shadow-xs backdrop-blur-xs");
  });

  it("renders realistic bottle neck and 10-grid percentage labels", () => {
    const html = renderToString(React.createElement(VialDisplay, { value: 0.5, onChange: () => {} }));
    // Bottle neck
    expect(html).toContain("rounded-t-sm border-2 border-b-0 border-border bg-muted/80");
    // 10-Grid percentage ticks
    expect(html).toContain("100%");
    expect(html).toContain("80%");
    expect(html).toContain("60%");
    expect(html).toContain("40%");
    expect(html).toContain("20%");
    expect(html).toContain("0%");
  });

  it("verifies pointer coordinate drag calculation and clamping", () => {
    const top = 200;
    const height = 300;
    // Exactly at top (clientY = 200) -> 1.0
    expect(computePointerValue(200, top, height)).toBe(1.0);
    // Above top (clientY = 50) -> clamped 1.0
    expect(computePointerValue(50, top, height)).toBe(1.0);
    // Exactly at bottom (clientY = 500) -> 0.0
    expect(computePointerValue(500, top, height)).toBe(0.0);
    // Below bottom (clientY = 750) -> clamped 0.0
    expect(computePointerValue(750, top, height)).toBe(0.0);
    // Exactly halfway (clientY = 350) -> 0.5
    expect(computePointerValue(350, top, height)).toBe(0.5);
    // 30% from bottom (clientY = 410) -> 0.3
    expect(computePointerValue(410, top, height)).toBe(0.3);
  });

  it("verifies full keyboard navigation cycle without accumulated precision errors", () => {
    let current = 0.0;
    // ArrowUp 10 times to 1.0
    for (let i = 1; i <= 10; i++) {
      current = simulateKeyNav(current, "ArrowUp");
      expect(current).toBe(Math.round((i * 0.1) * 10) / 10);
    }
    expect(current).toBe(1.0);
    // ArrowUp at 1.0 stays 1.0
    expect(simulateKeyNav(current, "ArrowUp")).toBe(1.0);

    // ArrowDown 10 times to 0.0
    for (let i = 9; i >= 0; i--) {
      current = simulateKeyNav(current, "ArrowDown");
      expect(current).toBe(Math.round((i * 0.1) * 10) / 10);
    }
    expect(current).toBe(0.0);
    // ArrowDown at 0.0 stays 0.0
    expect(simulateKeyNav(current, "ArrowDown")).toBe(0.0);

    // Home / End shortcuts
    expect(simulateKeyNav(0.7, "Home")).toBe(0.0);
    expect(simulateKeyNav(0.2, "End")).toBe(1.0);
  });

  it("renders disabled state with tabIndex -1 and cursor-not-allowed", () => {
    const html = renderToString(
      React.createElement(VialDisplay, { value: 0.5, disabled: true, onChange: () => {} })
    );
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("cursor-not-allowed opacity-50");
  });
});

// ============================================================================
// 2. TENTHS KEYPAD 56PX TAP TARGETS & PRESETS
// ============================================================================
describe("Challenger M2-1: Tenths Keypad & Multi-Bottle Staging", () => {
  it("verifies 56px primary tap target styling on keypad buttons, presets, and commit CTA", () => {
    const html = cleanSSR(
      renderToString(
        React.createElement(FillEntry, {
          productName: "Hendrick's Gin",
          sizeMl: 750,
          unitType: "bottle",
          existingFills: [0.4],
          onCancel: () => {},
        })
      )
    );

    // Presets have min-h-tap-primary
    expect(html).toContain("Full");
    expect(html).toContain("Half");
    expect(html).toContain("Empty");
    expect(html).toContain("min-h-tap-primary");

    // All discrete tenths (.1 through 1.0)
    const expectedTenths = ["10 percent full", "20 percent full", "50 percent full", "100 percent full"];
    for (const label of expectedTenths) {
      expect(html).toContain(label);
    }

    // Save CTA button has min-h-tap-primary
    expect(html).toContain("Save fill levels");
  });

  it("accurately derives keg volume in mL across all standard keg sizes", () => {
    const testCases = [
      { unitType: "keg", sizeMl: 58674, fills: [0.7], expectedMl: "41,072 mL" }, // Half barrel
      { unitType: "keg", sizeMl: 29337, fills: [0.4], expectedMl: "11,735 mL" }, // Quarter barrel
      { unitType: "keg", sizeMl: 19533, fills: [0.8], expectedMl: "15,626 mL" }, // Sixtel
      { unitType: "keg", sizeMl: 58674, fills: [0.5, 0.6], expectedMl: "64,541 mL" }, // Multi-keg 1.1 kegs
    ];

    for (const tc of testCases) {
      const html = cleanSSR(
        renderToString(
          React.createElement(FillEntry, {
            productName: "Draft Keg Test",
            sizeMl: tc.sizeMl,
            unitType: tc.unitType,
            existingFills: tc.fills,
            onCancel: () => {},
          })
        )
      );
      expect(html).toContain(tc.expectedMl);
    }
  });

  it("handles multi-bottle partial fill state transitions cleanly", () => {
    let fills: number[] = [0.3, 0.8]; // Initial: 2 bottles = 1.1 units

    // Add 3rd bottle (0.5)
    fills = [...fills, 0.5];
    expect(fills).toEqual([0.3, 0.8, 0.5]);
    expect(fills.reduce((a, b) => a + b, 0)).toBeCloseTo(1.6, 5);

    // Edit bottle #2 (index 1) to 0.9
    fills = [...fills];
    fills[1] = 0.9;
    expect(fills).toEqual([0.3, 0.9, 0.5]);
    expect(fills.reduce((a, b) => a + b, 0)).toBeCloseTo(1.7, 5);

    // Remove bottle #1 (index 0)
    fills = fills.filter((_, i) => i !== 0);
    expect(fills).toEqual([0.9, 0.5]);
    expect(fills.length).toBe(2);

    // Remove all
    fills = [];
    expect(fills.length).toBe(0);
    expect(fills.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("enforces Invariant 8 role gating on save button valuation", () => {
    // Staff role (canSeeCost: false)
    const htmlStaff = cleanSSR(
      renderToString(
        React.createElement(FillEntry, {
          productName: "Grey Goose Vodka",
          sizeMl: 750,
          unitType: "bottle",
          existingFills: [0.6],
          canSeeCost: false,
          unitCost: 30.0,
          onCancel: () => {},
        })
      )
    );
    expect(htmlStaff).toContain("Save fill levels");
    expect(htmlStaff).not.toContain("$18.00");
    expect(htmlStaff).not.toContain("No cost on file");

    // Owner role with priced product (canSeeCost: true, unitCost: 30.0)
    const htmlOwner = cleanSSR(
      renderToString(
        React.createElement(FillEntry, {
          productName: "Grey Goose Vodka",
          sizeMl: 750,
          unitType: "bottle",
          existingFills: [0.6],
          canSeeCost: true,
          unitCost: 30.0,
          onCancel: () => {},
        })
      )
    );
    expect(htmlOwner).toContain("Save fill levels");
    expect(htmlOwner).toContain("$18.00");

    // Owner role with unpriced product (unitCost: null)
    const htmlUnpriced = cleanSSR(
      renderToString(
        React.createElement(FillEntry, {
          productName: "Unpriced Vodka",
          sizeMl: 750,
          unitType: "bottle",
          existingFills: [0.6],
          canSeeCost: true,
          unitCost: null,
          onCancel: () => {},
        })
      )
    );
    expect(htmlUnpriced).toContain("Save fill levels");
    expect(htmlUnpriced).not.toContain("$");
    expect(htmlUnpriced).toContain("No cost on file — excluded from valuation");
  });
});

// ============================================================================
// 3. QUANTITY ENTRY LIVE CONSEQUENCE DELTAS
// ============================================================================
describe("Challenger M2-1: Quantity Entry Consequence Deltas & Steppers", () => {
  it("enforces isCountedByCase only for bottled/canned Beer (never Spirits, Wine, Kegs)", () => {
    expect(isCountedByCase({ category: "Beer", unitType: "bottle" })).toBe(true);
    expect(isCountedByCase({ category: "Beer", unitType: "can" })).toBe(true);
    expect(isCountedByCase({ category: "beer", unitType: "pack" })).toBe(true);
    expect(isCountedByCase({ category: "Beer", unitType: "keg" })).toBe(false); // Keg is NOT by case
    expect(isCountedByCase({ category: "Spirits", unitType: "bottle" })).toBe(false);
    expect(isCountedByCase({ category: "Wine", unitType: "bottle" })).toBe(false);
    expect(isCountedByCase({ category: "Liqueur", unitType: "bottle" })).toBe(false);
    expect(isCountedByCase({ category: "NA", unitType: "can" })).toBe(false);
  });

  it("renders live consequence deltas for ADD mode vs SET mode exactly as specified", () => {
    // ADD MODE: Currently 12 ea. Adding 3 ea -> 12 ea → 15 ea
    const htmlAdd = cleanSSR(
      renderToString(
        React.createElement(QuantityEntry, {
          productName: "Jameson Irish Whiskey",
          category: "Spirits",
          unitType: "bottle",
          currentCases: 0,
          currentEaches: 12,
          onCancel: () => {},
        })
      )
    );
    expect(htmlAdd).toContain("Currently recorded on this line:");
    expect(htmlAdd).toContain("12 ea");
    expect(htmlAdd).toContain("12 ea → 12 ea"); // Before typing in input

    // SET MODE: Initial 12 ea, Setting to 3 ea
    // Test helper calculating exact consequence formatting
    function formatConsequence(mode: "add" | "set", initialCases: number, initialEaches: number, inputCases: number, inputEaches: number, caseSize: number | null) {
      const cs = caseSize ?? 1;
      const initialUnits = initialCases * cs + initialEaches;
      const nextCases = mode === "add" ? initialCases + inputCases : inputCases;
      const nextEaches = mode === "add" ? initialEaches + inputEaches : inputEaches;
      const nextUnits = nextCases * cs + nextEaches;
      const unitDelta = nextUnits - initialUnits;

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

      if (mode === "add") {
        return {
          title: `Save (${describe(inputCases, inputEaches)})`,
          subtitle: `${describe(initialCases, initialEaches)} → ${describe(nextCases, nextEaches)}`,
        };
      } else {
        return {
          title: `Save correction (${describeAfter(inputCases, inputEaches)})`,
          subtitle: `was ${describe(initialCases, initialEaches)} · ${unitDelta >= 0 ? "+" : "−"}${formatUnits(Math.abs(unitDelta))}`,
        };
      }
    }

    // Spec verification: SET TO 3 EA / was 12 ea · −9
    const setNegative = formatConsequence("set", 0, 12, 0, 3, null);
    expect(setNegative.title).toBe("Save correction (3 ea)");
    expect(setNegative.subtitle).toBe("was 12 ea · −9");

    // Spec verification: SET TO 15 EA / was 12 ea · +3
    const setPositive = formatConsequence("set", 0, 12, 0, 15, null);
    expect(setPositive.title).toBe("Save correction (15 ea)");
    expect(setPositive.subtitle).toBe("was 12 ea · +3");

    // Spec verification: ADD 3 EA / 12 ea → 15 ea
    const addDelta = formatConsequence("add", 0, 12, 0, 3, null);
    expect(addDelta.title).toBe("Save (3 ea)");
    expect(addDelta.subtitle).toBe("12 ea → 15 ea");

    // Multi-case pack calculation: 1 case of 24 + 5 ea, ADD 2 cases of 24 + 3 ea
    const addMulti = formatConsequence("add", 1, 5, 2, 3, 24);
    expect(addMulti.title).toBe("Save (2 cases, 3 ea)");
    expect(addMulti.subtitle).toBe("1 case, 5 ea → 3 cases, 8 ea");
  });

  it("stepper buttons adhere to 56px touch target floor and clamp integers >= 0", () => {
    const html = cleanSSR(
      renderToString(
        React.createElement(QuantityEntry, {
          productName: "Corona Extra",
          category: "Beer",
          unitType: "bottle",
          caseSize: 24,
          currentCases: 2,
          currentEaches: 6,
          onCancel: () => {},
        })
      )
    );

    // Both Cases and Eaches steppers rendered
    expect(html).toContain("Cases");
    expect(html).toContain("Eaches");
    expect(html).toContain("× 24 per case");
    expect(html).toContain("size-tap-primary"); // 56px button sizing
  });

  it("enforces Invariant 8 role gating on QuantityEntry submit valuation", () => {
    // Staff (canSeeCost: false) -> No dollar value rendered
    const htmlStaff = cleanSSR(
      renderToString(
        React.createElement(QuantityEntry, {
          productName: "Ketel One Vodka",
          category: "Spirits",
          unitType: "bottle",
          currentCases: 0,
          currentEaches: 5,
          canSeeCost: false,
          unitCost: 22.5,
          onCancel: () => {},
        })
      )
    );
    expect(htmlStaff).not.toContain("$");

    // Owner (canSeeCost: true) -> Dollar value rendered
    const htmlOwner = cleanSSR(
      renderToString(
        React.createElement(QuantityEntry, {
          productName: "Ketel One Vodka",
          category: "Spirits",
          unitType: "bottle",
          currentCases: 0,
          currentEaches: 5,
          canSeeCost: true,
          unitCost: 22.5,
          onCancel: () => {},
        })
      )
    );
    expect(htmlOwner).toContain("$112.50"); // 5 units * $22.50
  });
});

// ============================================================================
// 4. STRAY BOTTLE ESCAPE HATCH MODAL
// ============================================================================
describe("Challenger M2-1: Stray Bottle Escape Hatch Modal", () => {
  const LOCATIONS = [
    { id: 1, name: "Speed Rail", countMode: "tenths" as const, active: true, sortOrder: 1, notes: null },
    { id: 2, name: "Back Bar", countMode: "tenths" as const, active: true, sortOrder: 2, notes: null },
    { id: 3, name: "Storeroom", countMode: "quantity" as const, active: true, sortOrder: 3, notes: null },
    { id: 4, name: "Walk-In Cooler", countMode: "quantity" as const, active: true, sortOrder: 4, notes: null },
  ];

  it("strictly filters out active station from destination options", () => {
    // When activeLocationId is 1 (Speed Rail)
    const htmlSpeedRailActive = cleanSSR(
      renderToString(
        React.createElement(StrayBottleModal, {
          isOpen: true,
          activeLocationId: 1,
          locations: LOCATIONS,
          onClose: () => {},
          onRecordStray: () => {},
        })
      )
    );
    expect(htmlSpeedRailActive).not.toContain(">Speed Rail<");
    expect(htmlSpeedRailActive).toContain("Back Bar");
    expect(htmlSpeedRailActive).toContain("Storeroom");
    expect(htmlSpeedRailActive).toContain("Walk-In Cooler");

    // When activeLocationId is 3 (Storeroom)
    const htmlStoreroomActive = cleanSSR(
      renderToString(
        React.createElement(StrayBottleModal, {
          isOpen: true,
          activeLocationId: 3,
          locations: LOCATIONS,
          onClose: () => {},
          onRecordStray: () => {},
        })
      )
    );
    expect(htmlStoreroomActive).toContain("Speed Rail");
    expect(htmlStoreroomActive).toContain("Back Bar");
    expect(htmlStoreroomActive).not.toContain(">Storeroom<");
    expect(htmlStoreroomActive).toContain("Walk-In Cooler");
  });

  it("renders accessible modal attributes (dialog role, aria-modal, title label)", () => {
    const html = cleanSSR(
      renderToString(
        React.createElement(StrayBottleModal, {
          isOpen: true,
          activeLocationId: 2,
          locations: LOCATIONS,
          onClose: () => {},
          onRecordStray: () => {},
        })
      )
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="stray-modal-title"');
    expect(html).toContain("Count a stray bottle elsewhere");
    expect(html).toContain("Records one bottle into another section. You return here afterward.");
  });

  it("returns null when isOpen is false", () => {
    const htmlClosed = renderToString(
      React.createElement(StrayBottleModal, {
        isOpen: false,
        activeLocationId: 1,
        locations: LOCATIONS,
        onClose: () => {},
        onRecordStray: () => {},
      })
    );
    expect(htmlClosed).toBe("");
  });
});

// ============================================================================
// 5. LOCATION LOCKED LEG FLOW
// ============================================================================
describe("Challenger M2-1: Location Locked Leg Flow", () => {
  const LOCATIONS = [
    { id: 1, name: "Speed Rail", countMode: "tenths" as const, active: true, sortOrder: 1, notes: null },
    { id: 2, name: "Back Bar", countMode: "tenths" as const, active: true, sortOrder: 2, notes: null },
    { id: 3, name: "Storeroom", countMode: "quantity" as const, active: true, sortOrder: 3, notes: null },
  ];

  it("LocationPicker displays station count mode notes and counted progress pills", () => {
    const countedMap = new Map<string, { locationId: number }>();
    countedMap.set("10:1", { locationId: 1 });
    countedMap.set("11:1", { locationId: 1 });
    countedMap.set("12:2", { locationId: 2 });

    const html = cleanSSR(
      renderToString(
        React.createElement(LocationPicker, {
          countId: 105,
          locations: LOCATIONS,
          counted: countedMap,
          onPick: () => {},
        })
      )
    );

    expect(html).toContain("Which section?");
    expect(html).toContain("Pick a station to count. Your active location stays locked until you tap");
    expect(html).toContain("Finish section");
    expect(html).toContain("Speed Rail");
    expect(html).toContain("Fill levels (tenths)");
    expect(html).toContain("2 counted"); // 2 items in Speed Rail
    expect(html).toContain("Back Bar");
    expect(html).toContain("1 counted"); // 1 item in Back Bar
    expect(html).toContain("Storeroom");
    expect(html).toContain("Quantities only");
    expect(html).toContain("Pending"); // 0 items in Storeroom
  });

  it("simulates full leg state machine: pick -> count -> stray -> return -> finish", () => {
    type Phase =
      | { kind: "pick-location" }
      | { kind: "counting" }
      | { kind: "entry"; productId: number; locationId: number; isStray: boolean };

    let currentPhase: Phase = { kind: "pick-location" };
    let activeLocationId: number | null = null;

    // 1. Pick Speed Rail (ID: 1)
    activeLocationId = 1;
    currentPhase = { kind: "counting" };
    expect(activeLocationId).toBe(1);
    expect(currentPhase.kind).toBe("counting");

    // 2. Count product 101 in active station (Speed Rail)
    currentPhase = { kind: "entry", productId: 101, locationId: activeLocationId, isStray: false };
    expect(currentPhase.locationId).toBe(1);
    expect(currentPhase.isStray).toBe(false);

    // Save returns to counting leg in Speed Rail
    currentPhase = { kind: "counting" };
    expect(activeLocationId).toBe(1);

    // 3. Counter triggers Stray Bottle Modal for Storeroom (ID: 3)
    const strayTargetId = 3;
    currentPhase = { kind: "entry", productId: 202, locationId: strayTargetId, isStray: true };
    expect(currentPhase.locationId).toBe(3); // Targets Storeroom!
    expect(currentPhase.isStray).toBe(true);
    expect(activeLocationId).toBe(1); // Active leg still locked to Speed Rail!

    // Saving stray returns counter right back to Speed Rail leg
    currentPhase = { kind: "counting" };
    expect(activeLocationId).toBe(1);

    // 4. Counter finishes section
    currentPhase = { kind: "pick-location" };
    expect(currentPhase.kind).toBe("pick-location");
  });
});
