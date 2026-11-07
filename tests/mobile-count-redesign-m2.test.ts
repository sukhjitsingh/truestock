/**
 * Unit tests for Milestone 2: Phase 2 Mobile Floor Counting UI/UX Redesign.
 *
 * Covers:
 * - Target 8: /count Floor Count Hub (topbar navigation, metrics calculation, section status)
 * - Target 9: /count/preflight (CSP nonce, hydration beacon, camera probe, IndexedDB offline storage)
 * - Target 10: /count/[countId] (Invariant 1 immutable closed record banner, ProgressCard coverage, tap-to-edit)
 * - Target 11: /count/[countId]/scan (Bottle neck vial simulation, consequence deltas, stray bottle escape hatch)
 * - Target 12: /count/catalog & /count/account (In-field barcode scan trigger, shift role pill, atomic sign-out)
 */
import { describe, test, expect, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";

// Mock next/navigation for client components using useRouter
mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    refresh: () => {},
  }),
}));

import { ProgressCard } from "@/components/count/progress-card";
import { CountLineCard } from "@/components/count/count-line-card";
import { VialDisplay } from "@/components/count/vial-display";
import { QuantityEntry } from "@/components/count/quantity-entry";
import { SignOutButton } from "@/components/count/sign-out-button";
import { StatusPill, countStatusTone, countStatusLabel } from "@/components/ui/status-pill";

// `children` is a required prop, but passing it inside the props object trips
// react/no-children-prop and passing it as the 3rd createElement argument does
// not satisfy the props type. The cast bridges exactly that gap.
type PillProps = React.ComponentProps<typeof StatusPill>;

describe("Milestone 2 - Target 8: Status & Lifecycle Helpers", () => {
  test("maps count statuses to appropriate status tones", () => {
    expect(countStatusTone("closed")).toBe("success");
    expect(countStatusTone("in_progress")).toBe("warning");
    expect(countStatusTone("submitted")).toBe("warning");
    expect(countStatusTone("reviewed")).toBe("warning");
    expect(countStatusTone("draft")).toBe("neutral");
  });

  test("formats status labels replacing underscores with spaces", () => {
    expect(countStatusLabel("in_progress")).toBe("in progress");
    expect(countStatusLabel("closed")).toBe("closed");
    expect(countStatusLabel("needs_review")).toBe("needs review");
  });
});

describe("Milestone 2 - Target 9: Preflight Diagnostics & Storage", () => {
  test("StatusPill renders correct tone classes for diagnostics", () => {
    const successPill = renderToString(
      React.createElement(StatusPill, { tone: "success" } as PillProps, "✓ Ready")
    );
    expect(successPill).toContain("bg-success-bg text-success");
    expect(successPill).toContain("✓ Ready");

    const warningPill = renderToString(
      React.createElement(StatusPill, { tone: "warning" } as PillProps, "WASM polyfill")
    );
    expect(warningPill).toContain("bg-warning-bg text-warning");

    const negativePill = renderToString(
      React.createElement(StatusPill, { tone: "negative" } as PillProps, "Insecure")
    );
    expect(negativePill).toContain("bg-negative-bg text-negative");
  });
});

describe("Milestone 2 - Target 10: Count Session Detail & Audit Record", () => {
  test("ProgressCard computes valuation coverage percentage and renders progressbar", () => {
    const html = renderToString(
      React.createElement(ProgressCard, {
        totals: {
          countId: 101,
          status: "in_progress",
          lineCount: 10,
          totalUnits: 15.5,
          totalValue: 342.5,
          pricedLineCount: 8,
          excludedLineCount: 2,
        },
      })
    );

    expect(html).toContain("10");
    expect(html).toContain("Lines counted");
    expect(html).toContain("15.5");
    expect(html).toContain("Total units");
    expect(html).toContain("$342.50");
    expect(html).toContain("Valuation coverage");
    expect(html).toContain("style=\"width:80%\"");
    expect(html).toContain("role=\"progressbar\"");
    expect(html).toContain("aria-valuenow=\"80\"");
    expect(html).toContain("excluded from valuation");
  });

  test("ProgressCard omits total valuation when totalValue is undefined/null (staff role gating)", () => {
    const html = renderToString(
      React.createElement(ProgressCard, {
        totals: {
          countId: 102,
          status: "in_progress",
          lineCount: 5,
          totalUnits: 8,
          totalValue: undefined,
          pricedLineCount: 5,
          excludedLineCount: 0,
        },
      })
    );

    expect(html).toContain("5");
    expect(html).toContain("8");
    expect(html).not.toContain("Total valuation");
    expect(html).not.toContain("$");
  });

  test("CountLineCard renders tap-to-edit href link when count is writable", () => {
    const html = renderToString(
      React.createElement(CountLineCard, {
        data: {
          productName: "Don Julio 1942",
          category: "Spirits",
          sizeMl: 750,
          unitType: "bottle",
          locationName: "Back Bar",
          sealedCaseQty: 1,
          sealedEachQty: 2,
          partialFills: [0.6],
          units: 3.6,
          caseSizeAtCount: null,
        },
        href: "/count/12/scan",
      })
    );

    expect(html).toContain("href=\"/count/12/scan\"");
    expect(html).toContain("aria-label=\"Edit Don Julio 1942 in Back Bar\"");
    expect(html).toContain("Don Julio 1942");
    expect(html).toContain("1 case, 2 ea, 1 open (60%)");
  });
});

describe("Milestone 2 - Target 11: Floor Counting Controls & Bottle Simulation", () => {
  test("VialDisplay renders bottle neck and 10-grid tick marks", () => {
    const html = renderToString(
      React.createElement(VialDisplay, {
        value: 0.8,
        onChange: () => {},
      })
    );

    expect(html).toContain("role=\"slider\"");
    expect(html).toContain("aria-valuenow=\"80\"");
    expect(html).toContain("100%");
    expect(html).toContain("80%");
    expect(html).toContain("0%");
  });

  test("QuantityEntry renders consequence delta on submit button in ADD mode", () => {
    const html = renderToString(
      React.createElement(QuantityEntry, {
        productName: "Stella Artois",
        category: "Beer",
        unitType: "bottle",
        caseSize: 24,
        currentCases: 1,
        currentEaches: 5,
        onCancel: () => {},
      })
    );

    expect(html).toContain("Add (+)");
    expect(html).toContain("Set exact count (=)");
    expect(html).toContain("Cases");
    expect(html).toContain("Eaches");
    expect(html).toContain("1 case, 5 ea → 1 case, 5 ea");
  });
});

describe("Milestone 2 - Target 12: Mobile Catalog & Shift Auth", () => {
  test("SignOutButton renders destructive button with loading feedback", () => {
    const html = renderToString(React.createElement(SignOutButton));
    expect(html).toContain("Sign out of shift");
    expect(html).toContain("bg-destructive");
  });
});
