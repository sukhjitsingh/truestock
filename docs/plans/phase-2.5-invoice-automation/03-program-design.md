# Gate 3 — Program Design: Phase 2.5 OCR invoice automation

Read `02-architecture.md` before reading this. Every design decision in this document derives from Gate 2's endpoint list, fit map, and external inventory.

> **Corrected 2026-08-14 after adversarial review.** See
> `docs/reviews/2026-08-14-phase-2.5-adversarial-review.md`. Corrections are marked
> **[AR-n]**. Gate 2–4 approval is withdrawn until the corrected contract is re-approved.
>
> **Standing rule added as a result of [AR-5]:** this document's schema references are
> reconciled against the live `db/schema.ts` before Gate 3 is approved, not after. The
> first version named four schema objects that do not exist (`product.unit_cost`,
> `product.unit_cost_updated_at`, table `cost_history`) or already do (`vendor`), and
> every one of those was mechanically checkable in under a minute.

---

## Files — every file created or changed (one line, with why it lives there)

| File | Why |
|------|-----|
| `db/schema.ts` | Add 7 new tables: `invoice`, `invoice_line`, `vendor_alias`, `extraction_job`, `audit_packet`, `audit_packet_file`, `product_cost_history` + indexes. **`vendor` already exists at `db/schema.ts:300` — reused, not recreated [AR-5]** |
| `app/api/invoices/[id]/file/route.ts` | The only path to invoice bytes: owner-only, ownership-checked, path-traversal-guarded, streams from outside the web root **[AR-1]** |
| `lib/domain/invoices.ts` | CRUD + approval + retention logic; the single source of truth for invoice state transitions |
| `lib/domain/extraction.ts` | `extraction_job` lifecycle: claim → classify → text or vision → parse → write drafts |
| `lib/domain/matching.ts` | 5-rung matching ladder: alias upsert, vendor-item-code dedup, product match, confidence thresholds |
| `lib/domain/cost-derivation.ts` | `deriveUnitCost` + deposit exclusion formula; invoiceless cost derivation (gross ÷ qty ÷ pack_size) |
| `lib/domain/errors.ts` | Add `InvoiceNotFoundError`, `InvoiceNotWritableError`, `ExtractionFailedError`, `MatchingError` |
| `lib/validation/invoices.ts` | Zod schemas: `reviewInvoiceSchema`, `approveInvoiceSchema`, `createAuditPacketSchema`, `getAuditPacketSchema` |
| `app/actions/invoices.ts` | 10 server actions: upload, list, get, review, approve, reject, createAuditPacket, getAuditPacket, getExtractionStatus, resendToExtraction |
| `app/(office)/office/invoices/` | 5 new page routes + server components: upload/page, review/page, [id]/review/page, archive/page, audit-packet/page |
| `components/office/` | 5 new components: invoice-upload, review-queue, review-invoice, archive-table, audit-packet |
| `middleware.ts` | Extend CSP nonce for `/invoices/*` paths (camera, file input permissions) — stays per-request, never static header |
| `db/seed.ts` | Optional: vendor_item_code examples for seeded vendors |
| `lib/auth.ts` | No change — Better Auth config unchanged |

---

## Types & signatures — only types and method signatures (no implementation bodies)

### 1. `lib/domain/invoices.ts`

```typescript
export type InvoiceStatus = 
  | "uploaded" 
  | "processing" 
  | "needs_review" 
  | "reviewed" 
  | "approved" 
  | "rejected";

export interface InvoiceLine {
  line_number: number;
  raw_name: string;
  raw_qty: number;
  raw_uom: "Cases" | "Units" | string;
  raw_pack_size: number | null;
  raw_gross: number;
  raw_discount: number;
  raw_net: number;
  line_type: "product" | "deposit" | "freight" | "tax" | "other";
  matched_product_id: number | null;
  matched_vendor_alias_id: number | null;
  confidence: number;
  exception_flags: string[];
}

export interface Invoice {
  id: number;
  organization_id: number;
  vendor_id: number | null;
  status: InvoiceStatus;
  source: "photo" | "pdf" | "email_forward";
  file_path: string;
  file_sha256: string;
  page_count: number;
  invoice_date: Date;
  due_date: Date | null;
  invoice_number: string;
  total_gross: number;
  total_discount: number;
  total_net: number;
  currency: string;
  retention_until: Date;
  approved_at: Date | null;
  approved_by: number | null;
  created_at: Date;
  updated_at: Date;
  lines: InvoiceLine[];
}

export interface CreateInvoiceInput {
  vendor_id: number;
  source: Invoice["source"];
  file_path: string;
  file_sha256: string;
  invoice_date: Date;
  invoice_number: string;
  total_gross: number;
  total_discount: number;
  total_net: number;
  currency: string;
}

export interface ReviewInput {
  invoice_id: number;
  lines: Array<{
    line_number: number;
    raw_name: string;
    raw_qty: number;
    raw_uom: InvoiceLine["raw_uom"];
    raw_pack_size: number | null;
    raw_gross: number;
    raw_discount: number;
    raw_net: number;
    line_type: InvoiceLine["line_type"];
    matched_product_id: number | null;
  }>;
}

export interface ApproveInput {
  invoice_id: number;
}

export interface AuditPacketInput {
  date_from: Date;
  date_to: Date;
}
```

