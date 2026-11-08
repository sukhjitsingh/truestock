/**
 * Vendor order methods are a fixed list (QA 2026-11-08, finding 7).
 *
 * The form used to offer "Other…" with free text, so anything could be
 * stored ("Fax" was), and the vendors table printed the stored value raw:
 * "email" in lower case next to a typed "Fax". The owner's decision: a fixed
 * list — Email, Phone, Text message, Portal, Sales rep — with no free text,
 * and the table prints the label, never the stored value.
 */
import { describe, test, expect } from "bun:test";
import { ORDER_METHODS, orderMethodLabel } from "@/lib/vendor-order-methods";
import { vendorCreateSchema, vendorUpdateSchema } from "@/lib/validation/catalog";

describe("the order-method list", () => {
  test("is exactly the five methods the owner chose, in this order, with Text message", () => {
    expect(ORDER_METHODS.map((m) => m.label)).toEqual(["Email", "Phone", "Text message", "Portal", "Sales rep"]);
  });

  test("stored values are stable lower-case keys — the existing four are unchanged", () => {
    expect(ORDER_METHODS.map((m) => m.value)).toEqual(["email", "phone", "text", "portal", "rep"]);
  });
});

describe("orderMethodLabel — what the vendors table prints", () => {
  test("prints the capitalised label for every stored value", () => {
    expect(orderMethodLabel("email")).toBe("Email");
    expect(orderMethodLabel("text")).toBe("Text message");
    expect(orderMethodLabel("rep")).toBe("Sales rep");
  });

  test("null stays null, so the table can show 'Not entered'", () => {
    expect(orderMethodLabel(null)).toBeNull();
  });

  test("a value stored before the list was fixed is shown as stored, not hidden", () => {
    // Hiding it would make a real (if old) value look like 'Not entered'.
    expect(orderMethodLabel("Fax")).toBe("Fax");
  });
});

describe("the vendor schemas accept only the list", () => {
  test("create accepts each listed value and null", () => {
    for (const { value } of ORDER_METHODS) {
      expect(vendorCreateSchema.safeParse({ name: "V", orderMethod: value }).success).toBe(true);
    }
    expect(vendorCreateSchema.safeParse({ name: "V", orderMethod: null }).success).toBe(true);
    expect(vendorCreateSchema.safeParse({ name: "V" }).success).toBe(true);
  });

  test("create refuses free text — 'Fax', 'other', and a label instead of its value", () => {
    for (const orderMethod of ["Fax", "fax", "other", "Email", "Text message"]) {
      expect(vendorCreateSchema.safeParse({ name: "V", orderMethod }).success).toBe(false);
    }
  });

  test("update refuses free text the same way", () => {
    expect(vendorUpdateSchema.safeParse({ id: 1, orderMethod: "Fax" }).success).toBe(false);
    expect(vendorUpdateSchema.safeParse({ id: 1, orderMethod: "text" }).success).toBe(true);
  });
});
