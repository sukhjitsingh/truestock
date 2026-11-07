# Gate 3 — Program Design: Phase 2.5 backend follow-ons

---

## Part A — pdf-inspector selective-OCR adoption

### Files

- `lib/domain/extraction-pipeline.ts` — the only file that changes. One new
  wrapper function + one new interface, one interface gets a new optional
  field, one branch inside `runClaimedJob` is rewritten.
- `tests/extraction-pipeline.test.ts` — one new `describe` block, plus three
  **existing** tests that need an added mock (see Test plan — their current
  behavior silently assumed every `mixed`/`scanned` job calls Vision, which
  stops being true after this change).

No other file is touched — `ProcessExtractionQueueDeps` is already the
codebase's established seam for this (see Gate 2 Fit).

### Types & signatures

New, narrow projection of the library's fuller `OcrPdfResult` — same pattern
`ClassifyPdfResult`/`ProcessPdfResult` already use for `classifyPdf`/
`processPdf` (only the fields this codebase actually consumes):

```ts
export interface ProcessPdfWithOcrResult {
  markdown: string;
  /** 1-indexed pages the library itself flags as needing a real vision model — empty means nothing here needed Vision. */
  pagesRecommendingHosted: number[];
  /** 1-indexed pages that actually ran local OCR (a subset of what classifyPdf predicted) — logged, not persisted (Gate 2 Data). */
  pagesRoutedToOcr: number[];
}

export async function processPdfWithOcr(bytes: Buffer): Promise<ProcessPdfWithOcrResult>;
```

`processPdfWithOcr` is `withTimeout`-wrapped exactly like `classifyPdf`/
`processPdf` (`PDF_PROCESSING_TIMEOUT_MS`, label `"processPdfWithOcrAsync"`),
calling `pdfInspector.processPdfWithOcr(bytes, { mode: OcrMode.Auto })`.

`ProcessExtractionQueueDeps` gains one optional field:

```ts
export interface ProcessExtractionQueueDeps {
  extractInvoice?: ExtractInvoiceFn;
  classifyPdf?: typeof classifyPdf;
  processPdf?: typeof processPdf;
  processPdfWithOcr?: typeof processPdfWithOcr; // new
  readPdfFile?: (filePath: string) => Promise<Buffer>;
}
```

No other exported type changes. `ExtractionDoc`, `ExtractInvoiceResult`,
`ExtractInvoiceFn`, `extractInvoice` itself are all untouched — Gate 2's
"no merge logic, no new parsing path" holds exactly.

### Call stack

`runClaimedJob`'s current `else` branch (today: lines 1329–1344, reached
whenever `effectivePdfType !== "text"`, i.e. `mixed` or `scanned`) becomes:

1. `await setJobPhase(job.id, "ocr")` (already happens for `scanned`;
   currently only happens conditionally for `mixed` — now unconditional,
   since every path through this branch calls `processPdfWithOcr` first).
2. `const processPdfWithOcrFn = deps.processPdfWithOcr ?? processPdfWithOcr;`
3. `const ocrResult = await processPdfWithOcrFn(pdfBytes);`
4. `console.log` the same shape as the existing classify/reroute log lines
   (job id, `pagesRoutedToOcr.length`, `pagesRecommendingHosted.length`) —
   this is the logging Gate 2's Data section decided on in place of a second
   persisted column.
5. **If `ocrResult.pagesRecommendingHosted.length === 0`:**
   - `await setJobPhase(job.id, "parse")`
   - `try { parsed = parseLinesFromMarkdown(ocrResult.markdown); }` — same
     function the `text` path already uses, no new parser.
   - `catch`: **fall back to the Vision call below** rather than letting the
     job fail outright (see Least confident decisions #1 — this is the one
     real design decision in Part A, not a mechanical port).
6. **If `ocrResult.pagesRecommendingHosted.length > 0`, or step 5's parse
   fell back:**
   - `const extractFn = deps.extractInvoice ?? extractInvoice;`
   - `extraction = await extractFn({ pdfType: effectivePdfType, markdown, pdfBase64: pdfBytes.toString("base64") });`
     — **`markdown` here is the same variable already in scope from the
     earlier `processPdfFn` call** (native markdown, present for `mixed`,
     `null` for `scanned`) — deliberately **not** `ocrResult.markdown`, to
     keep this call byte-for-byte identical to today's, per Gate 2's "no
     change to *how much of the document* Vision sees."
   - `await setJobPhase(job.id, "parse")`
   - `parsed = parseLinesFromVision(extraction.raw)`

