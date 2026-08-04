import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@/db";
import { product, count, productBarcode } from "@/db/schema";
import type { Actor } from "@/lib/authz";
import { scanCountLine } from "@/lib/domain/counts";
import { resetDatabase, createFixtures } from "./helpers/test-db";

describe("Rapid Scan Logic", () => {
  let actor: Actor;
  let countId: number;
  let locationId: number;
  let productId: number;
  const eachBarcode = "EACH-RST-123";
  const caseBarcode = "CASE-RST-123";

  beforeEach(async () => {
    await resetDatabase();
    const fx = await createFixtures();
    actor = fx.owner;

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
});
