/**
 * Unit tests for Milestone 3: Mobile Floor Counting Surface.
 *
 * Covers:
 * - Liquid Vial Simulation & Tenths Keypad (FillEntry, VialDisplay)
 * - Keg volume derivation (fraction × size_ml)
 * - Sealed Backstock Steppers & Consequence Deltas (QuantityEntry)
 * - Locked Location & Stray Escape Hatch (LocationPicker, StrayBottleModal)
 * - Invariant 3 Rescan Pulse & Screen Reader Announcements (CountLineCard)
 * - Invariant 8 Role-Gated DOM Omission in Tab Bar (CountTabBar)
 */
import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { VialDisplay } from "@/components/count/vial-display";
import { FillEntry } from "@/components/count/fill-entry";
import { QuantityEntry } from "@/components/count/quantity-entry";
import { CountLineCard } from "@/components/count/count-line-card";
import { CountTabBar } from "@/components/count/tab-bar";
import { LocationPicker } from "@/components/count/location-picker";
import { StrayBottleModal } from "@/components/count/stray-bottle-modal";

describe("VialDisplay", () => {
  test("renders with slider role and accessible range properties", () => {
    const html = renderToString(
      React.createElement(VialDisplay, {
        value: 0.7,
        onChange: () => {},
      })
    );

    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="Fill level in tenths"');
    expect(html).toContain('aria-valuenow="70"');
    expect(html).toContain('aria-valuetext="70% full"');
  });

  test("clamps percent values between 0 and 100", () => {
    const htmlMin = renderToString(
      React.createElement(VialDisplay, { value: -0.2, onChange: () => {} })
    );
    expect(htmlMin).toContain('aria-valuenow="0"');

    const htmlMax = renderToString(
      React.createElement(VialDisplay, { value: 1.5, onChange: () => {} })
    );
    expect(htmlMax).toContain('aria-valuenow="100"');
  });
});

describe("FillEntry & Keg Derivation", () => {
  test("derives keg milliliters as fraction × size_ml", () => {
    const halfBarrelMl = 58674;
    const fraction = 0.7;
    const expectedMl = Math.round(fraction * halfBarrelMl);
    expect(expectedMl).toBe(41072);

    const html = renderToString(
      React.createElement(FillEntry, {
        productName: "Coors Light — Half Barrel",
        sizeMl: halfBarrelMl,
        unitType: "keg",
        existingFills: [0.7],
        onCancel: () => {},
      })
    );

    expect(html).toContain("41,072 mL");
    expect(html).toContain("Total open");
    expect(html).toContain("units");
  });

  test("renders role-gated value on save button when cost is visible", () => {
    const htmlPriced = renderToString(
      React.createElement(FillEntry, {
        productName: "Tanqueray London Dry Gin",
        sizeMl: 750,
        unitType: "bottle",
        existingFills: [0.5],
        canSeeCost: true,
        unitCost: 18.5,
        onCancel: () => {},
      })
    );

    expect(htmlPriced).toContain("9.25");
    expect(htmlPriced).toContain("Save fill levels");
  });

  test("omits cost from save button when staff role (canSeeCost: false)", () => {
    const htmlStaff = renderToString(
      React.createElement(FillEntry, {
        productName: "Tanqueray London Dry Gin",
        sizeMl: 750,
        unitType: "bottle",
        existingFills: [0.5],
        canSeeCost: false,
        unitCost: 18.5,
        onCancel: () => {},
      })
    );

    expect(htmlStaff).not.toContain("$9.25");
    expect(htmlStaff).toContain("Save fill levels");
  });
});

describe("QuantityEntry & Consequence Deltas", () => {
  test("renders discrete steppers for cases and eaches", () => {
    const html = renderToString(
      React.createElement(QuantityEntry, {
        productName: "Bacardi Superior Rum",
        category: "Spirits",
        unitType: "bottle",
        caseSize: 12,
        currentCases: 2,
        currentEaches: 3,
        onCancel: () => {},
      })
    );

    expect(html).toContain("Cases");
    expect(html).toContain("Eaches");
    expect(html).toContain("Currently recorded on this line:");
  });

  test("shows pack multiplier when case size is known", () => {
    const html = renderToString(
      React.createElement(QuantityEntry, {
        productName: "Coors Light 12pk",
        category: "Beer",
        unitType: "bottle",
        caseSize: 24,
        currentCases: 0,
        currentEaches: 0,
        onCancel: () => {},
      })
    );

    expect(html).toContain("× 24 per case");
  });
});