Everything before this branch (`classifyPdf`, the `text`/`mixed`
`processPdfFn` call, the confidence/encoding reroutes) and everything after
it (`matchLinesToProducts`, line-flag assignment, `writeExtractedLines`,
job-status CAS) is unchanged.

### Test plan

New `describe("selective-OCR queue routing", ...)` in
`tests/extraction-pipeline.test.ts`, following the existing
`processExtractionQueue`-through-`deps` mocking pattern (see the
`describe("text-PDF queue routing", ...)` block for the shape to match):

1. **Skip-Vision path**: mock `deps.processPdfWithOcr` to resolve
   `{ markdown: <clean fixture table>, pagesRecommendingHosted: [], pagesRoutedToOcr: [...] }`
   and a spy `deps.extractInvoice`. Assert the spy is **never called** and
   the saved `invoice_line` rows match what `parseLinesFromMarkdown` would
   produce from that fixture markdown directly.
2. **Vision-still-runs path**: same mock but
   `pagesRecommendingHosted: [2]`. Assert `deps.extractInvoice` **is**
   called exactly once, with `pdfBase64` equal to the full buffer's base64
   (not a subset) — the assertion that pins down "no page-scoping happened."
3. **Fallback path** (the least-confident decision): mock
   `pagesRecommendingHosted: []` but `markdown` with no recognizable
   line-item table (reusing the existing "fails explicitly when text exists
   but no recognizable line-item table exists" fixture). Assert the job
   does **not** fail — `deps.extractInvoice` is called as the fallback, and
   the job still reaches `needs_review`/`done`.
4. **Existing tests that need an added mock**, because they currently rely
   on every `mixed`/`scanned` job reaching Vision unconditionally, which
   stops being the default after this change:
   - line ~427, `"a scanned job without the Anthropic key fails specifically
     in the Vision branch..."` — needs `deps.processPdfWithOcr` mocked to
     return a non-empty `pagesRecommendingHosted` so the test still reaches
     the branch it's testing.
   - line ~483, open item #34's test (asserts Vision-derived lines are
     saved, not markdown-derived ones) — same addition.
   - line ~582, open item #33's test (`matchLinesToProducts` exercised
     through the real pipeline) — same addition.

### Least confident decisions

