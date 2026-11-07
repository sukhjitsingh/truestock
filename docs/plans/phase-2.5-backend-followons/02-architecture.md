# Gate 2 — Architecture: Phase 2.5 backend follow-ons

---

## Part A — pdf-inspector selective-OCR adoption

### Fit

One file: `lib/domain/extraction-pipeline.ts`. No other module changes.

- `classifyPdf` / `processPdf` (lines 134, 161) — thin `withTimeout`-wrapped
  callers of the underlying library, same shape the new wrapper follows.
- `extractInvoice` (line 877) — currently the only path that reaches Claude
  Vision; called once per job with the *entire* PDF as base64
  (`source: { type: "base64", media_type: "application/pdf", data:
  doc.pdfBase64 }`, line 887).
- `runClaimedJob` (line 1247 area) — the cron-tick function that owns the
  `effectivePdfType === "mixed"` branch (lines 1329–1344) where the whole-doc
  Vision call currently happens. This is the one branch that changes.
- `ProcessExtractionQueueDeps` (line 1170) — the existing dependency-injection
  interface tests already use to mock `classifyPdf`/`processPdf`/`readPdfFile`.
  The new `processPdfWithOcr` wrapper gets the same treatment
  (`deps.processPdfWithOcr ?? processPdfWithOcr`) so it's mockable the same
  way, no new test infrastructure needed.

### Endpoints

None. This is entirely internal to the cron-driven extraction pipeline — no
route, no server action, no new caller surface.

### Data

No new tables, no new columns. One existing column gets a second write:

