/**
 * Pure unit tests for the null-value vocabulary —
 * components/ui/null-value.tsx, docs/design-system.md §8 point 5.
 *
 * The whole point of this component is that "no value here" is not one
 * case: three structurally different reasons render three structurally
 * different things (a dash, a real word, or nothing at all), and the audit
 * (P3.4) found seven ad-hoc strings and one styling choice doing this job
 * before this component existed. These tests assert the classification
 * directly, calling `NullValue` as a plain function (no rendering harness —
 * see tests/stock-cell.test.ts's header comment for why that's valid here).
 */
import { describe, test, expect } from "bun:test";
import { NullValue } from "@/components/ui/null-value";

describe("NullValue", () => {
  test('"not-applicable" renders an em dash, muted', () => {
    const el = NullValue({ reason: "not-applicable" })!;
    expect(el.props.children).toBe("—");
    expect(el.props.className).toContain("text-muted-foreground");
  });

  test('"not-entered" renders the word "Not entered", not a dash', () => {
    const el = NullValue({ reason: "not-entered" })!;
    expect(el.props.children).toBe("Not entered");
    expect(el.props.className).toContain("text-muted-foreground");
  });

  test('"not-applicable" and "not-entered" are never the same string — the P3.4 defect this component exists to end', () => {
    const notApplicable = NullValue({ reason: "not-applicable" })!;
    const notEntered = NullValue({ reason: "not-entered" })!;
    expect(notApplicable.props.children).not.toBe(notEntered.props.children);
  });

  test('"role-gated" renders NOTHING — no word, no dash, no styled box', () => {
    // Not an em dash, not an empty span, not a hidden span: `null`, so
    // nothing at all reaches the DOM for a value the viewer's role cannot
    // see (design-system.md §8 point 4 — never hide cost with CSS).
    expect(NullValue({ reason: "role-gated" })).toBeNull();
  });

  test('"not-entered" never renders at the small "caption" size (P3.4\'s specific defect: the single most load-bearing semantic rendered as the least legible text on screen)', () => {
    const el = NullValue({ reason: "not-entered" })!;
    expect(el.props.className).not.toContain("text-caption");
  });

  test('a caller CAN override the size for a bigger context (e.g. a stat tile) via className, and the override actually reaches the DOM', () => {
    const el = NullValue({ reason: "not-entered", className: "text-numeral-md" })!;
    expect(el.props.className).toContain("text-numeral-md");
  });

  test('"not-entered" is never rendered italic — same defect, the other half of it', () => {
    const el = NullValue({ reason: "not-entered" })!;
    expect(el.props.className).not.toContain("italic");
  });
});
