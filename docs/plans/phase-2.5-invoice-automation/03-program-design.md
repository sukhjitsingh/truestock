# Gate 3 — Program Design: Phase 2.5 OCR invoice automation

Read `02-architecture.md` before reading this. Every design decision in this document derives from Gate 2's endpoint list, fit map, and external inventory.

---

## Files — every file created or changed (one line, with why it lives there)

| File | Why |
|------|-----|
| `db/schema.ts` | Add 7 new tables: `vendor`, `invoice`, `invoice_line`, `vendor_alias`, `extraction_job`, `audit_packet`, `audit_packet_file` + indexes |
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

### 2. `lib/domain/extraction.ts`

```typescript
export type ExtractionJobStatus = 
  | "pending" 
  | "classifying" 
  | "extracting" 
  | "ocr" 
  | "done" 
  | "failed";

export interface ExtractionJob {
  id: number;
  invoice_id: number;
  status: ExtractionJobStatus;
  pdf_type: "text" | "scanned" | "mixed" | "image";
  pages_needing_ocr?: number[];
  error_message?: string;
  started_at: Date;
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

export function claimNextPending(orgId: number): Promise<ExtractionJob | null>;
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
  → lib/domain/extraction.ts:claimNextPending()
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

app/actions/invoices.ts:approveInvoiceAction()
  → requireRole("owner") from lib/authz.ts
  → FOR each line WHERE line_type = product AND matched_product_id:
       lib/domain/cost-derivation.ts:deriveUnitCost()
       → db/schema.ts: UPDATE product.unit_cost, product.unit_cost_updated_at = now()
       → db/schema.ts: INSERT INTO cost_history
  → invoice.status = approved, approved_at = now(), approved_by = actor.userId
  → retention_until already set at upload
  → return approved invoice
```

### Flow B: Audit Packet (on-demand)

```
app/actions/invoices.ts:createAuditPacketAction()
  → lib/validation/invoices.ts:createAuditPacketSchema.parse()
  → db/schema.ts: INSERT INTO audit_packet (status=building)
  → enqueue buildAuditPacketJob(packetId) → background
  → return {packetId}

Job: buildAuditPacketJob(packetId)
  → lib/domain/invoices.ts:queryInvoicesInRange(packetId)
  → stream to ZIP → compute SHA-256 per file → manifest_json
  → upload ZIP to object storage → audit_packet.file_path, audit_packet.file_sha256
  → UPDATE audit_packet: status=ready, expires_at=now()+10min, manifest_json
  → SES/SendGrid: email signed download link to owner (TTL 10 min)

app/actions/invoices.ts:getAuditPacketAction()
  → UPDATE audit_packet: if ready, return signed URL; if building, return {status: "processing"}
```

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
| `approve_invoice_writes_cost` | Owner approves → product.unit_cost updated; cost_history row inserted |
| `approve_invoice_blocks_staff` | `requireRole("staff")` blocks approveInvoiceAction (403) |
| `audit_packet_creates_packet` | createAuditPacketAction creates packet (building), returns packetId |
| `audit_packet_email_link` | buildAuditPacketJob completes → email sent with signed URL (TTL 10 min) |
| `pagination_25_rows` | listInvoicesAction returns 25 rows max, hasNext flag for infinite scroll |

**Test environment:** real MariaDB (testcontainers), node:22-slim Docker, same Hostinger arch assumptions.

---

## Least confident decisions — numbered list of calls most worth challenging now, while changing them is free

1. **Exact Zod shape for `reviewInvoiceSchema.lines`** — nested vs flat array, whether `raw_pack_size` is required or optional for each `line_type`.
2. **`deriveUnitCost` formula when `pack_size` is null** — fall back to `raw_net / raw_qty`, or error? This affects 5 of the 9 bottled-beer products in the catalog.
3. **`matchLinesToProducts` confidence threshold** — what minimum confidence promotes a line from "unmatched" to "matched_product_id" set? This drives the review UI badge behavior.
4. **Offsite sync: local-first, Cloudflare R2 as backup** — primary storage is the local `public/invoices/` directory on Hostinger (free, zero egress). Cloudflare R2 (free tier: 10GB storage + 1GB egress/month) is the offsite backup copy, used for audit-packet ZIP resilience and as a secondary offsite archive. `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` are only set if the R2 backup path is configured; otherwise the pipeline reads/writes exclusively local.
5. **`retention_until` computation: exact 3 years or calendar-year boundary?** `invoice_date + 3 years` vs `Date.utcFullYear(invoice_date.getFullYear() + 3, ...)` — matters for audit-packet date ranges.
6. **Cron interval: 2 min vs 1 min vs 5 min** — extraction is ~83 ms/pdf × pages; 2 min gives ~40s headroom for 10-page batch on Hostinger's 5–10 connection pool. Tighter interval risks rate-limited pdf-inspector calls.
7. **Signed URL TTL: 10 min vs 5 min vs 15 min** — 10 min was the Gate 2 decision; shorter increases refresh frequency, longer widens the window if the email lands in spam.

These are the calls most worth challenging during Gate 3 review — changing any of them after implementation requires a schema migration + data recount.

---

## Standing rule reminder

**Compact at every boundary.** At Gate 4 boundary, ensure every decision from Gates 1–3 that outlives this feature is recorded either in `STATE.md`'s history log, `docs/reviews/*.md`, or (if it outlives the repo) `docs/adr/`. This repo already has an informal ADR equivalent in STATE.md's dated correction blockquotes.

**Real tests only.** Never write a test that passes against the pre-change code. Never skip, weaken, or comment out a test to get green.
