/**
 * `deriveUnitCost` (lib/domain/cost-derivation.ts) turns an invoice line into
 * the number that becomes a product's `current_unit_cost` — and through it every
 * valuation the app prints. tests/invoice-approval-path.test.ts covers its basic
 * null/zero/deposit cases; this file covers the edges it leaves: blank and
 * unparseable strings, non-finite pack sizes, rounding, overflow, and which line
 * types reach it at all.
 *
 * Guards AGENTS.md invariant 2 (a cost is either exactly determined or it is
 * null — never a plausible-looking guess) and the "Deposits are never folded
 * into product cost" rule. Cases where the function is currently WRONG
 * (rawNet "", "0.00", "-60.00") are not here: they are in
 * tests/known-defects.test.ts as `test.failing`, so this file stays green and
 * honest about what it asserts.
 *
 * Mutations that must turn this file red:
 *   - lib/domain/cost-derivation.ts: `quantity <= 0` -> `quantity < 0`
 *     (blank/whitespace quantity: Number("") is 0, so it would divide by zero).
 *   - lib/domain/cost-derivation.ts: drop the `Number.isFinite(packSize)` guard.
 *   - lib/domain/cost-derivation.ts: `unitCost.toFixed(4)` -> `toFixed(2)`.
 *   - lib/domain/cost-derivation.ts: `rawNet / quantity / packSize` ->
 *     `rawNet / quantity * packSize`.
 *   - lib/domain/cost-derivation.ts: drop the final `Number.isFinite(unitCost)`.
 *   - lib/domain/invoice-approval.ts: delete `eq(invoiceLine.lineType,
 *     "product")` from the priceable-lines query (the DB describe below).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { invoice, invoiceLine, product, productCostHistory } from "@/db/schema";
import { deriveUnitCost, type DerivableCostLine } from "@/lib/domain/cost-derivation";
import { approveInvoice } from "@/lib/domain/invoice-approval";
import { migrateTestDatabase, resetDatabase, createFixtures, type Fixtures } from "./helpers/test-db";

const line = (over: Partial<DerivableCostLine> = {}): DerivableCostLine => ({
  lineType: "product",
  quantity: "12.000",
  packSize: 1,
  rawNet: "96.00",
  ...over,
});

describe("deriveUnitCost — arithmetic", () => {
  test("positive control: 96.00 / 12 / 1 is exactly '8.0000'", () => {
    // If this fails, every null-expecting test below could be passing because
    // the function returns null for everything.
    expect(deriveUnitCost(line())).toBe("8.0000");
  });

  test("always a string with exactly four decimal places (the DECIMAL(10,4) column's own scale)", () => {
    for (const [rawNet, quantity, packSize] of [
      ["5.00", "1.000", 1],
      ["96.00", "12.000", 1],
      ["10.00", "3.000", 1],
      ["180.00", "5.000", 24],
      ["0.01", "1000.000", 24],
    ] as const) {
      const out = deriveUnitCost(line({ rawNet, quantity, packSize }));
      expect(out).toMatch(/^\d+\.\d{4}$/);
    }
    expect(deriveUnitCost(line({ rawNet: "5.00", quantity: "1.000" }))).toBe("5.0000");
  });

  test("rounds to four places — it neither truncates nor stops at cents", () => {
    expect(deriveUnitCost(line({ rawNet: "10.00", quantity: "3.000" }))).toBe("3.3333");
    expect(deriveUnitCost(line({ rawNet: "20.00", quantity: "3.000" }))).toBe("6.6667"); // up, not 6.6666
  });

  test("the pack size divides; it never multiplies (180 / 5 cases / 24 per case = 1.50)", () => {
    expect(deriveUnitCost(line({ rawNet: "180.00", quantity: "5.000", packSize: 24 }))).toBe("1.5000");
    expect(deriveUnitCost(line({ rawNet: "180.00", quantity: "5.000", packSize: 1 }))).toBe("36.0000");
  });

  test("a fractional quantity is honoured (75.00 / 2.5 = 30)", () => {
    expect(deriveUnitCost(line({ rawNet: "75.00", quantity: "2.500" }))).toBe("30.0000");
  });

  test("a very small positive quantity is still a quantity (1.00 / 0.001 = 1000)", () => {
    expect(deriveUnitCost(line({ rawNet: "1.00", quantity: "0.001" }))).toBe("1000.0000");
  });

  test("does not mutate its input and is deterministic", () => {
    const input = line();
    const snapshot = { ...input };
    const first = deriveUnitCost(input);
    expect(deriveUnitCost(input)).toBe(first);
    expect(input).toEqual(snapshot);
  });
});

describe("deriveUnitCost — unusable inputs return null, never a guess", () => {
  test.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["words", "abc"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["negative zero", "-0"],
    ["zero", "0.000"],
    ["negative", "-1.000"],
  ])("quantity: %s", (_label, quantity) => {
    expect(deriveUnitCost(line({ quantity }))).toBeNull();
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["a whole negative case", -24],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("packSize: %s", (_label, packSize) => {
    expect(deriveUnitCost(line({ packSize }))).toBeNull();
  });

  test.each([
    ["words", "abc"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["-Infinity", "-Infinity"],
  ])("rawNet: %s", (_label, rawNet) => {
    expect(deriveUnitCost(line({ rawNet }))).toBeNull();
  });

  test("a result that overflows to Infinity is null, not the string 'Infinity'", () => {
    // 1e308 / ~1e-320 overflows a double.
    expect(deriveUnitCost(line({ rawNet: "1e308", quantity: "1e-320" }))).toBeNull();
  });

  test("never throws, whatever it is handed", () => {
    const garbage: DerivableCostLine[] = [
      line({ rawNet: "", quantity: "", packSize: Number.NaN }),
      line({ rawNet: "\u0000", quantity: "\n", packSize: -0 }),
      line({ rawNet: "9".repeat(400), quantity: "1.000" }),
      line({ rawNet: "1.00", quantity: "0.".repeat(50) }),
      line({ lineType: "unknown", rawNet: null, quantity: null, packSize: null }),
    ];
    for (const g of garbage) {
      expect(() => deriveUnitCost(g)).not.toThrow();
      const out = deriveUnitCost(g);
      expect(out === null || /^-?\d+\.\d{4}$/.test(out)).toBe(true);
    }
  });

  test("deposit and deposit_return refuse even with perfect numbers (and a deposit RETURN is negative money)", () => {
    expect(deriveUnitCost(line({ lineType: "deposit" }))).toBeNull();
    expect(deriveUnitCost(line({ lineType: "deposit_return", rawNet: "-96.00" }))).toBeNull();
  });
});

describe("which lines reach deriveUnitCost at all", () => {
  test("CHARACTERISATION: deriveUnitCost itself does NOT refuse freight/tax/fee/discount/unknown lines", () => {
    // Only deposits are refused inside the function. Keeping a freight or fee
    // line out of a product's cost is the CALLER's job — approveInvoice's
    // `line_type = 'product'` filter, pinned by the DB describe below. This
    // test exists so nobody removes that filter believing the function
    // already covers it.
    for (const lineType of ["freight", "tax", "fee", "discount", "unknown"] as const) {
      expect(deriveUnitCost(line({ lineType }))).toBe("8.0000");
    }
  });
});

// ---------------------------------------------------------------------------
// The caller's half of that contract
// ---------------------------------------------------------------------------

let fx: Fixtures;

beforeAll(async () => {
  await migrateTestDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  fx = await createFixtures();
});

afterAll(async () => {
  await closePool();
});

describe("approveInvoice — only product lines reach the cost write", () => {
  test("a freight/tax/fee/discount/unknown line matched to a product never changes its cost", async () => {
    // The fixture invoice sits in needs_review; approval needs `reviewed`.
    await db.update(invoice).set({ status: "reviewed" }).where(eq(invoice.id, fx.invoiceId));
    // Positive control: a PRODUCT line, fully determinable, on the priced product.
    await db
      .update(invoiceLine)
      .set({ packSize: 1, quantity: "12.000", rawNet: "216.00", rawGross: "216.00" })
      .where(eq(invoiceLine.id, fx.matchedInvoiceLineId));

    // Five non-product lines, each perfectly derivable, each matched to the
    // SECOND product (cost 31.2500). Any of them reaching deriveUnitCost would
    // overwrite that cost with 50.0000.
    const nonProduct = ["freight", "tax", "fee", "discount", "unknown"] as const;
    let lineNumber = 10;
    for (const lineType of nonProduct) {
      await db.insert(invoiceLine).values({
        organizationId: fx.organizationId,
        invoiceId: fx.invoiceId,
        lineNumber: lineNumber++,
        description: `Non-product ${lineType}`,
        lineType,
        quantity: "1.000",
        packSize: 1,
        rawGross: "50.00",
        rawDiscount: "0.00",
        rawNet: "50.00",
        matchedProductId: fx.secondProductId,
        matchMethod: "manual",
      });
    }

    const result = await approveInvoice(fx.owner, fx.invoiceId);

    expect(result.invoice.status).toBe("approved");
    expect(result.costLinesApplied).toBe(1); // the product line only

    const [priced] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    expect(priced.currentUnitCost).toBe("18.0000"); // 216 / 12 / 1 — the positive control moved
    const [second] = await db.select().from(product).where(eq(product.id, fx.secondProductId));
    expect(second.currentUnitCost).toBe("31.2500"); // untouched

    const history = await db
      .select()
      .from(productCostHistory)
      .where(eq(productCostHistory.productId, fx.secondProductId));
    expect(history).toHaveLength(0);
  });
});