#### [AR-2] Every domain function takes `Actor`, and every nested id is ownership-checked

`ReviewInput` above is **client input, and every id in it is hostile until proved
otherwise** — `invoice_id`, and one `matched_product_id` per line. The earlier draft
passed these to the approval flow behind only a `requireRole("owner")` check. A
manipulated `matched_product_id` pointing at another tenant's product would attach to the
attacker's own invoice line and, on approval, overwrite that other tenant's catalog cost:
a silent, cross-tenant, financially material write. This is invariant 9's "ownership-
checked, not just existence-checked" — the same gap that once leaked another tenant's
location name through an unchecked `locationId`.

Two structural defences, because either alone can be forgotten:

```typescript
// 1. Signatures take Actor — never a bare orgId, never client-supplied org.
//    Actor.organizationId comes from requireSession, re-read from the DB per call.
export function getInvoice(actor: Actor, invoiceId: number): Promise<Invoice>;
export function reviewInvoice(actor: Actor, input: ReviewInput): Promise<Invoice>;
export function approveInvoice(actor: Actor, input: ApproveInput): Promise<Invoice>;
export function listInvoices(actor: Actor, filters: InvoiceFilters): Promise<Page<InvoiceRow>>;

// 2. Nested ids are resolved through an ownership assertion before use.
//    Cross-tenant ⇒ NotFoundError, never a response that confirms the row exists.
export function assertProductsOwned(
  actor: Actor,
  productIds: number[],
): Promise<void>;   // one query: SELECT id WHERE organization_id = ? AND id IN (...)
                   // any id missing from the result ⇒ NotFoundError("Product")
```

`reviewInvoice` calls `assertProductsOwned` on the **full set** of non-null
`matched_product_id`s in one query before writing anything. The composite
`(organization_id, matched_product_id)` foreign key added in Gate 2 is the backstop
underneath that: even if the assertion were removed, the database refuses the row (1452).

**Manager redaction is a separate query, not a filtered response [AR-7]:**

```typescript
// Owner only — includes every monetary column.
export function listInvoicesForOwner(actor: Actor, f: InvoiceFilters): Promise<Page<InvoiceRow>>;

// Manager — the SELECT does not mention a monetary column, so there is nothing to leak.
// No total_gross / total_discount / total_net / raw_* money / confidence-derived badges.
export function listInvoicesRedacted(actor: Actor, f: InvoiceFilters): Promise<Page<InvoiceRowRedacted>>;

export interface InvoiceRowRedacted {
  id: number; vendor_name: string; invoice_date: Date;
  invoice_number: string; status: InvoiceStatus; line_count: number;
  // deliberately absent: every monetary field, and every price-derived badge
}
```

### 2. `lib/domain/extraction.ts`

