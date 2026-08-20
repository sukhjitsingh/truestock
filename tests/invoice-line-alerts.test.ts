/**
 * Pure unit tests for `lib/invoice-line-alerts.ts` — no database, no
 * fixtures. Phase 2.5 Slice 4 ("Cost Flow + Alerts",
 * docs/plans/phase-2.5-invoice-automation/04-slices.md).
 */
import { describe, expect, it } from "bun:test";
import { computeLineAlerts } from "@/lib/invoice-line-alerts";

describe("computeLineAlerts", () => {
  it("flags discount > 50% of gross", () => {
    const alerts = computeLineAlerts("100.00", "51.00", "49.00");
    expect(alerts.map((a) => a.key)).toContain("discount-over-50");
  });

  it("does not flag exactly 50% discount (strictly greater than)", () => {
    const alerts = computeLineAlerts("100.00", "50.00", "50.00");
    expect(alerts.map((a) => a.key)).not.toContain("discount-over-50");
  });

  it("does not flag a modest discount", () => {
    const alerts = computeLineAlerts("100.00", "10.00", "90.00");
    expect(alerts.map((a) => a.key)).not.toContain("discount-over-50");
  });

  it("flags negative net", () => {
    const alerts = computeLineAlerts("10.00", "20.00", "-10.00");
    expect(alerts.map((a) => a.key)).toContain("negative-net");
  });

  it("does not flag a positive or zero net", () => {
    expect(computeLineAlerts("10.00", "0.00", "10.00").map((a) => a.key)).not.toContain(
      "negative-net",
    );
    expect(computeLineAlerts("10.00", "10.00", "0.00").map((a) => a.key)).not.toContain(
      "negative-net",
    );
  });

  it("guards a zero gross against divide-by-zero instead of throwing or flagging", () => {
    expect(() => computeLineAlerts("0.00", "0.00", "0.00")).not.toThrow();
    expect(computeLineAlerts("0.00", "0.00", "0.00").map((a) => a.key)).not.toContain(
      "discount-over-50",
    );
  });

  it("guards a null/blank gross the same way", () => {
    expect(() => computeLineAlerts(null, "5.00", "5.00")).not.toThrow();
    expect(computeLineAlerts(null, "5.00", "5.00").map((a) => a.key)).not.toContain(
      "discount-over-50",
    );
    expect(computeLineAlerts("", "5.00", "5.00").map((a) => a.key)).not.toContain(
      "discount-over-50",
    );
  });

  it("treats unparseable values as absent rather than throwing", () => {
    expect(() => computeLineAlerts("abc", "def", "ghi")).not.toThrow();
    expect(computeLineAlerts("abc", "def", "ghi")).toEqual([]);
  });

  it("returns both alerts together when both conditions hold", () => {
    const alerts = computeLineAlerts("100.00", "60.00", "-10.00");
    expect(alerts.map((a) => a.key).sort()).toEqual(["discount-over-50", "negative-net"]);
  });

  it("returns no alerts for a clean line", () => {
    expect(computeLineAlerts("100.00", "5.00", "95.00")).toEqual([]);
  });

  it("null discount does not itself trigger the discount alert", () => {
    expect(computeLineAlerts("100.00", null, "100.00").map((a) => a.key)).not.toContain(
      "discount-over-50",
    );
  });
});
