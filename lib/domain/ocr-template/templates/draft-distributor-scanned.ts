/**
 * Template: a draft-beer distributor's thermal-printed delivery invoice, as
 * scanned or photographed (so the OCR path, not the native-text path).
 *
 * Printed columns: ID, PRODUCT, QTY, PRICE, DISC, NET, TOTAL. Per item row
 * the OCR yields up to three amounts — PRICE, NET, TOTAL — in an order that
 * differs by resolution, so the engine pairs them by value rather than by
 * position (`engine.ts:assignAmounts`). DISC printed blank on every row of
 * the validated sample, so a row that DOES carry a discount has four amounts
 * and fails closed to Vision.
 *
 * Observed row kinds:
 *   - product      `<code> <name> <n>/<m> Keg|Bottle|Can`, then amounts.
 *                  TOTAL can exceed NET by a keg deposit embedded in the row.
 *   - keg deposit  `<n>/<m> KEG EMPTY DEPOSIT`, a credit for a returned empty
 *                  (total printed in parentheses, i.e. negative) or a charge.
 *
 * `detect` is deliberately STRUCTURAL (form labels and the pack-token
 * shape), not the vendor's name, address or phone: those are real data that
 * must not live in the repo, and the form layout is what this template was
 * actually validated against. The cost is that another vendor on the same
 * invoicing software could be claimed by this template. That is acceptable
 * only because the gate (`gate.ts`) is the real guard; in production the
 * registry should be selected by the invoice's resolved vendor first and
 * `detect` kept as a second opinion.
 *
 * Validated on ONE scanned sample (see `docs/plans/pdf-ocr-spike/findings.md`).
 * Every pattern below is therefore a statement about that sample's shape,
 * and anything outside it is expected to fail closed.
 */
import { MONEY_TOKEN_SOURCE } from "../money";
import type { OcrVendorTemplate } from "../types";

export const draftDistributorScanned: OcrVendorTemplate = {
  key: "draft-distributor-scanned-v1",
  name: "Draft distributor, scanned 7-column delivery invoice",

  // Two anchors, not three: the "PRODUCT" column heading is dropped by the OCR
  // at 100 dpi on the validated sample, and a lost heading must not turn a
  // fully readable page into "no template".
  detect: [/\bLoad Sheet\b/, /\b\d+\/\d+\s+(?:Keg|Bottle|Can)\b/],

  header: {
    invoiceDate: new RegExp(String.raw`\b(?<month>\d{2})/(?<day>\d{2})/(?<year>\d{4})\b`),
    // The invoice number is the first 6-8 digit token after the date.
    invoiceNumber: /\b\d{2}\/\d{2}\/\d{4}\s+(\d{6,8})\b/,
    // "Total $X" then optionally a second, equal "$X"; a trailing "$0.00" is
    // the amount-received field, not a second printing of the total.
    printedTotal: new RegExp(
      String.raw`\bTotal\s+(${MONEY_TOKEN_SOURCE})(?:\s+(?!-?\$0\.00(?!\d))(${MONEY_TOKEN_SOURCE}))?`,
    ),
  },

  records: [
    {
      id: "product",
      anchor: new RegExp(
        String.raw`\b(?<code>\d{3,6})\s+(?<description>[A-Za-z][A-Za-z0-9&'.\- ]{1,59}?)\s+(?<pack>\d+/\d+)\s+(?<packWord>Keg|Bottle|Can)\b`,
      ),
      lineType: "product",
      quantity: new RegExp(String.raw`(?<![\w$.,/()-])(\d{1,3})(?=\s*-?\$)`),
      keepCode: true,
      uomByPackWord: { keg: "keg" },
    },
    {
      id: "keg-deposit",
      anchor: new RegExp(String.raw`(?<description>\d/\d\s+KEG\s+EMPTY\s+DEPOSIT)\b`, "i"),
      lineType: { positive: "deposit", negative: "deposit_return" },
      quantity: /\((\d{1,3})\)/,
      // The printed item id on this row ("86") was dropped by the OCR on some
      // resolutions; keeping it would make identical pages produce different
      // lines.
      keepCode: false,
    },
  ],

  footer: new RegExp(String.raw`\bTotal\s+(?=-?\$)`),
};