```typescript
// [AR-6] ONE state machine. The earlier draft had three incompatible vocabularies:
// this enum said "pending", Slice 1 wrote "ready_for_classify" (not in the enum —
// MariaDB rejects it), and the cron claimed "pending". Lifecycle is now exactly:
//   awaiting_upload → queued → running → done | failed
export type ExtractionJobStatus =
  | "awaiting_upload"   // created with the invoice; the file is NOT there yet
  | "queued"            // upload confirmed + size/SHA-256 verified; claimable
  | "running"           // atomically claimed by a worker
  | "done"
  | "failed";

// Progress *within* extraction is observability only — never a claim predicate,
// so adding a pipeline step cannot change which jobs the cron picks up.
export type ExtractionPhase = "classify" | "text_extract" | "ocr" | "parse";

export interface ExtractionJob {
  id: number;
  organization_id: number;          // [AR-2] tenant column on every child table
  invoice_id: number;
  status: ExtractionJobStatus;
  phase: ExtractionPhase | null;
  pdf_type: "text" | "scanned" | "mixed" | "image";
  pages_needing_ocr?: number[];
  error_message?: string;
  claimed_at: Date | null;
  claimed_by: string | null;        // worker id — makes a stuck job diagnosable
  started_at: Date | null;
  completed_at: Date | null;
  retry_count: number;
}

export interface ExtractionResult {
  invoice_line_drafts: InvoiceLine[];
  pdf_type: ExtractionJob["pdf_type"];
  confidence: number;
  needs_human_review: boolean;
  exception_flags?: string[];
}

// [AR-6] Atomic claim across ALL tenants (this is a system worker, not a user action):
//   UPDATE extraction_job SET status='running', claimed_at=NOW(), claimed_by=:workerId
//   WHERE status='queued' ORDER BY id LIMIT 1
// Zero rows affected ⇒ another worker won the race ⇒ return null, not an error.
// Extraction can exceed the 2-minute cron interval, so overlapping ticks are the
// normal case, not the edge case.
export function claimNextJob(workerId: string): Promise<ExtractionJob | null>;

// [AR-6] Called only after the object is confirmed present and its size + SHA-256
// match what was declared at upload. This is the awaiting_upload → queued edge.
export function markUploadConfirmed(actor: Actor, invoiceId: number): Promise<void>;

export function updateStatus(id: number, status: ExtractionJobStatus, data?: unknown): Promise<void>;
export function parseLinesFromMarkdown(markdown: string): InvoiceLine[];
export function parseLinesFromVision(json: unknown): InvoiceLine[];
export function arithmeticCheck(lines: InvoiceLine[], expectedTotal: number): 
  | { pass: true; overage?: number; shortfall?: number }
  | { pass: false; mismatch: number; details: string[] };
```

### 3. `lib/domain/matching.ts`

```typescript
export interface VendorAlias {
  id: number;
  organization_id: number;
  vendor_id: number;
  vendor_item_code: string;
  matched_product_id: number | null;
  confidence: number;
  created_at: Date;
  updated_at: Date;
}

export function findAlias(orgId: number, vendorId: number, vendorItemCode: string): 
  | VendorAlias | null;
export function upsertAlias(orgId: number, vendorId: number, vendorItemCode: string, productId: number): Promise<VendorAlias>;
export function matchLinesToProducts(lines: InvoiceLine[], orgId: number): Promise<InvoiceLine[]>;
```

### 4. `lib/domain/cost-derivation.ts`

```typescript
export function deriveUnitCost(line: InvoiceLine): number | null; 
  // raw_net / qty / pack_size when line_type = product, else null
  // deposits (line_type = deposit) always return null — invariant: never in product cost

export function computeRetentionUntil(invoiceDate: Date): Date;
  // invoice_date + 3 years (computed at upload, stored at retention_until)
```

### 5. `lib/validation/invoices.ts`

```typescript
export const reviewInvoiceSchema = z.object({
  invoice_id: z.number().int().positive(),
  lines: z.array(z.object({...})).min(1),
});

export const approveInvoiceSchema = z.object({
  invoice_id: z.number().int().positive(),
});

export const createAuditPacketSchema = z.object({
  date_from: z.string().datetime(),
  date_to: z.string().datetime(),
});
```

---

## Call stack — top-to-bottom, per main flow

### Flow A: Upload → Extraction → Review → Approve

