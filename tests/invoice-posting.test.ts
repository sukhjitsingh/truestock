/**
 * Invoice posting report — QA fixes F1, Slice 1 (tracer bullet).
 * docs/plans/invoice-qa-fixes/03-program-design.md, "Test plan".
 *
 * Covers `getInvoicePostingReport` (domain), `getInvoicePostingReportAction`
 * (boundary), the real classifier (slice 2) and approval posting. Plumbing: the role gate (invariant 8), the tenant scope (invariant 9)
 * and that every line is listed. Fixtures are synthetic.
 *
 * Session mocking follows tests/invoice-approval-path.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { db, closePool } from "@/db";
import { and, eq } from "drizzle-orm";
import { invoice, invoiceLine, product, productCostHistory, vendorAlias } from "@/db/schema";
import { approveInvoice, getInvoicePostingReport } from "@/lib/domain/invoice-approval";
import {
  classifyLineForPosting,
  effectivePackSize,
  type PostingCandidateLine,
} from "@/lib/domain/cost-derivation";
import { upsertAlias, matchLinesToProducts } from "@/lib/domain/matching";
import { applyLineReview, submitInvoiceReview, type DraftInvoiceLine } from "@/lib/domain/invoice-lines";
import { lineCorrectionSchema } from "@/lib/validation/invoices";
import { migrateTestDatabase, resetDatabase, createFixtures, type Fixtures } from "./helpers/test-db";

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

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
}));

let sessionUserId: number | null = null;

mock.module("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () => {
        if (sessionUserId == null) return null;
        return { session: { id: "mock-session" }, user: { id: String(sessionUserId) } };
      },
    },
  },
}));

let counter = 0;

async function insertInvoiceWithLines(lineCount: number): Promise<number> {
  counter += 1;
  const suffix = `posting-${counter}`;
  const [inv] = await db
    .insert(invoice)
    .values({
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      status: "reviewed",
      source: "pdf",
      filePath: `${fx.organizationId}/${suffix}.pdf`,
      fileSha256: suffix.padEnd(64, "0").slice(0, 64),
      fileSizeBytes: 999,
      pageCount: 1,
      invoiceDate: "2026-07-01",
      invoiceNumber: `POSTING-${suffix}`,
      totalGross: "100.0000",
      totalDiscount: "0.0000",
      totalNet: "100.0000",
      currency: "USD",
      retentionUntil: "2029-07-01",
    })
    .$returningId();
  for (let n = 1; n <= lineCount; n += 1) {
    await db.insert(invoiceLine).values({
      organizationId: fx.organizationId,
      invoiceId: inv.id,
      lineNumber: n,
      description: `Line ${n}`,
      lineType: "product",
      quantity: "2.000",
      packSize: 1,
      rawGross: "20.00",
      rawDiscount: "0.00",
      rawNet: "20.00",
      matchedProductId: n === 1 ? fx.pricedProductId : null,
      matchMethod: n === 1 ? "manual" : "unmatched",
    });
  }
  return inv.id;
}

describe("getInvoicePostingReport", () => {
  test("report lists every line with correct totalLines", async () => {
    const invoiceId = await insertInvoiceWithLines(4);
    const report = await getInvoicePostingReport(fx.owner, invoiceId);
    expect(report.totalLines).toBe(4);
    expect(report.lines).toHaveLength(4);
    expect(report.lines.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4]);
    expect(report.postedLines).toBe(report.lines.filter((l) => l.posted).length);
    expect(report.final).toBe(false); // reviewed, not approved
    expect(report.lines[0].productId).toBe(fx.pricedProductId);
    expect(report.lines[0].productName).not.toBeNull();
    expect(report.lines[1].productName).toBeNull();
  });

  test("report_refuses_other_tenant", async () => {
    const invoiceId = await insertInvoiceWithLines(2);
    await expect(
      (async () => getInvoicePostingReport(fx.otherOwner, invoiceId))(),
    ).rejects.toThrow();

    sessionUserId = fx.otherOwner.userId;
    const { getInvoicePostingReportAction } = await import("@/app/actions/invoices");
    const result = await getInvoicePostingReportAction({ invoiceId });
    expect(result.ok).toBe(false);
  });

  test("report_refuses_manager_and_staff", async () => {
    const invoiceId = await insertInvoiceWithLines(2);
    await expect((async () => getInvoicePostingReport(fx.manager, invoiceId))()).rejects.toThrow();
    await expect((async () => getInvoicePostingReport(fx.staff, invoiceId))()).rejects.toThrow();

    const { getInvoicePostingReportAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.manager.userId;
    expect((await getInvoicePostingReportAction({ invoiceId })).ok).toBe(false);
    sessionUserId = fx.staff.userId;
    expect((await getInvoicePostingReportAction({ invoiceId })).ok).toBe(false);
    sessionUserId = null;
    expect((await getInvoicePostingReportAction({ invoiceId })).ok).toBe(false);
  });

  test("owner action returns the report; malformed input refused by Zod", async () => {
    const invoiceId = await insertInvoiceWithLines(3);
    const { getInvoicePostingReportAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.owner.userId;
    const ok = await getInvoicePostingReportAction({ invoiceId });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("unreachable");
    expect(ok.data.totalLines).toBe(3);
    expect((await getInvoicePostingReportAction({ invoiceId: -1 })).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Slice 2: the real classifier (pure)
// ---------------------------------------------------------------------------

function cand(over: Partial<PostingCandidateLine> = {}): PostingCandidateLine {
  return {
    lineType: "product",
    uom: "case",
    quantity: "2.000",
    packSize: 12,
    rawNet: "48.00",
    matchedProductId: 1,
    ...over,
  };
}

describe("classifyLineForPosting", () => {
  test("classify_each_posts_without_pack_size", () => {
    const v = classifyLineForPosting(cand({ uom: "each", packSize: null, quantity: "4.000", rawNet: "10.00" }));
    expect(v).toEqual({ posts: true, unitCost: "2.5000", packSizeUsed: 1 });
  });

  test("classify_keg_posts_as_one", () => {
    const v = classifyLineForPosting(cand({ uom: "keg", packSize: null, quantity: "1.000", rawNet: "150.00" }));
    expect(v).toEqual({ posts: true, unitCost: "150.0000", packSizeUsed: 1 });
    expect(effectivePackSize({ uom: "keg", packSize: 7 })).toBe(1);
  });

  test("classify_each_ignores_parsed_pack_size", () => {
    const v = classifyLineForPosting(cand({ uom: "each", packSize: 12, quantity: "1.000", rawNet: "24.00" }));
    expect(v).toEqual({ posts: true, unitCost: "24.0000", packSizeUsed: 1 });
  });

  test("classify_case_without_pack_is_skipped", () => {
    expect(classifyLineForPosting(cand({ uom: "case", packSize: null }))).toEqual({
      posts: false,
      reason: "no_units_per_case",
    });
    const ok = classifyLineForPosting(cand({ uom: "case", packSize: 12 }));
    expect(ok).toEqual({ posts: true, unitCost: "2.0000", packSizeUsed: 12 });
  });

  test("classify_blank_and_other_uom_need_pack", () => {
    for (const uom of [null, "other"] as const) {
      expect(classifyLineForPosting(cand({ uom, packSize: null }))).toEqual({
        posts: false,
        reason: "no_units_per_case",
      });
      expect(classifyLineForPosting(cand({ uom, packSize: 6 })).posts).toBe(true);
    }
  });

  test("classify_reason_for_each_skip", () => {
    const reason = (o: Partial<PostingCandidateLine>) => {
      const v = classifyLineForPosting(cand(o));
      return v.posts ? "posts" : v.reason;
    };
    expect(reason({ lineType: "deposit" })).toBe("not_product_line");
    expect(reason({ lineType: "unknown" })).toBe("not_product_line");
    expect(reason({ matchedProductId: null })).toBe("not_matched");
    expect(reason({ rawNet: null })).toBe("no_net");
    expect(reason({ rawNet: "" })).toBe("no_net");
    expect(reason({ rawNet: "0.00" })).toBe("free_goods");
    expect(reason({ rawNet: "-5.00" })).toBe("credit");
    expect(reason({ quantity: null })).toBe("no_quantity");
    expect(reason({ quantity: "0.000" })).toBe("no_quantity");
    expect(reason({ packSize: null })).toBe("no_units_per_case");
    // Precedence: first match wins.
    expect(reason({ lineType: "freight", matchedProductId: null, rawNet: null })).toBe("not_product_line");
    expect(reason({ matchedProductId: null, rawNet: null })).toBe("not_matched");
    expect(reason({ rawNet: "0.00", quantity: null, packSize: null })).toBe("free_goods");
    expect(reason({ rawNet: "-1.00", quantity: null, packSize: null })).toBe("credit");
    expect(reason({ quantity: null, packSize: null })).toBe("no_quantity");
  });
});

// ---------------------------------------------------------------------------
// Slice 2: approval posts and reports (real MariaDB)
// ---------------------------------------------------------------------------

interface Spec {
  type?: "product" | "deposit";
  uom?: "each" | "case" | "keg" | "other" | null;
  quantity?: string | null;
  packSize?: number | null;
  rawNet?: string | null;
  productId?: number | null;
}

async function reviewedInvoice(specs: Spec[]): Promise<{ invoiceId: number; lineIds: number[] }> {
  const invoiceId = await insertInvoiceWithLines(0);
  const lineIds: number[] = [];
  let n = 0;
  for (const sp of specs) {
    n += 1;
    const [row] = await db
      .insert(invoiceLine)
      .values({
        organizationId: fx.organizationId,
        invoiceId,
        lineNumber: n,
        description: `Synthetic line ${n}`,
        lineType: sp.type ?? "product",
        uom: sp.uom ?? null,
        quantity: sp.quantity === undefined ? "2.000" : sp.quantity,
        packSize: sp.packSize === undefined ? null : sp.packSize,
        rawGross: sp.rawNet === undefined ? "20.00" : sp.rawNet,
        rawDiscount: "0.00",
        rawNet: sp.rawNet === undefined ? "20.00" : sp.rawNet,
        matchedProductId: sp.productId === undefined ? fx.pricedProductId : sp.productId,
        matchMethod: sp.productId === null ? "unmatched" : "manual",
      })
      .$returningId();
    lineIds.push(row.id);
  }
  return { invoiceId, lineIds };
}

async function historyRows(invoiceId: number) {
  return db
    .select()
    .from(productCostHistory)
    .where(and(eq(productCostHistory.organizationId, fx.organizationId), eq(productCostHistory.sourceInvoiceId, invoiceId)));
}

describe("approval posts and reports", () => {
  test("approval_posts_each_lines", async () => {
    const { invoiceId, lineIds } = await reviewedInvoice([
      { uom: "each", packSize: null, quantity: "4.000", rawNet: "10.00", productId: fx.pricedProductId },
    ]);
    const res = await approveInvoice(fx.owner, invoiceId);
    expect(res.costLinesApplied).toBe(1);
    const rows = await historyRows(invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceInvoiceLineId).toBe(lineIds[0]);
    expect(rows[0].unitCost).toBe("2.5000");
    const [p] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    expect(p.currentUnitCost).toBe("2.5000");
  });

  async function mixedInvoice() {
    return reviewedInvoice([
      { uom: "each", quantity: "4.000", rawNet: "10.00", productId: fx.pricedProductId }, // posts 2.5
      { uom: "keg", quantity: "1.000", rawNet: "150.00", productId: fx.secondProductId }, // posts 150
      { uom: "case", packSize: 6, quantity: "2.000", rawNet: "60.00", productId: fx.pricedProductId }, // posts 5
      { uom: "case", packSize: null, productId: fx.pricedProductId }, // no_units_per_case
      { type: "deposit", uom: null, productId: null }, // not_product_line
    ]);
  }

  test("approval_posts_what_it_can", async () => {
    const { invoiceId } = await mixedInvoice();
    const res = await approveInvoice(fx.owner, invoiceId);
    expect(res.invoice.status).toBe("approved");
    expect(res.costLinesApplied).toBe(3);
    expect(await historyRows(invoiceId)).toHaveLength(3);
    expect(res.report.final).toBe(true);
    expect(res.report.totalLines).toBe(5);
    expect(res.report.postedLines).toBe(3);
    expect(res.report.lines.map((l) => l.reason)).toEqual([null, null, null, "no_units_per_case", "not_product_line"]);
    expect(res.report.lines.map((l) => l.unitCost)).toEqual(["2.5000", "150.0000", "5.0000", null, null]);
  });

  test("approval_report_counts_rows_written", async () => {
    const { invoiceId } = await mixedInvoice();
    const res = await approveInvoice(fx.owner, invoiceId);
    const rows = await historyRows(invoiceId);
    expect(res.report.postedLines).toBe(rows.length);
    const byLine = new Map(rows.map((r) => [r.sourceInvoiceLineId, r.unitCost]));
    for (const l of res.report.lines) {
      expect(l.posted).toBe(byLine.has(l.lineId));
      expect(l.unitCost).toBe(byLine.get(l.lineId) ?? null);
    }
  });

  test("replay_returns_same_report", async () => {
    const { invoiceId } = await mixedInvoice();
    const first = await approveInvoice(fx.owner, invoiceId);
    const second = await approveInvoice(fx.owner, invoiceId);
    expect(second.costLinesApplied).toBe(0);
    expect(second.report).toEqual(first.report);
    expect(await historyRows(invoiceId)).toHaveLength(3);
    const fetched = await getInvoicePostingReport(fx.owner, invoiceId);
    expect(fetched).toEqual(first.report);
  });

  test("preview_matches_approval", async () => {
    const { invoiceId } = await mixedInvoice();
    const before = await getInvoicePostingReport(fx.owner, invoiceId);
    expect(before.final).toBe(false);
    const res = await approveInvoice(fx.owner, invoiceId);
    expect(res.report.final).toBe(true);
    expect(res.report.lines).toEqual(before.lines);
    expect(res.report.postedLines).toBe(before.postedLines);
  });

  test("final_report_reads_history_rows_not_classifier", async () => {
    const { invoiceId, lineIds } = await reviewedInvoice([
      { uom: "each", quantity: "4.000", rawNet: "10.00", productId: fx.pricedProductId }, // classifier says 2.5
      { uom: "each", quantity: "1.000", rawNet: "9.00", productId: fx.secondProductId }, // no history row
    ]);
    await db.update(invoice).set({ status: "approved" }).where(eq(invoice.id, invoiceId));
    await db.insert(productCostHistory).values({
      organizationId: fx.organizationId,
      productId: fx.pricedProductId,
      sourceInvoiceId: invoiceId,
      sourceInvoiceLineId: lineIds[0],
      unitCost: "7.7700",
      previousUnitCost: null,
      createdBy: fx.owner.userId,
    });
    const report = await getInvoicePostingReport(fx.owner, invoiceId);
    expect(report.final).toBe(true);
    expect(report.postedLines).toBe(1);
    expect(report.lines[0]).toMatchObject({ posted: true, unitCost: "7.7700", reason: null });
    expect(report.lines[1]).toMatchObject({ posted: false, unitCost: null, reason: "not_posted_at_approval" });
  });

  test("old_approved_invoice_reports_not_posted", async () => {
    // An invoice approved before the fix: an `each` line that would post now,
    // approved with no cost history row written for it.
    const { invoiceId, lineIds } = await reviewedInvoice([
      { uom: "each", quantity: "4.000", rawNet: "10.00", productId: fx.pricedProductId },
    ]);
    await db.update(invoice).set({ status: "approved" }).where(eq(invoice.id, invoiceId));
    expect(await historyRows(invoiceId)).toHaveLength(0);
    const report = await getInvoicePostingReport(fx.owner, invoiceId);
    expect(report.final).toBe(true);
    expect(report.postedLines).toBe(0);
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]).toMatchObject({
      lineId: lineIds[0],
      posted: false,
      unitCost: null,
      reason: "not_posted_at_approval",
    });
  });
});

// ---------------------------------------------------------------------------
// Slice 4: units per case, saved on the line and the vendor alias
// ---------------------------------------------------------------------------

async function aliasRow(code: string) {
  const [row] = await db
    .select()
    .from(vendorAlias)
    .where(
      and(
        eq(vendorAlias.organizationId, fx.organizationId),
        eq(vendorAlias.vendorId, fx.vendorId),
        eq(vendorAlias.vendorItemCode, code),
      ),
    );
  return row;
}

async function caseLine(code: string, productId: number | null = fx.pricedProductId) {
  const { invoiceId, lineIds } = await reviewedInvoice([
    { uom: "case", packSize: null, quantity: "2.000", rawNet: "60.00", productId },
  ]);
  await db.update(invoiceLine).set({ vendorItemCode: code }).where(eq(invoiceLine.id, lineIds[0]));
  return { invoiceId, lineId: lineIds[0] };
}

async function lineRow(id: number) {
  const [row] = await db.select().from(invoiceLine).where(eq(invoiceLine.id, id));
  return row;
}

function draft(over: Partial<DraftInvoiceLine>): DraftInvoiceLine {
  return {
    lineNumber: 1, rawText: null, lineType: "product", vendorItemCode: null, description: null,
    packDescription: null, quantity: null, uom: null, packSize: null, unitCost: null,
    extendedCost: null, rawGross: null, rawDiscount: null, rawNet: null, exceptionFlags: null,
    extractionConfidence: null, matchedProductId: null, matchedVendorAliasId: null,
    matchMethod: "unmatched", matchConfidence: null, ...over,
  };
}

describe("units per case (F1, slice 4)", () => {
  test("review_saves_pack_size_on_line_and_alias", async () => {
    const { invoiceId, lineId } = await caseLine("PK-1", null);
    const submit = async (c: Parameters<typeof submitInvoiceReview>[2]) => {
      await db.update(invoice).set({ status: "needs_review" }).where(eq(invoice.id, invoiceId));
      await submitInvoiceReview(fx.owner, invoiceId, c);
    };
    await submit([{ id: lineId, matchedProductId: fx.pricedProductId, packSize: 6 }]);
    expect((await lineRow(lineId)).packSize).toBe(6);
    expect((await aliasRow("PK-1")).packSize).toBe(6);

    // Pack-size-only edit on an already matched line reaches the alias too (learned on submit).
    await submit([{ id: lineId, packSize: 12 }]);
    expect((await lineRow(lineId)).packSize).toBe(12);
    expect((await aliasRow("PK-1")).packSize).toBe(12);
    // Clearing the line leaves what the alias remembers (null keeps).
    await submit([{ id: lineId, packSize: null }]);
    expect((await lineRow(lineId)).packSize).toBeNull();
    expect((await aliasRow("PK-1")).packSize).toBe(12);
  });

  test("review_rejects_zero_pack_size", async () => {
    const { invoiceId, lineId } = await caseLine("PK-2");
    for (const bad of [0, -3, 2.5, 10000, Number.NaN]) {
      await expect(applyLineReview(fx.owner, invoiceId, [{ id: lineId, packSize: bad }])).rejects.toThrow(
        "Units per case",
      );
      expect(lineCorrectionSchema.safeParse({ id: lineId, packSize: bad }).success).toBe(false);
    }
    expect((await lineRow(lineId)).packSize).toBeNull();
    expect(await aliasRow("PK-2")).toBeUndefined();
    for (const ok of [1, 9999, null]) {
      expect(lineCorrectionSchema.safeParse({ id: lineId, packSize: ok }).success).toBe(true);
    }
  });

  // No item code means no alias write, so only the line's own check can refuse this.
  test("review_rejects_bad_pack_size_on_a_line_with_no_item_code", async () => {
    const { invoiceId, lineIds } = await reviewedInvoice([
      { uom: "case", packSize: null, quantity: "2.000", rawNet: "60.00", productId: fx.pricedProductId },
    ]);
    for (const bad of [0, -3, 2.5, 10000]) {
      await expect(applyLineReview(fx.owner, invoiceId, [{ id: lineIds[0], packSize: bad }])).rejects.toThrow(
        "Units per case",
      );
    }
    expect((await lineRow(lineIds[0])).packSize).toBeNull();
  });

  test("alias_move_clears_pack_size", async () => {
    await upsertAlias(fx.organizationId, fx.vendorId, "PK-3", fx.pricedProductId, 24);
    const moved = await upsertAlias(fx.organizationId, fx.vendorId, "PK-3", fx.secondProductId, null);
    expect(moved.productId).toBe(fx.secondProductId);
    expect(moved.packSize).toBeNull();
    expect((await aliasRow("PK-3")).packSize).toBeNull();
    // A move that supplies a value takes it.
    const again = await upsertAlias(fx.organizationId, fx.vendorId, "PK-3", fx.pricedProductId, 4);
    expect(again.packSize).toBe(4);
  });

  test("alias_same_product_keeps_pack_size_on_null", async () => {
    await upsertAlias(fx.organizationId, fx.vendorId, "PK-4", fx.pricedProductId, 24);
    const kept = await upsertAlias(fx.organizationId, fx.vendorId, "PK-4", fx.pricedProductId, null);
    expect(kept.packSize).toBe(24);
    expect((await aliasRow("PK-4")).packSize).toBe(24);
    const replaced = await upsertAlias(fx.organizationId, fx.vendorId, "PK-4", fx.pricedProductId, 12);
    expect(replaced.packSize).toBe(12);
  });

  test("prematch_fills_remembered_pack_size", async () => {
    await upsertAlias(fx.organizationId, fx.vendorId, "PK-5", fx.pricedProductId, 6);
    const lines = [draft({ vendorItemCode: "PK-5", uom: "case" })];
    await matchLinesToProducts(lines, fx.organizationId, fx.vendorId);
    expect(lines[0].matchedProductId).toBe(fx.pricedProductId);
    expect(lines[0].packSize).toBe(6);
  });

  test("prematch_keeps_printed_pack_size", async () => {
    await upsertAlias(fx.organizationId, fx.vendorId, "PK-6", fx.pricedProductId, 6);
    const lines = [draft({ vendorItemCode: "PK-6", uom: "case", packSize: 12 })];
    await matchLinesToProducts(lines, fx.organizationId, fx.vendorId);
    expect(lines[0].matchedProductId).toBe(fx.pricedProductId);
    expect(lines[0].packSize).toBe(12);
  });

  test("case_line_with_reviewer_pack_size_posts_net_over_qty_over_pack", async () => {
    const { invoiceId, lineId } = await caseLine("PK-7");
    await applyLineReview(fx.owner, invoiceId, [{ id: lineId, packSize: 6 }]);
    const res = await approveInvoice(fx.owner, invoiceId);
    expect(res.costLinesApplied).toBe(1);
    const rows = await historyRows(invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].unitCost).toBe("5.0000"); // 60 / 2 / 6
    const [p] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    expect(p.currentUnitCost).toBe("5.0000");
  });
});