- `extraction_job.pages_needing_ocr` (json int[], nullable) is currently set
  once, from `classifyPdf`'s *predicted* pages needing OCR (line 1292). After
  this change, once `processPdfWithOcr` actually runs, its
  `pagesRoutedToOcr` (the pages the library *actually* sent to its local OCR
  model) is worth logging alongside the existing prediction — but the schema
  already has exactly one array column for "OCR page list," not two. Decision:
  keep the existing write as-is (classification-time prediction, unchanged),
  and log `pagesRoutedToOcr` / `hostedRecommended` pages via `console.log`
  only (matching this file's existing logging pattern, e.g. line 1286) rather
  than adding a second persisted column this round — the cost/timing signal
  that actually matters for the success metric (`extraction_job.cost_usd`)
  is already captured by the existing Vision-call cost-logging path, and
  simply won't fire at all on invoices where Vision gets skipped.
- No new index needed — nothing here is queried by the new field.

### Flow

Today (the `mixed`/scanned branch, lines 1329–1344):

1. `processPdfFn(pdfBytes)` already ran during `text_extract` to get whatever
   native markdown exists.
2. `extractFn({ pdfType, markdown, pdfBase64: pdfBytes.toString("base64") })`
   sends the **entire buffer** to Claude Vision in one call, regardless of
   how many pages actually needed it.
3. `parseLinesFromVision(extraction.raw)` parses the whole-document response.

After this change:

1. Classification (`classifyPdf`) and native extraction (`processPdf`) are
   unchanged — still the first two steps, still free/deterministic.
2. Where the code currently branches into the whole-document Vision call, it
   instead calls the new `processPdfWithOcr(pdfBytes)` wrapper
   (`pdfInspector.processPdfWithOcr(bytes, { mode: OcrMode.Auto })`,
   `withTimeout`-guarded like every other pdf-inspector call in this file).
   `Auto` mode means pdf-inspector itself decides, per page, whether native
   quality signals are good enough to skip OCR — this is the library doing
   the page-scoping, not new logic this codebase has to write.
3. The result's `pages: OcrPageResult[]` carries a `provenance.
   hostedRecommended` flag per page — the library's own signal that a page's
   *local* OCR wasn't confident enough and would benefit from a real vision
   model.
4. **Corrected 2026-08-23** (researched against pdf-inspector's full API
   surface — Rust/napi/wasm/Python docs, via context7 — and against
   `@firecrawl/pdf-parse`, which does not exist as a package, and against
   pdf-lib's page-copy API): pdf-inspector has **no function that returns a
   page-scoped PDF buffer or page image** — its `pages?: number[]` params
   (on `processPdf`, `extractPagesMarkdown`) restrict *markdown extraction*
   only, never produce a document Claude Vision could be handed. There is
   no page-scoped Vision call this round. See
   `appendix-a-selective-ocr-audit.md` for the full finding and the
   pdf-lib-based alternative recorded there as a future option.
5. If `pagesRecommendingHosted` (or every page's
   `provenance.hostedRecommended`) comes back **empty**, Vision is skipped
   entirely and `processPdfWithOcr`'s own markdown (native + local-OCR
   fused) is parsed directly — same code path `effectivePdfType === "text"`
   already uses (`parseLinesFromMarkdown`), not a new one. **This is the
   entire win this round.**
6. If `pagesRecommendingHosted` is **non-empty**, the *existing*
   `extractInvoice` call still runs against the **whole** PDF buffer,
   exactly as it does today — no merge logic, no new parsing path. This
   round changes *whether* Vision is called, never *how much of the
   document* it sees.

### External

`@firecrawl/pdf-inspector` (already a dependency, version pinned at 1.15.0 —
unchanged). No new third-party service. No new env vars — `processPdfWithOcr`'s
`OcrOptions` (`mode`, `dpi`, `minimumConfidence`) are call-site constants, the
same way `CLASSIFICATION_CONFIDENCE_THRESHOLD` (line 108) is today, not
configuration this needs to expose.

---

## Part B — invoice cost-history / cost-posting backend

### Fit

New file: `lib/domain/cost-history.ts` — a new domain module, matching this
codebase's existing one-module-per-concern convention (`invoices.ts`,
`invoice-lines.ts`, `invoice-approval.ts`, `cost-derivation.ts` are all
already separate rather than folded into one file). Nothing in
`invoice-approval.ts` changes — the write path stays exactly as audited in
`appendix-b-cost-history-audit.md`.

Touches, read-only:

- `db/schema.ts`'s `productCostHistory` table (existing).
- `lib/authz.ts`'s `Actor` type and `canSeeCost(role)` predicate (existing,
  currently used by `app/actions/invoices.ts` at the action layer — see
  below for why this part uses it inside the domain layer instead).
- `lib/domain/invoices.ts`'s `getInvoice(actor, invoiceId)` — reused
  directly for the per-invoice read's ownership check rather than
  duplicating its `NotFoundError`-on-cross-tenant logic.
- `lib/domain/errors.ts`'s `NotFoundError` / a new `AuthzError`-style throw
  for the role check (re-exported from `lib/authz.ts`, not redefined).

### Endpoints

None this round — per the explicit "no UI change yet" instruction, there is
no server action and no route. The two new functions are domain-layer only,
exercised by tests. A server action wrapping them (mirroring
`getInvoiceAction`'s `requireRole("owner")` — then — `parse` — then —
`invoices.getInvoice(...)` shape) is a small follow-on once a screen needs
them; deliberately not built now to avoid an action with no caller.

**Design decision this gap creates:** every other read in this codebase that
touches cost data (`getInvoice`, `listInvoicesForOwner`) is tenant-scoped in
the domain layer but role-gated one layer up, in
`app/actions/invoices.ts`'s `requireRole("owner")` call. Because Part B ships
*no* action layer this round, that would leave these two new functions with
no role gate anywhere until a future engineer remembers to add
`requireRole("owner")` to whatever action eventually calls them — a silent
trap for invariant 8. Unlike `invoice`, `product_cost_history` has no
non-cost columns at all (every column is a cost figure or an id pointing at
one), so there is no manager/staff-safe projection to build here the way
`invoices.ts` has one. Given that, these two functions check
`canSeeCost(actor.role)` themselves and throw if false — defense-in-depth
that costs nothing (the predicate already exists) and closes the gap left by
not having an action layer yet.

### Data

No new tables, no new columns. Two new read functions against the existing
`product_cost_history` table:

**`getProductCostHistory(actor, productId): Promise<CostHistoryRow[]>`**
- `canSeeCost(actor.role)` check first, throws if not owner.
- Ownership-checks `productId` against `actor.organizationId` (existence +
  tenant, `NotFoundError` on a cross-tenant or nonexistent id — same shape
  as `getInvoice`), *before* querying history, so "product doesn't exist"
  and "product exists, no history yet" are distinguishable.
- Queries `product_cost_history` filtered on `(organizationId, productId)` —
  exactly the existing `product_cost_history_organization_product_idx`
  covers this, no new index.
- Ordered `effectiveAt` descending (most recent cost change first — the
  natural "what has this cost done lately" read).
- Returns `[]`, never throws, when the product exists but has no cost
  history yet (e.g. never appeared on an approved invoice).

**`getCostPostingsForInvoice(actor, invoiceId): Promise<CostHistoryRow[]>`**
- Same `canSeeCost` check.
- Reuses `getInvoice(actor, invoiceId)` for the ownership check (throws
  `NotFoundError` on cross-tenant/nonexistent, consistent with every other
  invoice read in this codebase) — the row itself isn't otherwise needed,
  just the tenant assertion.
- Queries `product_cost_history` filtered on
  `(organizationId, sourceInvoiceId)`.
- **Index decision:** no dedicated `(organizationId, source_invoice_id)`
  index is added this round. The composite tenant FK
  (`product_cost_history_organization_invoice_fk`) already gives MariaDB an
  implicit index on its leading columns, and at expected volume (a handful
  of product-line cost postings per invoice approval, not a hot path) that's
  sufficient. Revisit only if a future EXPLAIN on real data shows it isn't.
- Same empty-list-not-error behavior as above.

Both return the same shape:

```
interface CostHistoryRow {
  id: number;
  productId: number;
  sourceInvoiceId: number;
  sourceInvoiceLineId: number;
  unitCost: string;           // DECIMAL(10,4), string form (matches this
  previousUnitCost: string | null; // codebase's existing money convention)
  effectiveAt: Date;
  createdBy: number;
}
```

### Flow

Per-product read (main path):
1. Caller (a test today; a future owner-gated server action later) has an
   `Actor` already resolved via `requireSession`/`requireRole`.
2. `getProductCostHistory(actor, productId)` → `canSeeCost(actor.role)` →
   ownership-check `productId` → `NotFoundError` if cross-tenant/missing →
   query `product_cost_history` scoped to `(organizationId, productId)`,
   ordered `effectiveAt DESC` → map rows → return (possibly empty) array.

Per-invoice read (main path):
1. Same actor precondition.
2. `getCostPostingsForInvoice(actor, invoiceId)` → `canSeeCost(actor.role)`
   → `getInvoice(actor, invoiceId)` (throws `NotFoundError` on
   cross-tenant/missing) → query `product_cost_history` scoped to
   `(organizationId, sourceInvoiceId)` → map rows → return array.

Neither path touches `approveInvoice` or any write.

### External

None.