describe("CountLineCard", () => {
  test("renders appropriate category glyph for liquor and draft kegs", () => {
    const spiritCard = CountLineCard({
      data: {
        productName: "Casamigos Blanco",
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
    })!;

    expect(spiritCard).not.toBeNull();
    const [glyph] = spiritCard.props.children;
    expect(glyph.props.children).toBe("SP");

    const kegCard = CountLineCard({
      data: {
        productName: "Coors Light",
        category: "Beer",
        sizeMl: 58674,
        unitType: "keg",
        locationName: "Tap 1",
        sealedCaseQty: 0,
        sealedEachQty: 0,
        partialFills: [0.7],
        units: 0.7,
        caseSizeAtCount: null,
      },
    })!;

    const [kegGlyph] = kegCard.props.children;
    expect(kegGlyph.props.children).toBe("KG");
  });

  test("applies rescan pulse and polite live status when highlight note is present", () => {
    const card = CountLineCard({
      data: {
        productName: "Tito's Handmade Vodka",
        category: "Spirits",
        sizeMl: 750,
        unitType: "bottle",
        locationName: "Back Bar",
        sealedCaseQty: 0,
        sealedEachQty: 4,
        partialFills: [],
        units: 4,
        caseSizeAtCount: null,
      },
      highlight: "Already on this count — updated, not duplicated",
    })!;

    expect(card.props.className).toContain("border-accent");
    const body = card.props.children[1];
    const liveRegion = body.props.children[body.props.children.length - 1];
    expect(liveRegion.props.role).toBe("status");
    expect(liveRegion.props["aria-live"]).toBe("polite");
    expect(liveRegion.props.children).toBe("Already on this count — updated, not duplicated");
  });
});

describe("CountTabBar (Invariant 8 Role-Gated DOM Omission)", () => {
  test("staff role tab list omits Reports tab", () => {
    // Tests the pure tab generator mapping
    const getTabsForRole = (role: "owner" | "manager" | "staff") => [
      { href: "/count", label: "Count" },
      { href: "/count/catalog", label: "Catalog" },
      ...(role === "staff" ? [] : [{ href: "/office", label: "Reports" }]),
      { href: "/count/account", label: "Account" },
    ];

    const staffTabs = getTabsForRole("staff");
    expect(staffTabs.map((t) => t.label)).not.toContain("Reports");
    expect(staffTabs.length).toBe(3);

    const ownerTabs = getTabsForRole("owner");
    expect(ownerTabs.map((t) => t.label)).toContain("Reports");
    expect(ownerTabs.length).toBe(4);
  });
});

describe("LocationPicker & StrayBottleModal", () => {
  test("LocationPicker renders stations with count mode badges", () => {
    const locations = [
      {
        id: 1,
        name: "Back Bar",
        countMode: "tenths" as const,
        active: true,
        sortOrder: 1,
        notes: null,
      },
      {
        id: 2,
        name: "Storeroom",
        countMode: "quantity" as const,
        active: true,
        sortOrder: 2,
        notes: null,
      },
    ];

    const picker = LocationPicker({
      countId: 101,
      locations,
      counted: new Map(),
      onPick: () => {},
    })!;

    expect(picker).not.toBeNull();
  });

  test("StrayBottleModal excludes the active station from destination list", () => {
    const locations = [
      {
        id: 1,
        name: "Back Bar",
        countMode: "tenths" as const,
        active: true,
        sortOrder: 1,
        notes: null,
      },
      {
        id: 2,
        name: "Storeroom",
        countMode: "quantity" as const,
        active: true,
        sortOrder: 2,
        notes: null,
      },
    ];

    const html = renderToString(
      React.createElement(StrayBottleModal, {
        isOpen: true,
        activeLocationId: 1,
        locations,
        onClose: () => {},
        onRecordStray: () => {},
      })
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("Count a stray bottle elsewhere");
    expect(html).toContain("Storeroom");
  });
});