1. **Parse-failure fallback to Vision, decided this round**: if
   `parseLinesFromMarkdown(ocrResult.markdown)` throws when
   `pagesRecommendingHosted` is empty, the job falls back to calling
   `extractInvoice` (today's whole-buffer Vision path) rather than failing
   the job outright. Reasoning: the success metric's own promise is "an
   invoice with even one genuinely bad page still costs the same as today"
   — a parse failure on OCR-fused markdown is exactly the kind of thing that
   should degrade to "costs the same as today," never to a harder failure
   than today has. Flagging this because it's the one place Part A adds a
   genuinely new decision rather than a mechanical wrapper.
2. **No OCR tuning this round**: `OcrOptions.dpi`/`minimumConfidence` are
   left at library defaults (`Auto` mode, 150dpi) — no call-site override,
   matching `CLASSIFICATION_CONFIDENCE_THRESHOLD`'s existing pattern of
   being a constant, not configuration. Revisit only if real invoices show
   false positives/negatives on `hostedRecommended`.
3. Confirmed (not a real open question, noted for completeness): this
   branch already covers both `mixed` and `scanned` — the `else` in
   `runClaimedJob` is reached whenever `effectivePdfType !== "text"`, so no
   separate handling is needed per pdfType inside it.

---

## Part B — invoice cost-history / cost-posting backend

### Files

- New: `lib/domain/cost-history.ts`.
- New: `tests/cost-history.test.ts`.
- No other file changes — read-only against the existing
  `product_cost_history` table and reuse of `getInvoice`/`canSeeCost`.

### Types & signatures

```ts
import type { Actor } from "@/lib/authz";

export interface CostHistoryRow {
  id: number;
  productId: number;
  sourceInvoiceId: number;
  sourceInvoiceLineId: number;
  unitCost: string;                 // DECIMAL(10,4) as string — matches
  previousUnitCost: string | null;  // this codebase's existing money convention
  effectiveAt: Date;
  createdBy: number;
}

export async function getProductCostHistory(
  actor: Actor,
  productId: number,
): Promise<CostHistoryRow[]>;

export async function getCostPostingsForInvoice(
  actor: Actor,
  invoiceId: number,
): Promise<CostHistoryRow[]>;
```

Private helper, not exported (mirrors `assertVendorOwned`'s shape in
`lib/domain/catalog.ts`, minus the `Runner` parameter — no transaction is
needed for a read-only path):

```ts
async function assertProductOwned(organizationId: number, productId: number): Promise<void>;
```

### Call stack

**`getProductCostHistory(actor, productId)`:**
1. `if (!canSeeCost(actor.role)) throw new AuthzError(403, "You do not have permission to view cost data.");`
   — role check first, before any query (fail fast, no row-existence signal
   leaks to a caller who can't see cost data regardless of tenant).
2. `await assertProductOwned(actor.organizationId, productId);` →
   `SELECT id FROM product WHERE id = ? AND organization_id = ? LIMIT 1` →
   `throw new NotFoundError("Product")` if absent (existence + tenant in one
   check, invariant 9's ownership-checked-not-just-existence-checked shape).
3. `SELECT * FROM product_cost_history WHERE organization_id = ? AND product_id = ? ORDER BY effective_at DESC` —
   covered by the existing `product_cost_history_organization_product_idx`.
4. Map rows → `CostHistoryRow[]`.
5. Return (possibly `[]` — a product that exists but never appeared on an
   approved invoice is not an error).

**`getCostPostingsForInvoice(actor, invoiceId)`:**
1. Same `canSeeCost` check, same order.
2. `await getInvoice(actor, invoiceId);` (from `lib/domain/invoices.ts`) —
   throws `NotFoundError("Invoice")` on cross-tenant/missing; the returned
   row is discarded, this call is purely for its ownership assertion
   (Gate 2's explicit reuse decision, over a narrower duplicate helper).
3. `SELECT * FROM product_cost_history WHERE organization_id = ? AND source_invoice_id = ? ORDER BY effective_at DESC` —
   relies on the composite tenant FK's implicit index (Gate 2's index
   decision — no new index this round).
4. Map rows → `CostHistoryRow[]`.
5. Return (possibly `[]`).

Neither function touches `approveInvoice` or any write path.

### Test plan

`tests/cost-history.test.ts`, against real MariaDB (`bun run test:docker`),
reusing the seeding helpers already established in
`tests/invoice-approval-path.test.ts` (two `approveInvoice` calls for the
same product produce a real, correctly-chained history to assert against):

1. **Ordering + chaining**: seed two approvals for the same product; assert
   `getProductCostHistory` returns both rows, newest-`effectiveAt` first,
   with the second row's `previousUnitCost` equal to the first row's
   `unitCost`.
2. **Role gating, not silently empty**: a `manager` and a `staff` actor both
   get `AuthzError`, not `[]` — this is the check that distinguishes
   "prohibited from asking" from "asked and found nothing," which the
   empty-list-not-error contract must not blur.
3. **Tenant isolation**: a product or invoice belonging to another
   organization throws `NotFoundError` (not another org's rows) — mirrors
   `getLinesForInvoice`'s existing cross-tenant test shape.
4. **Nonexistent id** (never existed at all, not just cross-tenant) also
   throws `NotFoundError` for both functions — same
   indistinguishable-from-the-caller's-perspective principle used
   elsewhere in this codebase.
5. **Empty-but-real**: a product that exists but was never on an approved
   invoice, and an invoice with no product-type/matched lines, both return
   `[]` without throwing.
6. **Invoice-scoping precision**: `getCostPostingsForInvoice` on one
   invoice returns exactly that invoice's postings, not another invoice's
   postings for the same product — proves the `sourceInvoiceId` filter is
   doing real work, not just `organizationId`.

### Least confident decisions

1. **Reusing `getInvoice` (a `SELECT *` + full row build) purely for an
   ownership check**, instead of a narrow `SELECT id`-only assertion like
   `assertProductOwned`/`assertVendorOwned`. Gate 2 chose this deliberately
   for consistency with every other invoice-scoped read in this codebase.
   Accepted as overhead on a call that isn't a hot path, not a correctness
   risk — noted here so it isn't mistaken for an oversight later.
2. **`AuthzError` reused directly from `lib/authz.ts`**, not a new
   domain-level error type. `canSeeCost` and `AuthzError` are both already
   exported from that module for exactly this kind of domain-layer
   defense-in-depth use (Gate 2's Endpoints section already named this
   reasoning) — no new export needed, confirmed against the module's actual
   current exports this round.
3. Role-check-before-tenant-check ordering (see Call stack #1) is a
   deliberate choice, not an accident of implementation order — worth
   surfacing in case a reviewer expects tenant-check-first.