```
app/actions/invoices.ts:uploadInvoiceAction()
  → lib/validation/invoices.ts:reviewInvoiceSchema.parse()
  → db/schema.ts: INSERT INTO invoice, extraction_job
  → object-storage: generate signed PUT URL
  → return {invoiceId, uploadUrl}

object-storage PUT (client) → job queue (no native service → in-process cron)

cron: processExtractionQueue()
  → lib/domain/extraction.ts:claimNextJob(workerId)   // atomic; only status='queued' [AR-6]
  → @firecrawl/pdf-inspector: classifyPdf(buffer) → pdfType
  → IF text-based:
       lib/domain/extraction.ts:processPdf(buffer) → markdown
       parseLinesFromMarkdown(markdown) → invoice_line[] drafts
    ELSE (scanned/mixed):
       renderPagesToImages(fileBuffer, pagesNeedingOcr) → image[]
       callClaudeVision(image[], schema) → structured JSON → parseLinesFromVision()
  → lib/domain/matching.ts:matchLinesToProducts(draftLines, orgId) → matched lines
  → lib/domain/cost-derivation.ts:deriveUnitCost() → unit cost
  → db/schema.ts: INSERT INTO invoice_line, UPDATE extraction_job.status = done
  → UPDATE invoice.status = needs_review

app/actions/invoices.ts:reviewInvoiceAction()
  → lib/validation/invoices.ts:reviewInvoiceSchema.parse()
  → lib/domain/invoices.ts:updateLines(invoiceId, correctedLines[])
  → FOR each line: lib/domain/matching.ts:upsertAlias() if vendor_item_code extracted
  → UPDATE invoice.status = reviewed
  → return updated invoice

app/actions/invoices.ts:approveInvoiceAction()          // [AR-4] [AR-5]
  → requireRole("owner") from lib/authz.ts             // canSeeCost() === owner-only
  → lib/domain/invoices.ts:getInvoice(actor, invoiceId)  // ownership-checked [AR-2]
  → db.transaction(async (tx) => {                     // ← ONE transaction, not a loop

      // (a) Compare-and-set is the concurrency gate — do it FIRST.
      const res = await tx.update(invoice)
        .set({ status: 'approved', approvedAt: now(), approvedBy: actor.userId })
        .where(and(
          eq(invoice.id, invoiceId),
          eq(invoice.organizationId, actor.organizationId),
          eq(invoice.status, 'reviewed'),
        ))
      if (res.affectedRows === 0) return ALREADY_APPROVED   // idempotent success,
                                                            // NOT an error

      // (b) Costs are written inside the same transaction as the transition.
      FOR each line WHERE line_type = 'product' AND matched_product_id IS NOT NULL:
        lib/domain/cost-derivation.ts:deriveUnitCost(line)   // null ⇒ skip (deposits)
        → tx: INSERT INTO product_cost_history (
              organization_id, product_id, source_invoice_id, source_invoice_line_id,
              unit_cost, previous_unit_cost, effective_at, created_by)
              -- UNIQUE(source_invoice_line_id): a replay rolls the whole tx back
        → tx: UPDATE product SET current_unit_cost = :unitCost
              WHERE id = :matchedProductId
                AND organization_id = actor.organizationId   -- tenant-scoped write
    })
  → retention_until already set at upload
  → return approved invoice
```

**What each part of that closes.** `product.unit_cost` and `product.unit_cost_updated_at`
in the earlier draft do not exist — the live column is `current_unit_cost`
(`db/schema.ts:393`) and there is no update-time column, so update time now lives in
`product_cost_history.effective_at` **[AR-5]**. The transaction means a crash cannot leave
some products repriced and the invoice still `reviewed`. The compare-and-set means two
concurrent approvals produce one application and one idempotent success rather than
doubled costs. The unique key on `source_invoice_line_id` means even a retry that somehow
passes the CAS cannot duplicate history — the same mechanism `count_line_write.client_line_id`
already provides for count writes (invariant 5) **[AR-4]**.

### Flow B: Audit Packet (on-demand)

```
app/actions/invoices.ts:createAuditPacketAction()
  → lib/validation/invoices.ts:createAuditPacketSchema.parse()
  → db/schema.ts: INSERT INTO audit_packet (status=building)
  → enqueue buildAuditPacketJob(packetId) → background
  → return {packetId}

Job: buildAuditPacketJob(packetId)                              // [AR-3]
  → packet = SELECT * FROM audit_packet WHERE id = :packetId
  → orgId  = packet.organization_id     // read from the ROW, never passed in by a caller
  → lib/domain/invoices.ts:queryInvoicesInRange(orgId, packet.date_from, packet.date_to)
  → lib/domain/counts.ts:queryCountsInRange(orgId, packet.date_from, packet.date_to)
  → for each file: assert resolved path ∈ INVOICE_STORAGE_DIR, assert row.org = orgId
  → stream to ZIP → compute SHA-256 per file → audit_packet_file rows (organization_id = orgId)
  → ASSERT exactly one distinct organization_id across every manifest row  ← backstop
  → upload ZIP → audit_packet.file_path, audit_packet.file_sha256
  → UPDATE audit_packet: status=ready, expires_at=now()+10min, manifest_json
  → SES/SendGrid: email download link to the packet's owner (TTL 10 min)

app/actions/invoices.ts:getAuditPacketAction()
  → requireRole("owner")
  → ownership-check (packet_id, organization_id) → cross-tenant ⇒ NotFoundError
  → if ready, return download URL; if building, return {status: "processing"}
  → expiry is checked server-side at request time, not merely encoded in the URL
```

