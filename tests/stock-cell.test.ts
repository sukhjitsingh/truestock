/**
 * Pure unit tests for the stock-cell contract — components/ui/stock-cell.tsx,
 * components/ui/meter.tsx. Phase 2 UI redesign (docs/plans/phase-2-ui-redesign).
 *
 * No database, no rendering harness: `stockStatus` is a plain function, and
 * `StockCell`/`Meter` are called directly as functions (not through
 * react-dom) — a React function component invoked outside JSX returns the
 * plain object graph `React.createElement` built, which is enough to assert
 * structure (is a Meter element present at all, what are its props) without
 * a DOM. Importing the .tsx source works under `bun test` with no jsdom
 * setup — confirmed by probing before writing this file.
 *
 * The binding rule under test — "no-par-no-bar" — is stated hard in
 * docs/design-system.md §8 point 5 case 2 and restated in stock-cell.tsx's
 * own header comment: a product with no par renders its unit count alone,
 * with no Meter underneath it at all (never a bar drawn at 0%, which would
 * be visually identical to a genuinely empty product and mean the opposite
 * thing).
 */
import { describe, test, expect } from "bun:test";
import { stockStatus, StockCell } from "@/components/ui/stock-cell";
import { Meter } from "@/components/ui/meter";

// ---------------------------------------------------------------------------
// stockStatus() — the tone/label thresholds
// ---------------------------------------------------------------------------

describe("stockStatus", () => {
  test("onHand <= 0 is Out, negative tone — checked at the boundary and below it", () => {
    expect(stockStatus(0, 10)).toEqual({ tone: "negative", label: "Out" });
    expect(stockStatus(-1, 10)).toEqual({ tone: "negative", label: "Out" });
  });

  test("onHand / par < 0.5 is Low, warning tone", () => {
    expect(stockStatus(4, 10)).toEqual({ tone: "warning", label: "Low" });
    expect(stockStatus(1, 10)).toEqual({ tone: "warning", label: "Low" });
  });

  test("onHand / par === 0.5 is NOT Low — the boundary belongs to In stock, per the strict `< 0.5`", () => {
    // The exact boundary is the case that would flip silently under an
    // off-by-one mutation (`<=` in place of `<`). Asserted at exactly 0.5,
    // not just "somewhere above 0.5", so that mutation is what this test
    // is built to catch.
    expect(stockStatus(5, 10)).toEqual({ tone: "success", label: "In stock" });
  });

  test("onHand >= par is In stock, success tone", () => {
    expect(stockStatus(10, 10)).toEqual({ tone: "success", label: "In stock" });
    expect(stockStatus(15, 10)).toEqual({ tone: "success", label: "In stock" });
  });
});

// ---------------------------------------------------------------------------
// Meter — refuses to draw with no denominator (the primitive stock-cell
// depends on for "no-par-no-bar"; stock-cell adds no separate check of its
// own, so this is what actually enforces the rule).
// ---------------------------------------------------------------------------

describe("Meter", () => {
  test("renders null when max is absent", () => {
    expect(Meter({ value: 20 })).toBeNull();
  });

  test("renders null when max is null", () => {
    expect(Meter({ value: 20, max: null })).toBeNull();
  });

  test("renders null when max is zero or negative", () => {
    expect(Meter({ value: 20, max: 0 })).toBeNull();
    expect(Meter({ value: 20, max: -5 })).toBeNull();
  });

  test("renders a fill div sized to value/max when max is positive", () => {
    const el = Meter({ value: 5, max: 10, tone: "warning" })!;
    expect(el).not.toBeNull();
    // el.props.children is the inner fill <div>, styled to 50% width.
    const fill = el.props.children;
    expect(fill.props.style.width).toBe("50%");
  });
});

// ---------------------------------------------------------------------------
// StockCell — the no-par-no-bar contract at the component that actually
// ships in the catalog table.
// ---------------------------------------------------------------------------

describe("StockCell", () => {
  test("with no par, renders no Meter child at all (not a Meter at 0%)", () => {
    const el = StockCell({ onHand: 20, par: null })!;
    // <div>{span}{hasPar ? <Meter/> : null}</div> — second child is the slot
    // a Meter would occupy.
    const [, meterSlot] = el.props.children;
    expect(meterSlot).toBeNull();
  });

  test("with par <= 0, also renders no Meter child (matches Meter's own refusal)", () => {
    const el = StockCell({ onHand: 20, par: 0 })!;
    const [, meterSlot] = el.props.children;
    expect(meterSlot).toBeNull();
  });

  test("with a positive par, renders a Meter as the second child", () => {
    const el = StockCell({ onHand: 4, par: 10 })!;
    const [, meterSlot] = el.props.children;
    expect(meterSlot).not.toBeNull();
    expect(meterSlot.type).toBe(Meter);
    expect(meterSlot.props).toEqual({ value: 4, max: 10, tone: "warning" });
  });

  test("with no par, the status word (·Low/·In stock/·Out) is also absent — not just the bar", () => {
    // The unit-count span's own children array (["20", "", " ", "unit", status-node])
    // ends with `status ? <>...</> : null` — verified empirically, since JSX's
    // whitespace-collapsing rules make this array's exact shape non-obvious
    // from reading the source alone.
    const el = StockCell({ onHand: 20, par: null })!;
    const [span] = el.props.children;
    const spanChildren: unknown[] = span.props.children;
    expect(spanChildren[spanChildren.length - 1]).toBeNull();
  });
});
