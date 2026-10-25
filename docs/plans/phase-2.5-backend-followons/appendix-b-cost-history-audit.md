# Appendix B — invoice cost-history / cost-posting audit (grounds Gate 1 Part B)

Reference material, not a gate doc. Written from `db/schema.ts` and
`lib/domain/invoice-approval.ts`, `lib/domain/invoices.ts`, and
`tests/invoice-approval-path.test.ts`, re-read directly 2026-08-23 via
CodeGraph.

## What exists today (write path — confirmed solid, not in scope to change)

`approveInvoice` (`lib/domain/invoice-approval.ts:122`), inside one
transaction:

1. Row-locks the invoice (`FOR UPDATE`), refuses anything not in `reviewed`
   status, no-ops (returns the prior result) on a replay of an already-
   `approved` invoice.
2. For every `product`-type line with a `matchedProductId` and a derivable
   `unitCost` (`deriveUnitCost`, `lib/domain/cost-derivation.ts:66`):
   - row-locks the matched `product` (`FOR UPDATE`) — **ownership-checked**,
     not just existence-checked (invariant 9) — a cross-tenant
     `matchedProductId` throws `NotFoundError`, not a silent cross-tenant
     write.
   - inserts one `product_cost_history` row: `unitCost`,
     `previousUnitCost` (read inside the same lock, so two invoices approved
     close together for the same product chain correctly rather than both
     reading the same stale "previous" value — this is exactly what
     `previous_unit_cost_chains` in the test suite already asserts).
   - updates `product.currentUnitCost`.
3. A failure partway through the loop rolls back the *whole* transaction,
   including any `product_cost_history` rows already inserted for earlier
   lines in the same approval call — no partially-applied approval is
   possible.

This is already correct, transactional, tenant-scoped, and tested
(`tests/invoice-approval-path.test.ts`). **Nothing here needs to change.**

## The table already anticipated a reader that doesn't exist yet

`product_cost_history`'s own schema comment
(`db/schema.ts:1564-1566`) names the exact index this is for:

```
// "This product's price history" — the read a future cost-history screen
// makes, same role as vendor_alias_organization_product_idx /
// invoice_line_organization_matched_product_idx above.
index("product_cost_history_organization_product_idx").on(
  table.organizationId,
  table.productId,
),
```

The index exists. The query that would use it does not.

## Confirmed gap: no read path anywhere in `lib/domain/`

Grepped `lib/domain/` and `app/` — zero functions read `productCostHistory`.
The only place the table is queried at all is a **test-only** helper:

```ts
// tests/invoice-approval-path.test.ts:143
async function costHistoryRowsFor(organizationId: number) {
  return db.select().from(productCostHistory).where(eq(productCostHistory.organizationId, organizationId));
}
```

That helper is unscoped beyond organization (fine for a test asserting
"everything this test run wrote," wrong shape for a real query — it doesn't
filter by product or invoice, and has no role gate).

## Two natural read shapes, both already supported by the schema

The table carries both foreign keys needed without a redesign:

- **Per-product history** — "what has this product cost over time" — via
  `productId` + the existing `product_cost_history_organization_product_idx`.
  Ordered by `effectiveAt` (or `id`, monotonic within a product), this is the
  `previousUnitCost` chain the write path already maintains correctly.
- **Per-invoice cost postings** — "what did approving this invoice change" —
  via `sourceInvoiceId` (composite tenant FK,
  `product_cost_history_organization_invoice_fk`). No index exists yet on
  `(organizationId, sourceInvoiceId)` specifically — worth a Gate 2 check on
  whether the existing FK's implicit index is sufficient at expected row
  counts, or a dedicated index is worth adding alongside the new query
  function.

## Role gating — the hard constraint for Gate 2/3

Invariant 8: "Cost and margin data is gated by role. Staff never see it."
`lib/domain/invoices.ts` already has the established pattern for this split:
`InvoiceRow` (owner-only, every monetary column) vs. a manager/staff-safe
projection with monetary columns omitted. Any new cost-history read function
follows that same shape — it does not get to be a single ungated query that
happens to be called only from owner-only code paths today, because that
guarantee erodes the first time something new calls it.

## Not in scope this round

- No screen. Both read functions are built for a future cost-history UI to
  consume, not wired to one yet.
- No change to the write path (`approveInvoice`) — it is already correct.
- No new table or column — the schema already supports both read shapes.