**[AR-3]** The earlier draft's job selected invoices by date range alone — no organization
predicate anywhere. Because tenants share a calendar, the first owner to request a packet
would have received a ZIP of *every organization's* invoices for that range, emailed as a
durable file, with nothing appearing broken. It also promised counts in the ZIP while
defining no count query at all. The organization id is now read from the packet row and
threaded through every invoice, count, and file query, with a single-distinct-org
assertion over the finished manifest as a cheap last line of defence.

---

## Test plan — test case names and what each asserts

| Test case | Asserts |
|-----------|---------|
| `invoice_upload_valid_photo` | Server action accepts photo, creates invoice + extraction_job, returns uploadUrl |
| `invoice_upload_valid_pdf` | Server action accepts PDF, classifyPdf → text-based path, returns classification |
| `invoice_upload_email_forward` | Inbound webhook parses sender → vendor match → creates invoice |
| `extraction_cron_text_pdf` | Cron claims pending job, processPdf extracts markdown, writes invoice_line drafts |
| `extraction_cron_scanned_pdf` | Cron claims pending job, Claude Vision → structured JSON → invoice_line drafts |
| `arithmetic_check_pass` | Lines sum to total_gross → status advances to reviewed |
| `arithmetic_check_fail` | Lines don't sum → exceptions returned, status stays needs_review |
| `alias_upsert_persists` | Vendor alias upsert survives page reload; next invoice from same vendor already matched |
| `approve_invoice_writes_cost` | Owner approves → `product.current_unit_cost` updated; `product_cost_history` row inserted **[AR-5]** |
| `approve_invoice_blocks_staff` | `requireRole("staff")` blocks approveInvoiceAction (403) |
| `audit_packet_creates_packet` | createAuditPacketAction creates packet (building), returns packetId |
| `audit_packet_email_link` | buildAuditPacketJob completes → email sent with signed URL (TTL 10 min) |
| `pagination_25_rows` | listInvoicesAction returns 25 rows max, hasNext flag for infinite scroll |

### Adversarial tests — one per review finding

These are the tests that would have failed against the original contract. Each is
written to fail first against the uncorrected behaviour; none may be weakened to go green.

| Test case | Asserts | Closes |
|-----------|---------|--------|
| `invoice_file_not_statically_served` | A direct static fetch of a stored invoice path returns **404**; the file is only retrievable through the authenticated handler | AR-1 |
| `invoice_file_requires_owner` | Manager and staff sessions get 403 from `GET /api/invoices/[id]/file`; anonymous gets 401 | AR-1 |
| `invoice_file_rejects_path_traversal` | A stored path containing `../` resolves outside `INVOICE_STORAGE_DIR` and is refused, not served | AR-1 |
| `review_rejects_cross_tenant_product` | Org A submits a review line whose `matched_product_id` belongs to org B → `NotFoundError`; **org B's `current_unit_cost` is unchanged** | AR-2 |
| `invoice_line_fk_refuses_cross_tenant` | Inserting an `invoice_line` with a foreign-org `matched_product_id` fails at the database (1452), with the app-layer check removed | AR-2 |
| `get_invoice_cross_tenant_is_not_found` | Org A requesting org B's `invoice_id` gets `NotFoundError` — never a response that confirms the row exists | AR-2 |
| `audit_packet_excludes_other_tenants` | Two orgs with invoices on **overlapping dates**; org A's ZIP contains only org A's invoices, and the manifest has exactly one distinct `organization_id` | AR-3 |
| `audit_packet_counts_are_scoped` | Counts included in the packet are org-scoped on the same predicate as invoices | AR-3 |
| `approve_is_idempotent_on_replay` | Approving twice writes **one** `product_cost_history` row per line; the second call returns the original success | AR-4 |
| `approve_concurrent_applies_once` | Two simultaneous approvals of one invoice: costs applied once, no duplicate history, no error surfaced to the winner | AR-4 |
| `approve_rolls_back_on_midway_failure` | Forcing a failure on the 3rd of 5 lines leaves **zero** cost rows written and the invoice still `reviewed` — never partially applied | AR-4 |
| `approve_from_non_reviewed_is_rejected` | CAS refuses `uploaded`/`needs_review`/`rejected` → no cost written | AR-4 |
| `schema_matches_live_columns` | Migration applies clean from empty; `product_cost_history` exists; `vendor` is **not** recreated; `current_unit_cost` is the column written | AR-5 |
| `job_not_claimable_before_upload` | A job created with the invoice is `awaiting_upload`; the cron claims **nothing**; it becomes `queued` only after upload confirmation | AR-6 |
| `job_rejects_hash_mismatch` | Upload whose SHA-256 or byte length differs from what was declared never reaches `queued` | AR-6 |
| `job_claim_is_atomic` | Two workers claiming concurrently: exactly one gets the job, the other gets `null` | AR-6 |
| `job_status_enum_is_closed` | Writing `ready_for_classify` (or any undeclared value) is rejected — the value that existed only in Slice 1 | AR-6 |
| `manager_invoice_payload_has_no_money` | The manager response object contains **no** monetary field and no price-derived badge — asserted over the serialized payload, so adding a column to the query fails the test | AR-7 |
| `manager_cannot_open_review_screen` | `getInvoiceAction` and `approveInvoiceAction` return 403 for manager | AR-7 |

