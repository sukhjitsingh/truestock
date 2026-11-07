/**
 * `lib/domain/matching.ts` — Phase 2.5, Slice 3 ("Matching (Phase C)",
 * docs/plans/phase-2.5-invoice-automation/04-slices.md). Covers the three
 * acceptance criteria named there verbatim:
 *   - "First invoice from a new vendor: line gets unmatched item badge; user
 *     can map to product -> alias created."
 *   - "Second invoice from same vendor: same line is pre-matched; no badge;
 *     product pre-selected in the UI."
 *   - "upsertAlias is idempotent — calling it with the same (vendor_id,
 *     vendor_item_code) twice produces the same row."
 * Plus the null-vendorItemCode / null-invoice-vendorId cases the schema's
 * own `vendor_alias` comment leaves as "advisory, not enforced," and the
 * invariant-9 tenant-isolation case every domain file in this codebase is
 * expected to carry (AGENTS.md invariant 9: ownership-checked, not just
 * existence-checked).
 *
 * Deliberately separate from `tests/invoice-review-path.test.ts` (which
 * already covers `applyLineReviewTx`'s OWN ownership checks and its
 * matchMethod/exceptionFlags derivation) — this file is about the
 * vendor_alias side effect that Slice 3 adds to that same code path, and
 * about `matching.ts`'s exported functions directly.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { invoice, invoiceLine, vendor, vendorAlias } from "@/db/schema";
import {
  findAlias,
  upsertAlias,
  matchLinesToProducts,
  aliasKeyForLine,
  normalizeAliasDescription,
} from "@/lib/domain/matching";
import {
  submitInvoiceReview,
  writeExtractedLines,
  getLinesForInvoice,
  type DraftInvoiceLine,
} from "@/lib/domain/invoice-lines";
import { ConflictError } from "@/lib/domain/errors";
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

/** Mirrors tests/extraction-pipeline.test.ts's own draftLine helper — kept local rather than shared, the same "each test file owns its fixtures" convention this suite already follows. */
function draftLine(overrides: Partial<DraftInvoiceLine> = {}): DraftInvoiceLine {
  return {
    lineNumber: 1,
    rawText: null,
    lineType: "unknown",
    vendorItemCode: null,
    description: null,
    packDescription: null,
    quantity: null,
    uom: null,
    packSize: null,
    unitCost: null,
    extendedCost: null,
    rawGross: null,
    rawDiscount: null,
    rawNet: null,
    exceptionFlags: null,
    extractionConfidence: null,
    matchedProductId: null,
    matchedVendorAliasId: null,
    matchMethod: "unmatched",
    matchConfidence: null,
    ...overrides,
  };
}

function selectAliasRows(organizationId: number, vendorId: number, vendorItemCode: string) {
  return db
    .select()
    .from(vendorAlias)
    .where(
      and(
        eq(vendorAlias.organizationId, organizationId),
        eq(vendorAlias.vendorId, vendorId),
        eq(vendorAlias.vendorItemCode, vendorItemCode),
      ),
    );
}

describe("findAlias", () => {
  test("no alias yet for this (org, vendor, code) returns null, not an error", async () => {
    expect(await findAlias(fx.organizationId, fx.vendorId, "SKU-NONE")).toBeNull();
  });

  test("returns the row upsertAlias created, with the schema's own 0.500 starting confidence", async () => {
    await upsertAlias(fx.organizationId, fx.vendorId, "SKU-1", fx.pricedProductId, null);
    const found = await findAlias(fx.organizationId, fx.vendorId, "SKU-1");
    expect(found?.productId).toBe(fx.pricedProductId);
    expect(found?.matchConfidence).toBe("0.500");
  });
});

describe("upsertAlias — idempotency and the confidence rule", () => {
  test(
    "AC: upsertAlias is idempotent — calling it twice with the same (vendor_id, vendor_item_code) produces the SAME row, checked directly against the DB (one row, not two), not just a repeated return value. " +
      "MUTATION-CHECKED reasoning: a select-then-branch implementation (read, then insert-if-absent) can race two callers into inserting twice before either observes the other's row; asserting the DB's row COUNT catches that shape of bug in a way asserting only the returned object's fields would not.",
    async () => {
      const first = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-2", fx.pricedProductId, null);
      const second = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-2", fx.pricedProductId, null);
      expect(second.id).toBe(first.id);

      const rows = await selectAliasRows(fx.organizationId, fx.vendorId, "SKU-2");
      expect(rows).toHaveLength(1);
    },
  );

  test("reconfirming the SAME productId moves matchConfidence toward 1.000 without reaching it: 0.500 -> 0.750 -> 0.875", async () => {
    const first = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-3", fx.pricedProductId, null);
    expect(first.matchConfidence).toBe("0.500");
    const second = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-3", fx.pricedProductId, null);
    expect(second.matchConfidence).toBe("0.750");
    const third = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-3", fx.pricedProductId, null);
    expect(third.matchConfidence).toBe("0.875");
  });

  test("submitting a DIFFERENT productId for an already-aliased code overwrites productId and resets matchConfidence to 0.500 — a changed mapping is a fresh, unproven confirmation, not a continuation of the old one's trust", async () => {
    await upsertAlias(fx.organizationId, fx.vendorId, "SKU-4", fx.pricedProductId, null);
    await upsertAlias(fx.organizationId, fx.vendorId, "SKU-4", fx.pricedProductId, null); // -> 0.750
    const corrected = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-4", fx.secondProductId, null);
    expect(corrected.productId).toBe(fx.secondProductId);
    expect(corrected.matchConfidence).toBe("0.500");
  });
});

