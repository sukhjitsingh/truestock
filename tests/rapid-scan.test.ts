import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { product, count, productBarcode, countLine } from "@/db/schema";
import type { Actor } from "@/lib/authz";
import { scanCountLine } from "@/lib/domain/counts";
import { resetDatabase, createFixtures } from "./helpers/test-db";

describe("Rapid Scan Logic", () => {
  let actor: Actor;
  let countId: number;
  let locationId: number;
  let productId: number;
  let otherProductId: number;
  let otherOrganizationId: number;
  const eachBarcode = "EACH-RST-123";
  const caseBarcode = "CASE-RST-123";

  beforeEach(async () => {
    await resetDatabase();
    const fx = await createFixtures();
    actor = fx.owner;
    otherProductId = fx.otherProductId;
    otherOrganizationId = fx.otherOrganizationId;

    // Insert a product in the actor's org
    const [p] = await db.insert(product).values({
      name: "Rapid Scan Spirit",
      category: "Spirits",
      unitType: "bottle",
      sizeMl: 750,
      active: true,
      organizationId: fx.organizationId,
    }).$returningId();
    productId = p.id;

    locationId = fx.locationId;

    const [c] = await db.insert(count).values({
      organizationId: fx.organizationId,
      type: "full",
      status: "in_progress",
      openedBy: fx.owner.userId,
    }).$returningId();
    countId = c.id;

    await db.insert(productBarcode).values([
      { productId, barcode: eachBarcode, packLevel: "each", organizationId: fx.organizationId },
      { productId, barcode: caseBarcode, packLevel: "case", organizationId: fx.organizationId },
    ]);
  });

  it("increments sealed_each_qty for an each barcode", async () => {
    await scanCountLine(actor, {
      countId,
      locationId,
      barcode: eachBarcode,
      clientLineId: "rst-uuid-1",
      qty: 1,
    });

    const line = await db.query.countLine.findFirst({
      where: (cl, { and, eq }) => and(eq(cl.countId, countId), eq(cl.productId, productId)),
    });
    expect(line?.sealedEachQty).toBe(1);
    expect(line?.sealedCaseQty).toBe(0);
  });

  it("increments sealed_case_qty for a case barcode", async () => {
    await scanCountLine(actor, {
      countId,
      locationId,
      barcode: caseBarcode,
      clientLineId: "rst-uuid-2",
      qty: 1,
    });

    const line = await db.query.countLine.findFirst({
      where: (cl, { and, eq }) => and(eq(cl.countId, countId), eq(cl.productId, productId)),
    });
    expect(line?.sealedEachQty).toBe(0);
    expect(line?.sealedCaseQty).toBe(1);
  });

  it("maintains the idempotency invariant: N scans with N different IDs produce total N", async () => {
    for (const id of ["rst-id-1", "rst-id-2", "rst-id-3"]) {
      await scanCountLine(actor, {
        countId,
        locationId,
        barcode: eachBarcode,
        clientLineId: id,
        qty: 1,
      });
    }

    const line = await db.query.countLine.findFirst({
      where: (cl, { and, eq }) => and(eq(cl.countId, countId), eq(cl.productId, productId)),
    });
    expect(line?.sealedEachQty).toBe(3);
  });

  it("is idempotent when replaying the same client_line_id", async () => {
    const id = "rst-shared-id";
    await scanCountLine(actor, {
      countId, locationId, barcode: eachBarcode, clientLineId: id, qty: 1,
    });
    await scanCountLine(actor, {
      countId, locationId, barcode: eachBarcode, clientLineId: id, qty: 1,
    });

    const line = await db.query.countLine.findFirst({
      where: (cl, { and, eq }) => and(eq(cl.countId, countId), eq(cl.productId, productId)),
    });
    expect(line?.sealedEachQty).toBe(1);
  });

  it("throws NotFoundError for an unknown barcode", async () => {
    await expect(
      scanCountLine(actor, {
        countId,
        locationId,
        barcode: "UNKNOWN-BARCODE-404",
        clientLineId: "rst-uuid-none",
        qty: 1,
      })
    ).rejects.toThrow(/Product for this barcode/);
  });

  it("keeps cases and eaches apart on one line, and never opens a second (invariants 3 and 4)", async () => {
    // The rapid-mode case that matters: the same product scanned both ways.
    // Two case barcodes and three each barcodes must land on ONE line as
    // 2 cases + 3 eaches, never converted into each other at entry time and
    // never split across two rows.
    for (const id of ["mix-c1", "mix-c2"]) {
      await scanCountLine(actor, {
        countId, locationId, barcode: caseBarcode, clientLineId: id, qty: 1,
      });
    }
    for (const id of ["mix-e1", "mix-e2", "mix-e3"]) {
      await scanCountLine(actor, {
        countId, locationId, barcode: eachBarcode, clientLineId: id, qty: 1,
      });
    }

    const lines = await db
      .select()
      .from(countLine)
      .where(and(eq(countLine.countId, countId), eq(countLine.productId, productId)));

    expect(lines.length).toBe(1);
    expect(lines[0].sealedCaseQty).toBe(2);
    expect(lines[0].sealedEachQty).toBe(3);
  });

  it("refuses another tenant's barcode rather than resolving it (invariant 9)", async () => {
    // The barcode is real and the row exists — it just is not this tenant's.
    // Rapid mode resolves barcodes on the SERVER precisely so this decision
    // is never the client's to make, so the refusal is the thing to prove.
    // NotFound rather than a distinguishable error: an answer that confirms
    // the row is real is itself the leak invariant 9 rules out.
    const [otherProduct] = await db.select().from(product)
      .where(eq(product.id, otherProductId)).limit(1);
    expect(otherProduct).toBeDefined();

    await db.insert(productBarcode).values({
      productId: otherProductId,
      barcode: "OTHER-TENANT-BC",
      packLevel: "each",
      organizationId: otherOrganizationId,
    });

    await expect(
      scanCountLine(actor, {
        countId,
        locationId,
        barcode: "OTHER-TENANT-BC",
        clientLineId: "rst-cross-tenant",
        qty: 1,
      })
    ).rejects.toThrow(/Product for this barcode/);
  });
});