**Test environment:** real MariaDB (testcontainers), node:22-slim Docker, same Hostinger arch assumptions.

**Two-tenant fixture is mandatory.** Every test above that mentions a second organization
needs one seeded for real — an org-B row with its own products, invoices, and files.
Single-tenant fixtures are why tenant-isolation bugs survive test suites: with one org in
the database, an unscoped query and a scoped query return identical results.

---

## Least confident decisions — numbered list of calls most worth challenging now, while changing them is free

1. **Exact Zod shape for `reviewInvoiceSchema.lines`** — nested vs flat array, whether `raw_pack_size` is required or optional for each `line_type`.
2. **`deriveUnitCost` formula when `pack_size` is null** — fall back to `raw_net / raw_qty`, or error? This affects 5 of the 9 bottled-beer products in the catalog.
3. **`matchLinesToProducts` confidence threshold** — what minimum confidence promotes a line from "unmatched" to "matched_product_id" set? This drives the review UI badge behavior.
4. **Offsite sync: local-first, Cloudflare R2 as backup** — primary storage is `INVOICE_STORAGE_DIR` (default `./var/invoices/`) on Hostinger, **outside the Next.js web root** (free, zero egress) **[AR-1]**. Cloudflare R2 (free tier: 10GB storage + 1GB egress/month) is the offsite backup copy, used for audit-packet ZIP resilience and as a secondary offsite archive. `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` are only set if the R2 backup path is configured; otherwise the pipeline reads/writes exclusively local. **The R2 bucket must be private** — a public bucket recreates AR-1 one layer further out, where nothing in this repo would catch it.
5. **`retention_until` computation: exact 3 years or calendar-year boundary?** `invoice_date + 3 years` vs `Date.utcFullYear(invoice_date.getFullYear() + 3, ...)` — matters for audit-packet date ranges.
6. **Cron interval: 2 min vs 1 min vs 5 min** — extraction is ~83 ms/pdf × pages; 2 min gives ~40s headroom for 10-page batch on Hostinger's 5–10 connection pool. Tighter interval risks rate-limited pdf-inspector calls.
7. **Signed URL TTL: 10 min vs 5 min vs 15 min** — 10 min was the Gate 2 decision; shorter increases refresh frequency, longer widens the window if the email lands in spam.

These are the calls most worth challenging during Gate 3 review — changing any of them after implementation requires a schema migration + data recount.

---

## Standing rule reminder

**Compact at every boundary.** At Gate 4 boundary, ensure every decision from Gates 1–3 that outlives this feature is recorded either in `STATE.md`'s history log, `docs/reviews/*.md`, or (if it outlives the repo) `docs/adr/`. This repo already has an informal ADR equivalent in STATE.md's dated correction blockquotes.

**Real tests only.** Never write a test that passes against the pre-change code. Never skip, weaken, or comment out a test to get green.