describe("matchLinesToProducts — the two-invoice acceptance criterion", () => {
  test("AC: first invoice from a new vendor — a line with a vendorItemCode and no existing alias stays unmatched (the pipeline's own 'unmatched item' badge is applied by runClaimedJob AFTER this call, never by this function itself)", async () => {
    const lines = [draftLine({ vendorItemCode: "SKU-NEW", lineNumber: 1 })];
    await matchLinesToProducts(lines, fx.organizationId, fx.vendorId);
    expect(lines[0].matchedProductId).toBeNull();
    expect(lines[0].matchedVendorAliasId).toBeNull();
    expect(lines[0].matchMethod).toBe("unmatched");
    expect(lines[0].exceptionFlags).toBeNull();
  });

  test(
    "AC: a human's manual match, once the review is SUBMITTED, creates a reusable alias — the line's own matchedProductId AND a vendor_alias row for (org, vendor, code) -> product now both exist. " +
      "fx.invoiceLineId starts with no vendorItemCode (test-db.ts's own fixture comment: most tests don't need one) — set directly here since this is the one test that does. " +
      "Alias learning moved out of applyLineReviewTx into one pass on submit (QA fixes F6, slice 5).",
    async () => {
      await db.update(invoiceLine).set({ vendorItemCode: "SKU-VENDOR-X" }).where(eq(invoiceLine.id, fx.invoiceLineId));

      await submitInvoiceReview(fx.owner, fx.invoiceId, [{ id: fx.invoiceLineId, matchedProductId: fx.pricedProductId }]);

      const [line] = await db.select().from(invoiceLine).where(eq(invoiceLine.id, fx.invoiceLineId));
      expect(line.matchedProductId).toBe(fx.pricedProductId);
      expect(line.matchMethod).toBe("manual");
      expect(line.exceptionFlags ?? []).not.toContain("unmatched item");
      // matchedVendorAliasId belongs to matchLinesToProducts alone (Slice 3's
      // schema comment on invoice_line.matchedVendorAliasId) — a MANUAL match
      // never sets it, even though it just created the alias as a side effect.
      expect(line.matchedVendorAliasId).toBeNull();

      const alias = await findAlias(fx.organizationId, fx.vendorId, "SKU-VENDOR-X");
      expect(alias).not.toBeNull();
      expect(alias?.productId).toBe(fx.pricedProductId);
    },
  );

  test(
    "AC: second invoice from the SAME vendor with the SAME vendor_item_code arrives pre-matched — matchLinesToProducts resolves matchedProductId/matchedVendorAliasId/matchConfidence from the alias a prior review created, and the line never needs the 'unmatched item' badge",
    async () => {
      const alias = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-REPEAT", fx.pricedProductId, null);

      const lines = [draftLine({ vendorItemCode: "SKU-REPEAT", lineNumber: 1 })];
      await matchLinesToProducts(lines, fx.organizationId, fx.vendorId);

      expect(lines[0].matchedProductId).toBe(fx.pricedProductId);
      expect(lines[0].matchedVendorAliasId).toBe(alias.id);
      expect(lines[0].matchMethod).toBe("vendor_alias_code");
      expect(lines[0].matchConfidence).toBe(alias.matchConfidence);

      // Mirrors runClaimedJob's OWN post-matching flagging loop
      // (lib/domain/extraction-pipeline.ts) verbatim: a matched line must not
      // receive the "unmatched item" badge.
      for (const line of lines) {
        if (line.matchedProductId == null) {
          line.exceptionFlags = [...(line.exceptionFlags ?? []), "unmatched item"];
        }
      }
      expect(lines[0].exceptionFlags).toBeNull();
    },
  );

  test("a batch of several lines only matches the ones whose vendorItemCode has an alias — one query, mixed outcomes", async () => {
    await upsertAlias(fx.organizationId, fx.vendorId, "SKU-A", fx.pricedProductId, null);
    await upsertAlias(fx.organizationId, fx.vendorId, "SKU-B", fx.secondProductId, null);

    const lines = [
      draftLine({ lineNumber: 1, vendorItemCode: "SKU-A" }),
      draftLine({ lineNumber: 2, vendorItemCode: "SKU-B" }),
      draftLine({ lineNumber: 3, vendorItemCode: "SKU-UNMAPPED" }),
    ];
    await matchLinesToProducts(lines, fx.organizationId, fx.vendorId);

    expect(lines[0].matchedProductId).toBe(fx.pricedProductId);
    expect(lines[1].matchedProductId).toBe(fx.secondProductId);
    expect(lines[2].matchedProductId).toBeNull();
  });

  test("a line with no vendorItemCode is left completely untouched — not an error, just nothing to match against", async () => {
    const lines = [draftLine({ vendorItemCode: null })];
    await expect(matchLinesToProducts(lines, fx.organizationId, fx.vendorId)).resolves.toBeUndefined();
    expect(lines[0].matchedProductId).toBeNull();
    expect(lines[0].matchMethod).toBe("unmatched");
  });

  test("an invoice with no vendorId at all (vendorId: null — no vendor recorded on the upload) leaves every line unmatched without erroring, even when every line has a vendorItemCode", async () => {
    const lines = [draftLine({ vendorItemCode: "SKU-ANY" })];
    await expect(matchLinesToProducts(lines, fx.organizationId, null)).resolves.toBeUndefined();
    expect(lines[0].matchedProductId).toBeNull();
  });

  test(
    "no_vendor_invoice_learns_nothing: an invoice with NO vendorId reaches reviewed, the line's own match is saved, no alias is written and nothing throws",
    async () => {
      const [noVendorInvoice] = await db
        .insert(invoice)
        .values({
          organizationId: fx.organizationId,
          vendorId: null,
          status: "needs_review",
          source: "pdf",
          filePath: `${fx.organizationId}/no-vendor.pdf`,
          fileSha256: "a".repeat(64),
          fileSizeBytes: 111,
          invoiceDate: "2026-06-01",
          invoiceNumber: "NO-VENDOR-1",
          totalGross: "10.0000",
          totalDiscount: "0.0000",
          totalNet: "10.0000",
          currency: "USD",
          retentionUntil: "2029-06-01",
        })
        .$returningId();
      const [line] = await db
        .insert(invoiceLine)
        .values({
          organizationId: fx.organizationId,
          invoiceId: noVendorInvoice.id,
          lineNumber: 1,
          lineType: "product",
          description: "Vendorless Gin 750ml",
          vendorItemCode: "SKU-NO-VENDOR",
        })
        .$returningId();

      const reviewed = await submitInvoiceReview(fx.owner, noVendorInvoice.id, [
        { id: line.id, matchedProductId: fx.pricedProductId },
      ]);
      expect(reviewed.status).toBe("reviewed");

      const [updatedLine] = await db.select().from(invoiceLine).where(eq(invoiceLine.id, line.id));
      expect(updatedLine.matchedProductId).toBe(fx.pricedProductId);

      const rows = await db.select().from(vendorAlias).where(eq(vendorAlias.organizationId, fx.organizationId));
      expect(rows).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// QA fixes F6, slice 5: the alias key, learned on submit, used by the next invoice
// ---------------------------------------------------------------------------

describe("aliasKeyForLine (F6)", () => {
  test("alias_key_prefers_item_code", () => {
    expect(aliasKeyForLine({ vendorItemCode: "SKU-9", description: "Anything at all" })).toBe("SKU-9");
  });

  test("alias_key_normalizes_case_and_spacing", () => {
    const a = aliasKeyForLine({ vendorItemCode: null, description: "Tito's  Handmade\tVodka 750ml " });
    const b = aliasKeyForLine({ vendorItemCode: null, description: "  TITO'S handmade vodka   750ML" });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(a!.startsWith("desc:")).toBe(true);
    expect(normalizeAliasDescription(" A\n B ")).toBe("a b");
    // A blank code falls through to the description.
    expect(aliasKeyForLine({ vendorItemCode: "  ", description: "Tito's Handmade Vodka 750ml" })).toBe(a);
  });

  test("alias_key_keeps_digits_apart", () => {
    const small = aliasKeyForLine({ vendorItemCode: null, description: "Jameson 750ml" });
    const handle = aliasKeyForLine({ vendorItemCode: null, description: "Jameson 1.75l" });
    expect(small).not.toBe(handle);
  });

  test("alias_key_null_when_nothing", () => {
    expect(aliasKeyForLine({ vendorItemCode: null, description: null })).toBeNull();
    expect(aliasKeyForLine({ vendorItemCode: null, description: "   " })).toBeNull();
    expect(aliasKeyForLine({ vendorItemCode: "", description: "" })).toBeNull();
  });

  test("alias_key_fits_column", () => {
    const key = aliasKeyForLine({ vendorItemCode: null, description: "x".repeat(512) });
    expect(key).not.toBeNull();
    expect(key!.length).toBe(48);
    expect(key!.length).toBeLessThanOrEqual(64);
  });
});

describe("alias learned from a line with no item code (F6, slice 5)", () => {
  async function aliasesForVendor() {
    return db
      .select()
      .from(vendorAlias)
      .where(and(eq(vendorAlias.organizationId, fx.organizationId), eq(vendorAlias.vendorId, fx.vendorId)));
  }

  test("review_learns_alias_without_item_code: the F6 regression — submit writes a desc-keyed alias for each matched line, with the reviewer's pack size", async () => {
    // Line 1 (Tito's, no code, unmatched) is matched and given 12 per case; line 2 (Bulleit) is already matched.
    await submitInvoiceReview(fx.owner, fx.invoiceId, [
      { id: fx.invoiceLineId, matchedProductId: fx.pricedProductId, packSize: 12 },
    ]);
    const rows = await aliasesForVendor();
    expect(rows).toHaveLength(2);
    const titoKey = aliasKeyForLine({ vendorItemCode: null, description: "Tito's Handmade Vodka 750ml" })!;
    const tito = rows.find((r) => r.vendorItemCode === titoKey);
    expect(tito?.productId).toBe(fx.pricedProductId);
    expect(tito?.packSize).toBe(12);
    const bulleit = rows.find(
      (r) => r.vendorItemCode === aliasKeyForLine({ vendorItemCode: null, description: "Bulleit Bourbon 750ml" }),
    );
    expect(bulleit?.productId).toBe(fx.pricedProductId);
    expect(bulleit?.packSize).toBeNull();
  });

  test("a line WITH an item code is remembered by the code, not also by its description", async () => {
    await db.update(invoiceLine).set({ vendorItemCode: "SKU-BOTH" }).where(eq(invoiceLine.id, fx.invoiceLineId));
    await submitInvoiceReview(fx.owner, fx.invoiceId, [{ id: fx.invoiceLineId, matchedProductId: fx.pricedProductId }]);
    const keys = (await aliasesForVendor()).map((r) => r.vendorItemCode);
    expect(keys).toContain("SKU-BOTH");
    expect(keys).not.toContain(aliasKeyForLine({ vendorItemCode: null, description: "Tito's Handmade Vodka 750ml" }));
  });

  test("a pack size correction on a line with NO item code reaches the alias", async () => {
    // Line 2 is already matched; only its pack size changes.
    await submitInvoiceReview(fx.owner, fx.invoiceId, [
      { id: fx.invoiceLineId, matchedProductId: fx.pricedProductId },
      { id: fx.matchedInvoiceLineId, packSize: 6 },
    ]);
    const key = aliasKeyForLine({ vendorItemCode: null, description: "Bulleit Bourbon 750ml" })!;
    expect((await findAlias(fx.organizationId, fx.vendorId, key))?.packSize).toBe(6);
  });

  test("a line with neither a code nor a description learns nothing, and the submit still succeeds", async () => {
    await db
      .update(invoiceLine)
      .set({ description: null, matchedProductId: fx.pricedProductId, matchMethod: "manual" })
      .where(eq(invoiceLine.id, fx.invoiceLineId));
    await db.delete(invoiceLine).where(eq(invoiceLine.id, fx.matchedInvoiceLineId));
    const reviewed = await submitInvoiceReview(fx.owner, fx.invoiceId, []);
    expect(reviewed.status).toBe("reviewed");
    expect(await aliasesForVendor()).toHaveLength(0);
  });

  test("deposit_line_never_learns_alias: a matched deposit line is skipped (a goods line beside it still learns)", async () => {
    await db
      .update(invoiceLine)
      .set({ lineType: "deposit", description: "Keg deposit", matchedProductId: fx.pricedProductId })
      .where(eq(invoiceLine.id, fx.invoiceLineId));
    await submitInvoiceReview(fx.owner, fx.invoiceId, []);
    const keys = (await aliasesForVendor()).map((r) => r.vendorItemCode);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(aliasKeyForLine({ vendorItemCode: null, description: "Bulleit Bourbon 750ml" })!);
  });

  test("a replayed submit is a Conflict and learns nothing a second time (confidence unchanged)", async () => {
    await submitInvoiceReview(fx.owner, fx.invoiceId, [{ id: fx.invoiceLineId, matchedProductId: fx.pricedProductId }]);
    const before = await aliasesForVendor();
    await expect(
      submitInvoiceReview(fx.owner, fx.invoiceId, [{ id: fx.invoiceLineId, matchedProductId: fx.pricedProductId }]),
    ).rejects.toBeInstanceOf(ConflictError);
    const after = await aliasesForVendor();
    expect(after.map((r) => [r.id, r.matchConfidence])).toEqual(before.map((r) => [r.id, r.matchConfidence]));
    expect(after.every((r) => r.matchConfidence === "0.500")).toBe(true);
  });

  test("second_invoice_prematches_by_description: review invoice 1, then extract invoice 2 from the same vendor — the line arrives pre-matched (vendor_alias_desc) with the remembered pack size, still for the reviewer to confirm", async () => {
    await submitInvoiceReview(fx.owner, fx.invoiceId, [
      { id: fx.invoiceLineId, matchedProductId: fx.pricedProductId, packSize: 12 },
    ]);

    // Invoice 2: same vendor, the description reformatted, no code. Goes through the real match + persist path.
    const [inv2] = await db
      .insert(invoice)
      .values({
        organizationId: fx.organizationId,
        vendorId: fx.vendorId,
        status: "processing",
        source: "pdf",
        filePath: `${fx.organizationId}/second.pdf`,
        fileSha256: "b".repeat(64),
        fileSizeBytes: 222,
      })
      .$returningId();
    const drafts = [
      draftLine({
        lineNumber: 1,
        lineType: "product",
        description: "TITO'S  HANDMADE VODKA 750ML",
        uom: "case",
        rawNet: "100.00",
      }),
      draftLine({ lineNumber: 2, lineType: "product", description: "Something never seen before" }),
    ];
    await matchLinesToProducts(drafts, fx.organizationId, fx.vendorId);
    await db.transaction((tx) => writeExtractedLines(tx, fx.owner, inv2.id, drafts));

    const lines = await getLinesForInvoice(fx.owner, inv2.id);
    expect(lines[0].matchedProductId).toBe(fx.pricedProductId);
    expect(lines[0].matchMethod).toBe("vendor_alias_desc");
    expect(lines[0].matchConfidence).toBe("0.500");
    expect(lines[0].packSize).toBe(12);
    expect(lines[1].matchedProductId).toBeNull();
    expect(lines[1].matchMethod).toBe("unmatched");

    // A pre-match is never an approval: the invoice itself did not move.
    const [after] = await db.select().from(invoice).where(eq(invoice.id, inv2.id));
    expect(after.status).toBe("processing");
  });
});

describe("alias rules on submit and pre-match (F6, slice 6)", () => {
  const TITO = "Tito's Handmade Vodka 750ml";
  const BULLEIT = "Bulleit Bourbon 750ml";
  const titoKey = () => aliasKeyForLine({ vendorItemCode: null, description: TITO })!;
  const bulleitKey = () => aliasKeyForLine({ vendorItemCode: null, description: BULLEIT })!;

  /** A reviewable invoice whose lines went through the real match + persist path. */
  async function reviewableInvoice(orgId: number, vendorId: number, descriptions: string[]): Promise<number> {
    const [inv] = await db
      .insert(invoice)
      .values({
        organizationId: orgId,
        vendorId,
        status: "needs_review",
        source: "pdf",
        filePath: `${orgId}/slice6-${Math.random().toString(36).slice(2)}.pdf`,
        fileSha256: Math.random().toString(16).slice(2).padEnd(64, "0").slice(0, 64),
        fileSizeBytes: 100,
        pageCount: 1,
        invoiceDate: "2026-06-02",
        invoiceNumber: `S6-${Math.random().toString(36).slice(2)}`,
        totalGross: "10.0000",
        totalDiscount: "0.0000",
        totalNet: "10.0000",
        currency: "USD",
        retentionUntil: "2029-06-02",
      })
      .$returningId();
    const drafts = descriptions.map((description, i) =>
      draftLine({ lineNumber: i + 1, lineType: "product", description, uom: "each", rawNet: "10.00" }),
    );
    await matchLinesToProducts(drafts, orgId, vendorId);
    const actor = orgId === fx.organizationId ? fx.owner : fx.otherOwner;
    await db.transaction((tx) => writeExtractedLines(tx, actor, inv.id, drafts));
    return inv.id;
  }

  async function learnFirstInvoice() {
    await submitInvoiceReview(fx.owner, fx.invoiceId, [
      { id: fx.invoiceLineId, matchedProductId: fx.pricedProductId },
    ]);
  }

  test("untouched_prematch_reconfirms_alias: a pre-matched line left alone and submitted climbs confidence 0.500 -> 0.750 -> 0.875, keeps its product, and a replay of that submit does not bump it again", async () => {
    await learnFirstInvoice();
    expect((await findAlias(fx.organizationId, fx.vendorId, titoKey()))?.matchConfidence).toBe("0.500");

    const inv2 = await reviewableInvoice(fx.organizationId, fx.vendorId, [TITO]);
    const [pre] = await getLinesForInvoice(fx.owner, inv2);
    expect(pre.matchMethod).toBe("vendor_alias_desc");
    expect(pre.matchedProductId).toBe(fx.pricedProductId);

    await submitInvoiceReview(fx.owner, inv2, []);
    const after = await findAlias(fx.organizationId, fx.vendorId, titoKey());
    expect(after?.matchConfidence).toBe("0.750");
    expect(after?.productId).toBe(fx.pricedProductId);
    // The line itself stays as the pre-match left it.
    expect((await getLinesForInvoice(fx.owner, inv2))[0].matchMethod).toBe("vendor_alias_desc");

    await expect(submitInvoiceReview(fx.owner, inv2, [])).rejects.toBeInstanceOf(ConflictError);
    expect((await findAlias(fx.organizationId, fx.vendorId, titoKey()))?.matchConfidence).toBe("0.750");

    const inv3 = await reviewableInvoice(fx.organizationId, fx.vendorId, [TITO]);
    await submitInvoiceReview(fx.owner, inv3, []);
    expect((await findAlias(fx.organizationId, fx.vendorId, titoKey()))?.matchConfidence).toBe("0.875");
  });

  test("a pre-match confirmed through the review form climbs confidence once: the form resends every line's product, so the line becomes manual and the alias still reconfirms", async () => {
    await learnFirstInvoice();
    const inv2 = await reviewableInvoice(fx.organizationId, fx.vendorId, [TITO]);
    const [pre] = await getLinesForInvoice(fx.owner, inv2);
    expect(pre.matchMethod).toBe("vendor_alias_desc");

    await submitInvoiceReview(fx.owner, inv2, [{ id: pre.id, matchedProductId: pre.matchedProductId }]);

    const after = await findAlias(fx.organizationId, fx.vendorId, titoKey());
    expect(after?.matchConfidence).toBe("0.750");
    expect(after?.productId).toBe(fx.pricedProductId);
    expect((await getLinesForInvoice(fx.owner, inv2))[0].matchMethod).toBe("manual");
  });

  test("alias_scoped_to_vendor: an alias learned under vendor A does not pre-match the same description under vendor B, and B learns its own row without touching A's", async () => {
    await learnFirstInvoice();
    const [vendorB] = await db
      .insert(vendor)
      .values({ organizationId: fx.organizationId, name: "Second Distributor" })
      .$returningId();

    const underB = [draftLine({ lineType: "product", description: TITO })];
    await matchLinesToProducts(underB, fx.organizationId, vendorB.id);
    expect(underB[0].matchedProductId).toBeNull();
    expect(underB[0].matchMethod).toBe("unmatched");

    const underA = [draftLine({ lineType: "product", description: TITO })];
    await matchLinesToProducts(underA, fx.organizationId, fx.vendorId);
    expect(underA[0].matchedProductId).toBe(fx.pricedProductId);

    // B's own review learns a separate row at 0.500; A's is not reconfirmed or moved.
    const invB = await reviewableInvoice(fx.organizationId, vendorB.id, [TITO]);
    const [lineB] = await getLinesForInvoice(fx.owner, invB);
    await submitInvoiceReview(fx.owner, invB, [{ id: lineB.id, matchedProductId: fx.secondProductId }]);
    const a = await findAlias(fx.organizationId, fx.vendorId, titoKey());
    const b = await findAlias(fx.organizationId, vendorB.id, titoKey());
    expect(a?.productId).toBe(fx.pricedProductId);
    expect(a?.matchConfidence).toBe("0.500");
    expect(b?.productId).toBe(fx.secondProductId);
    expect(b?.matchConfidence).toBe("0.500");
  });

  test("alias_scoped_to_org: a description-keyed alias in org A never pre-matches for org B, even with the same vendorId value; org B learns its own", async () => {
    await learnFirstInvoice();
    expect((await findAlias(fx.organizationId, fx.vendorId, titoKey()))?.productId).toBe(fx.pricedProductId);

    const sameVendorValue = [draftLine({ lineType: "product", description: TITO })];
    await matchLinesToProducts(sameVendorValue, fx.otherOrganizationId, fx.vendorId);
    expect(sameVendorValue[0].matchedProductId).toBeNull();

    const theirVendor = [draftLine({ lineType: "product", description: TITO })];
    await matchLinesToProducts(theirVendor, fx.otherOrganizationId, fx.otherVendorId);
    expect(theirVendor[0].matchedProductId).toBeNull();

    const theirInvoice = await reviewableInvoice(fx.otherOrganizationId, fx.otherVendorId, [TITO]);
    const [theirLine] = await getLinesForInvoice(fx.otherOwner, theirInvoice);
    await submitInvoiceReview(fx.otherOwner, theirInvoice, [
      { id: theirLine.id, matchedProductId: fx.otherProductId },
    ]);
    expect((await findAlias(fx.otherOrganizationId, fx.otherVendorId, titoKey()))?.productId).toBe(
      fx.otherProductId,
    );
    const mine = await findAlias(fx.organizationId, fx.vendorId, titoKey());
    expect(mine?.productId).toBe(fx.pricedProductId);
    expect(mine?.matchConfidence).toBe("0.500");
  });

  /** Adds a third line to the fixture invoice that shares line 2's key (a supplier printing one item twice, once as free goods). */
  async function addDuplicateKeyLine(productId: number, packSize: number | null) {
    await db.insert(invoiceLine).values({
      organizationId: fx.organizationId,
      invoiceId: fx.invoiceId,
      lineNumber: 3,
      description: "BULLEIT  bourbon 750ML",
      lineType: "product",
      quantity: "1.000",
      uom: "each",
      unitCost: "0.0000",
      extendedCost: "0.00",
      rawGross: "0.00",
      rawDiscount: "0.00",
      rawNet: "0.00",
      packSize,
      matchedProductId: productId,
      matchMethod: "manual",
    });
  }

  test("two_lines_same_key_one_upsert: two lines on one invoice sharing a key give one alias row and ONE confidence step, not two", async () => {
    await addDuplicateKeyLine(fx.pricedProductId, null);
    await submitInvoiceReview(fx.owner, fx.invoiceId, [
      { id: fx.invoiceLineId, matchedProductId: fx.pricedProductId },
    ]);
    const rows = await selectAliasRows(fx.organizationId, fx.vendorId, bulleitKey());
    expect(rows).toHaveLength(1);
    // Two upserts would have reconfirmed to 0.750.
    expect(rows[0].matchConfidence).toBe("0.500");
  });

  test("two_lines_same_key_one_upsert: when the lines disagree, the later line wins, product and pack size", async () => {
    await addDuplicateKeyLine(fx.secondProductId, 24);
    await submitInvoiceReview(fx.owner, fx.invoiceId, [
      { id: fx.invoiceLineId, matchedProductId: fx.pricedProductId },
      { id: fx.matchedInvoiceLineId, packSize: 12 },
    ]);
    const rows = await selectAliasRows(fx.organizationId, fx.vendorId, bulleitKey());
    expect(rows).toHaveLength(1);
    expect(rows[0].productId).toBe(fx.secondProductId);
    expect(rows[0].packSize).toBe(24);
    expect(rows[0].matchConfidence).toBe("0.500");
  });
});

describe("tenant isolation [invariant 9]", () => {
  test(
    "an alias created under org A's own vendorId is invisible to a caller passing org B's organizationId with that SAME vendorId value — findAlias must filter on organizationId, not vendorId alone. " +
      "MUTATION-CHECKED reasoning: if findAlias's WHERE clause dropped the organizationId predicate, this call would return org A's real alias (which product org A maps a vendor SKU to) to a caller acting as org B.",
    async () => {
      await upsertAlias(fx.organizationId, fx.vendorId, "SKU-SHARED", fx.pricedProductId, null);
      const leaked = await findAlias(fx.otherOrganizationId, fx.vendorId, "SKU-SHARED");
      expect(leaked).toBeNull();
    },
  );

  test("matchLinesToProducts scoped to org B never resolves a line against org A's alias, even when both are queried with the SAME vendorId value and vendor_item_code string", async () => {
    await upsertAlias(fx.organizationId, fx.vendorId, "SKU-SHARED-2", fx.pricedProductId, null);

    const lines = [draftLine({ vendorItemCode: "SKU-SHARED-2" })];
    await matchLinesToProducts(lines, fx.otherOrganizationId, fx.vendorId);
    expect(lines[0].matchedProductId).toBeNull();
  });

  test("two unrelated tenants can independently alias the SAME vendor_item_code string to their own different products with no collision (each keyed by its own organizationId + vendorId)", async () => {
    const orgAlias = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-COMMON", fx.pricedProductId, null);
    const otherAlias = await upsertAlias(fx.otherOrganizationId, fx.otherVendorId, "SKU-COMMON", fx.otherProductId, null);

    expect(orgAlias.productId).toBe(fx.pricedProductId);
    expect(otherAlias.productId).toBe(fx.otherProductId);
    expect((await findAlias(fx.organizationId, fx.vendorId, "SKU-COMMON"))?.productId).toBe(fx.pricedProductId);
    expect((await findAlias(fx.otherOrganizationId, fx.otherVendorId, "SKU-COMMON"))?.productId).toBe(
      fx.otherProductId,
    );
  });
});

/**
 * Code-reviewer finding (post-Slice-3 review, 2026-08-15): `upsertAliasCore`'s
 * duplicate-key recovery branch takes a `SELECT ... FOR UPDATE` on the
 * existing row before branching reconfirm-vs-reset. Under 3+ concurrent
 * callers upserting the SAME `(organizationId, vendorId, vendorItemCode)` —
 * e.g. two reviewers correcting the same vendor SKU at once — InnoDB can pick
 * one as a deadlock victim (1213), which `isDuplicateKeyError` does not
 * recognise (it only matches 1062), so the raw driver error used to propagate
 * out of `upsertAliasTx` -> `applyLineReviewTx` -> `submitInvoiceReview`'s
 * enclosing transaction and roll back an entire review submission. Fixed by
 * wrapping the outer `db.transaction(...)` call in `withLockRetry` (reusing
 * `lib/domain/db-errors.ts`'s existing helper — the same one
 * `lib/domain/counts.ts` already uses for the analogous `count_line` gap-lock
 * deadlock) at BOTH of `upsertAliasCore`'s two callers: `matching.ts`'s own
 * standalone `upsertAlias`, and `invoice-lines.ts`'s `submitInvoiceReview`
 * (which cannot be fixed by wrapping `upsertAliasTx`'s own call alone, since
 * that runs mid-transaction sharing the caller's `tx` — a deadlock rolls the
 * WHOLE transaction back, so only retrying the whole thing recovers).
 *
 * Both tests below run REAL concurrent transactions against real MariaDB
 * (`Promise.all`, not mocks) so they actually contend for the same row lock —
 * without the fix, either could intermittently surface an unhandled 1213
 * instead of the assertions below.
 */
describe("concurrent upserts of the same alias key — the lock-conflict retry fix", () => {
  test(
    "3 simultaneous upsertAlias calls for the SAME (org, vendor, vendorItemCode) all resolve — none surfaces a raw 1213 — and converge to exactly the state a sequential run would produce: one row, confidence walked 0.500 -> 0.750 -> 0.875. " +
      "That final value is deterministic regardless of which call wins the INSERT race or how withLockRetry's retries interleave: exactly one call ever inserts (0.500 default), and the other two are forced through the SAME row lock in upsertAliasCore's `SELECT ... FOR UPDATE` recovery branch one at a time, each reconfirming whatever the immediately-prior commit left behind.",
    async () => {
      const results = await Promise.all([
        upsertAlias(fx.organizationId, fx.vendorId, "SKU-CONCURRENT", fx.pricedProductId, null),
        upsertAlias(fx.organizationId, fx.vendorId, "SKU-CONCURRENT", fx.pricedProductId, null),
        upsertAlias(fx.organizationId, fx.vendorId, "SKU-CONCURRENT", fx.pricedProductId, null),
      ]);

      for (const row of results) {
        expect(row.productId).toBe(fx.pricedProductId);
      }

      const rows = await selectAliasRows(fx.organizationId, fx.vendorId, "SKU-CONCURRENT");
      expect(rows).toHaveLength(1);
      expect(rows[0].matchConfidence).toBe("0.875");
    },
  );

  test(
    "3 simultaneous submitInvoiceReview calls — three DIFFERENT invoices, each with one line carrying the SAME vendor_item_code for the SAME vendor, each reviewer mapping it to the SAME product — mirrors 'two reviewers correcting the same vendor SKU at once' through the REAL production path (submitInvoiceReview, not upsertAlias directly). All three submissions must reach `reviewed` and the alias table converges to one row, proving the retry belongs at submitInvoiceReview's OUTER transaction: wrapping upsertAliasTx's own call alone could not recover here, since a deadlock rolls the corrections and the status CAS back together.",
    async () => {
      const vendorItemCode = "SKU-REVIEW-CONCURRENT";
      const targets: { invoiceId: number; lineId: number }[] = [];
      for (let i = 0; i < 3; i++) {
        const [inv] = await db
          .insert(invoice)
          .values({
            organizationId: fx.organizationId,
            vendorId: fx.vendorId,
            status: "needs_review",
            source: "pdf",
            filePath: `${fx.organizationId}/concurrent-review-${i}.pdf`,
            fileSha256: `${i}`.repeat(64).slice(0, 64),
            fileSizeBytes: 100 + i,
            invoiceDate: "2026-06-01",
            invoiceNumber: `CONCURRENT-REVIEW-${i}`,
            totalGross: "10.0000",
            totalDiscount: "0.0000",
            totalNet: "10.0000",
            currency: "USD",
            retentionUntil: "2029-06-01",
          })
          .$returningId();
        const [line] = await db
          .insert(invoiceLine)
          .values({
            organizationId: fx.organizationId,
            invoiceId: inv.id,
            lineNumber: 1,
            vendorItemCode,
            matchMethod: "unmatched",
          })
          .$returningId();
        targets.push({ invoiceId: inv.id, lineId: line.id });
      }

      const results = await Promise.all(
        targets.map(({ invoiceId, lineId }) =>
          submitInvoiceReview(fx.owner, invoiceId, [{ id: lineId, matchedProductId: fx.pricedProductId }]),
        ),
      );

      for (const row of results) {
        expect(row.status).toBe("reviewed");
      }

      const rows = await selectAliasRows(fx.organizationId, fx.vendorId, vendorItemCode);
      expect(rows).toHaveLength(1);
      expect(rows[0].productId).toBe(fx.pricedProductId);
    },
  );
});
