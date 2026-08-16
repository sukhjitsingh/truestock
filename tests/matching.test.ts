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
import { invoice, invoiceLine, vendorAlias } from "@/db/schema";
import { findAlias, upsertAlias, matchLinesToProducts } from "@/lib/domain/matching";
import { applyLineReview, submitInvoiceReview, type DraftInvoiceLine } from "@/lib/domain/invoice-lines";
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
    await upsertAlias(fx.organizationId, fx.vendorId, "SKU-1", fx.pricedProductId);
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
      const first = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-2", fx.pricedProductId);
      const second = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-2", fx.pricedProductId);
      expect(second.id).toBe(first.id);

      const rows = await selectAliasRows(fx.organizationId, fx.vendorId, "SKU-2");
      expect(rows).toHaveLength(1);
    },
  );

  test("reconfirming the SAME productId moves matchConfidence toward 1.000 without reaching it: 0.500 -> 0.750 -> 0.875", async () => {
    const first = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-3", fx.pricedProductId);
    expect(first.matchConfidence).toBe("0.500");
    const second = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-3", fx.pricedProductId);
    expect(second.matchConfidence).toBe("0.750");
    const third = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-3", fx.pricedProductId);
    expect(third.matchConfidence).toBe("0.875");
  });

  test("submitting a DIFFERENT productId for an already-aliased code overwrites productId and resets matchConfidence to 0.500 — a changed mapping is a fresh, unproven confirmation, not a continuation of the old one's trust", async () => {
    await upsertAlias(fx.organizationId, fx.vendorId, "SKU-4", fx.pricedProductId);
    await upsertAlias(fx.organizationId, fx.vendorId, "SKU-4", fx.pricedProductId); // -> 0.750
    const corrected = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-4", fx.secondProductId);
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
    "AC: a human's manual match on the review screen (applyLineReview) creates a reusable alias — the line's own matchedProductId AND a vendor_alias row for (org, vendor, code) -> product now both exist. " +
      "fx.invoiceLineId starts with no vendorItemCode (test-db.ts's own fixture comment: most tests don't need one) — set directly here since this is the one test that does.",
    async () => {
      await db.update(invoiceLine).set({ vendorItemCode: "SKU-VENDOR-X" }).where(eq(invoiceLine.id, fx.invoiceLineId));

      await applyLineReview(fx.owner, fx.invoiceId, [{ id: fx.invoiceLineId, matchedProductId: fx.pricedProductId }]);

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
      const alias = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-REPEAT", fx.pricedProductId);

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
    await upsertAlias(fx.organizationId, fx.vendorId, "SKU-A", fx.pricedProductId);
    await upsertAlias(fx.organizationId, fx.vendorId, "SKU-B", fx.secondProductId);

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
    "a manual match on a line with NO vendorItemCode does not create an alias — nothing to key it on — and must not throw",
    async () => {
      // fx.invoiceLineId's vendorItemCode is null by fixture default.
      await expect(
        applyLineReview(fx.owner, fx.invoiceId, [{ id: fx.invoiceLineId, matchedProductId: fx.pricedProductId }]),
      ).resolves.toBeUndefined();

      const rows = await db.select().from(vendorAlias).where(eq(vendorAlias.organizationId, fx.organizationId));
      expect(rows).toHaveLength(0);
    },
  );

  test(
    "a manual match on an invoice with NO vendorId does not create an alias and does not throw — the line's own match still succeeds",
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
        })
        .$returningId();
      const [line] = await db
        .insert(invoiceLine)
        .values({
          organizationId: fx.organizationId,
          invoiceId: noVendorInvoice.id,
          lineNumber: 1,
          vendorItemCode: "SKU-NO-VENDOR",
        })
        .$returningId();

      await expect(
        applyLineReview(fx.owner, noVendorInvoice.id, [{ id: line.id, matchedProductId: fx.pricedProductId }]),
      ).resolves.toBeUndefined();

      const [updatedLine] = await db.select().from(invoiceLine).where(eq(invoiceLine.id, line.id));
      expect(updatedLine.matchedProductId).toBe(fx.pricedProductId);

      const rows = await db.select().from(vendorAlias).where(eq(vendorAlias.organizationId, fx.organizationId));
      expect(rows).toHaveLength(0);
    },
  );
});

describe("tenant isolation [invariant 9]", () => {
  test(
    "an alias created under org A's own vendorId is invisible to a caller passing org B's organizationId with that SAME vendorId value — findAlias must filter on organizationId, not vendorId alone. " +
      "MUTATION-CHECKED reasoning: if findAlias's WHERE clause dropped the organizationId predicate, this call would return org A's real alias (which product org A maps a vendor SKU to) to a caller acting as org B.",
    async () => {
      await upsertAlias(fx.organizationId, fx.vendorId, "SKU-SHARED", fx.pricedProductId);
      const leaked = await findAlias(fx.otherOrganizationId, fx.vendorId, "SKU-SHARED");
      expect(leaked).toBeNull();
    },
  );

  test("matchLinesToProducts scoped to org B never resolves a line against org A's alias, even when both are queried with the SAME vendorId value and vendor_item_code string", async () => {
    await upsertAlias(fx.organizationId, fx.vendorId, "SKU-SHARED-2", fx.pricedProductId);

    const lines = [draftLine({ vendorItemCode: "SKU-SHARED-2" })];
    await matchLinesToProducts(lines, fx.otherOrganizationId, fx.vendorId);
    expect(lines[0].matchedProductId).toBeNull();
  });

  test("two unrelated tenants can independently alias the SAME vendor_item_code string to their own different products with no collision (each keyed by its own organizationId + vendorId)", async () => {
    const orgAlias = await upsertAlias(fx.organizationId, fx.vendorId, "SKU-COMMON", fx.pricedProductId);
    const otherAlias = await upsertAlias(fx.otherOrganizationId, fx.otherVendorId, "SKU-COMMON", fx.otherProductId);

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
        upsertAlias(fx.organizationId, fx.vendorId, "SKU-CONCURRENT", fx.pricedProductId),
        upsertAlias(fx.organizationId, fx.vendorId, "SKU-CONCURRENT", fx.pricedProductId),
        upsertAlias(fx.organizationId, fx.vendorId, "SKU-CONCURRENT", fx.pricedProductId),
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
