import { resendInvoiceToExtraction } from "@/lib/domain/invoices";
import type { Actor } from "@/lib/authz";

/**
 * `resendInvoiceToExtraction` for tests that expect it to go through: narrows
 * the result to `resent`, and fails loudly if the file turned out to be held by
 * another invoice (so a fixture change cannot silently turn a resend into a
 * refusal and leave the assertions below reading `undefined`).
 */
export async function resendExpectingResent(actor: Actor, invoiceId: number) {
  const result = await resendInvoiceToExtraction(actor, invoiceId);
  if (result.outcome !== "resent") {
    throw new Error("expected the resend to go through, but another invoice holds this file");
  }
  return result;
}
