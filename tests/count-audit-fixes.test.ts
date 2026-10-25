/**
 * Regression pins for the read-only review of the UI redesign's count screens.
 * Static-render only — they prove the initial markup, not tap behaviour; the
 * interaction half still needs a browser pass (docs/plans/ui-ux-redesign/00-status.md).
 */
import { describe, test, expect, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

import { StrayBottleModal } from "@/components/count/stray-bottle-modal";
import { CountCatalogSearch } from "@/components/count/catalog-search";
import type { LocationSummary } from "@/lib/domain/catalog";

const loc = (id: number, name: string): LocationSummary =>
  ({ id, name, countMode: "tenths", active: true }) as unknown as LocationSummary;

describe("StrayBottleModal destination", () => {
  const html = renderToString(
    React.createElement(StrayBottleModal, {
      isOpen: true,
      activeLocationId: 1,
      locations: [loc(1, "Speed Rail"), loc(2, "Back Bar"), loc(3, "Storeroom")],
      onClose: () => {},
      onRecordStray: () => {},
    }),
  );

  test("offers every other section but not the locked one", () => {
    expect(html).toContain("Back Bar");
    expect(html).toContain("Storeroom");
    expect(html).not.toContain(">Speed Rail<");
  });

  test("preselects no destination: a wrong default location fails silently", () => {
    expect(html).toContain("Pick a destination section first");
    // The selected-pill style is only applied to a chosen destination.
    expect(html).not.toContain("bg-accent text-accent-foreground font-bold shadow-sm");
  });
});

describe("CountCatalogSearch", () => {
  const html = renderToString(React.createElement(CountCatalogSearch));

  test("has no barcode-less Add button (EnrollForm needs a barcode of at least 4 chars)", () => {
    expect(html).not.toContain("Add new product to catalog");
    expect(html).toContain("Scan barcode to find product");
  });
});
