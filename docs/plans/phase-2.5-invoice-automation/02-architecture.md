# Gate 2 — Architecture: Phase 2.5 OCR invoice automation

Cites `01-product.md`, `docs/invoice-automation-research.md` (Parts 1–5), and the existing codebase. No implementation code exists yet — this document is the contract for Gate 3.

---

## Fit — existing modules touched

| Module | What changes | Why |
|--------|--------------|-----|
| `db/schema.ts` | Add 7 tables: `vendor`, `invoice`, `invoice_line`, `vendor_alias`, `extraction_job`, `audit_packet`, `audit_packet_file` | Core data model (research §3.1) |
| `lib/authz.ts` | Add `canManageInvoices`, `canReviewInvoices` role checks | Invoice actions need auth distinct from inventory ops |
| `lib/action-result.ts` | No change — reuse existing `ActionResult` + `runAction` | Proven pattern |
| `lib/domain/errors.ts` | Add `InvoiceNotFoundError`, `InvoiceNotWritableError`, `ExtractionFailedError`, `MatchingError` | Domain errors for new flows |
| `lib/validation/invoices.ts` | New file — Zod schemas for all invoice actions | Input validation layer |
| `app/actions/invoices.ts` | New file — 10 server actions (upload, list, get, review, approve, archive, audit-packet) | Server action layer |
| `app/(office)/office/invoices/` | New routes: `upload/page.tsx`, `review/page.tsx`, `[id]/review/page.tsx`, `archive/page.tsx`, `audit-packet/page.tsx` | Office screens (mockups in Gate 1) |
| `components/office/` | New: `invoice-upload.tsx`, `review-queue.tsx`, `review-invoice.tsx`, `archive-table.tsx`, `audit-packet.tsx` | UI components per screen |
| `lib/domain/invoices.ts` | New — invoice CRUD, approval, archive queries | Business logic |
| `lib/domain/extraction.ts` | New — `extraction_job` lifecycle, pdf-inspector integration, Claude vision call | Extraction pipeline |
| `lib/domain/matching.ts` | New — 5-rung matching ladder, alias upsert, cost derivation | Vendor → catalog matching |
| `lib/domain/cost-derivation.ts` | New — unit cost math, deposit exclusion, keg arithmetic | Cost logic (invariant: deposits never in product cost) |
| `middleware.ts` | Extend CSP for `invoices/*` paths (camera, file input permissions) | CSP must be per-request nonce; never static header |
| `db/seed.ts` | Optional: add `vendor_item_code` examples for seeded vendors | Demo/test data |

---

## Endpoints — route + verb + purpose

All server actions live in `app/actions/invoices.ts` and are called from client components via `runAction`. No REST endpoints; Next.js Server Actions are the transport.

| Action | Verb (conceptual) | Purpose |
|--------|-------------------|---------|
| `uploadInvoiceAction` | POST | Accept file/photo/email-forward metadata → create `invoice` (status `uploaded`) + `extraction_job` (status `pending`) → return signed upload URL for object storage |
| `listInvoicesAction` | GET | Paginated list for review queue / archive with filters (status, vendor, date range) |
| `getInvoiceAction` | GET | Single invoice with lines + extraction metadata for review screen |
| `reviewInvoiceAction` | POST | Owner submits corrected line table → validate arithmetic → if pass: upsert `vendor_alias` matches → update `invoice` lines, status `reviewed`; if fail: return exception list |
| `approveInvoiceAction` | POST | Owner approves reviewed invoice → status `approved` → write costs to `product` (owner-only), set `retention_until = invoice_date + 3 years` |
| `rejectInvoiceAction` | POST | Owner returns to vendor / re-extract → status `rejected` with reason |
| `createAuditPacketAction` | POST | Owner requests date-range packet → create `audit_packet` (status `building`) → enqueue background job → return packet ID |
| `getAuditPacketAction` | GET | Poll packet status → when `ready`, return signed download URL (TTL 10 min) |
| `getExtractionStatusAction` | GET | Poll `extraction_job` status for review queue "processing" badge |
| `resendToExtractionAction` | POST | Re-queue a failed/rejected invoice for re-extraction (different OCR path) |

**Cron jobs (internal, no client call):**

| Job | Schedule | Purpose |
|-----|----------|---------|
| `processExtractionQueue` | Every 2 min | Pick pending `extraction_job` → classify → text: pdf-inspector / scanned: Claude vision → write `invoice_line` drafts → update job status |
| `offsiteSyncJob` | Daily 02:00 | Copy new object-storage files to offsite bucket (R2/S3-compatible) for redundancy |
| `buildAuditPacketJob` | On-demand (triggered by `createAuditPacketAction`) | ZIP invoices + counts + manifest with SHA-256 per file → upload → email signed link |

---

## Data — tables + query outlines

All tables scoped to `organizationId` (tenant boundary). `organizationId` is NOT nullable; every row belongs to one org.

### 1. `vendor` (extends existing concept — was implicit in catalog)
```sql
id, organization_id, name, created_at, updated_at
```
**Queries:** `listVendors(orgId)` — for upload vendor picker; `getVendorByName(orgId, name)` — fuzzy match on email-forward sender.

### 2. `invoice`
```sql
id, organization_id, vendor_id, status (uploaded|processing|needs_review|reviewed|approved|rejected),
source (photo|pdf|email_forward), file_path, file_sha256, page_count,
invoice_date, due_date, invoice_number, total_gross, total_discount, total_net,
currency, retention_until, approved_at, approved_by,
created_at, updated_at
```
**Indexes:** `(organization_id, status, invoice_date DESC)` — review queue; `(organization_id, vendor_id, invoice_date DESC)` — archive; `(organization_id, retention_until)` — retention sweep.
**Queries:** `listInvoices(orgId, {status?, vendorId?, dateFrom?, dateTo?, page?, pageSize?})` — review queue + archive; `getInvoice(orgId, id)` — review screen; `findByNumber(orgId, vendorId, invoiceNumber)` — duplicate detection.

### 3. `invoice_line`
```sql
id, invoice_id, line_number, raw_name, raw_qty, raw_uom, raw_pack_size,
raw_gross, raw_discount, raw_net, line_type (product|deposit|freight|tax|other),
matched_product_id, matched_vendor_alias_id, confidence, exception_flags (json),
created_at, updated_at
```
**Unique:** `(invoice_id, line_number)` — deterministic ordering.
**Queries:** `getLinesByInvoice(orgId, invoiceId)` — review table; `upsertLines(invoiceId, lines[])` — extraction write + review correction; `getUnmatchedLines(orgId)` — matching ladder input.

### 4. `vendor_alias` (the "fix once" memory)
```sql
id, organization_id, vendor_id, vendor_item_code, matched_product_id,
confidence, created_at, updated_at
```
**Unique:** `(organization_id, vendor_id, vendor_item_code)` — one alias per vendor code.
**Queries:** `findAlias(orgId, vendorId, vendorItemCode)` — matching ladder rung 1; `upsertAlias(orgId, vendorId, code, productId)` — review correction persists.

### 5. `extraction_job`
```sql
id, invoice_id, status (pending|classifying|extracting|ocr|done|failed), pdf_type (text|scanned|mixed|image), pages_needing_ocr (json), error_message, started_at, completed_at, retry_count
```
**Queries:** `claimNextPending(orgId)` — cron worker; `updateStatus(id, status, data?)` — pipeline steps; `getByInvoice(invoiceId)` — review queue badge.

### 6. `audit_packet`
```sql
id, organization_id, status (building|ready|expired|failed), date_from, date_to, file_path, file_sha256, manifest_json, expires_at, created_at, completed_at
```
**Queries:** `create(orgId, dateFrom, dateTo)` — on-demand; `get(orgId, id)` — poll + download.

### 7. `audit_packet_file` (manifest line items)
```sql
id, audit_packet_id, source_table (invoice|count|product), source_id, file_path, sha256
```
**Queries:** `insertBatch(packetId, files[])` — job worker; `getManifest(packetId)` — manifest JSON.

---

## Flow — end-to-end call order (main path)

**A. Upload → Archive (Phase A — no AI)**
```
Client: uploadInvoiceAction(file, metadata)
  → validate (Zod) → create invoice row (status=uploaded) → create extraction_job (pending)
  → generate signed PUT URL for object storage (R2/S3) → return {invoiceId, uploadUrl}
Client: PUT file to uploadUrl
  → (object storage webhook or polling) → extraction_job.status = ready_for_classify
```

**B. Extraction Pipeline (Phase B — cron-driven)**
```
Cron (processExtractionQueue, every 2 min):
  → claimNextPending(orgId) → extraction_job
  → classifyPdf(fileBuffer) → pdfType + confidence
  → IF text-based:
       processPdf(fileBuffer) → markdown + tables
       parseMarkdownToLines(markdown) → invoice_line[] drafts
    ELSE (scanned/mixed):
       renderPagesToImages(fileBuffer, pagesNeedingOcr) → image[]
       callClaudeVision(image[], schema) → structured JSON
       parseVisionToLines(json) → invoice_line[] drafts
  → arithmeticCheck(lines, invoice.total_gross) → pass/fail + mismatch amount
  → pdfInspectorCrossCheck(lines, markdown) → pass/fail + dropped line flags
  → write invoice_line drafts (confidence, exception_flags)
  → update extraction_job → done | failed
  → update invoice.status → needs_review | uploaded (if auto-approve eligible — never in v1)
```

**C. Review → Approve (Phase B+C — human in loop)**
```
Client: listInvoicesAction({status: needs_review, page: 1, pageSize: 25})
  → review queue renders

Client: getInvoiceAction(invoiceId)
  → invoice + lines + extraction_job (for badges) → review-invoice screen

Client: reviewInvoiceAction(invoiceId, correctedLines[])
  → arithmeticCheck(correctedLines, invoice.total_gross) → if fail: return exceptions
  → FOR each line:
       IF vendor_item_code extracted AND no alias:
            upsert vendor_alias (vendorId, code, matchedProductId)
       IF product matched:
            update line.matched_product_id, matched_vendor_alias_id
  → update invoice.status = reviewed
  → return updated invoice
```

**D. Approve → Cost Flow (Phase D)**
```
Client: approveInvoiceAction(invoiceId)  // requireRole("owner")
  → FOR each line WHERE line_type = product AND matched_product_id:
       unitCost = deriveUnitCost(line)  // raw_net / qty / pack_size (deposits excluded)
       upsert product.unit_cost = unitCost, product.unit_cost_updated_at = now()
       write cost_history (product_id, unit_cost, source_invoice_id, effective_at)
  → invoice.status = approved, approved_at = now(), approved_by = actor.userId
  → retention_until already set at upload
  → return approved invoice
```

**E. Audit Packet (Phase E — on-demand)**
```
Client: createAuditPacketAction(dateFrom, dateTo)  // requireRole("owner")
  → create audit_packet (building)
  → enqueue buildAuditPacketJob(packetId) → return {packetId}

Job: buildAuditPacketJob(packetId)
  → query invoices + counts in range → stream to ZIP
  → compute SHA-256 per file → manifest_json
  → upload ZIP to object storage → file_path, file_sha256
  → update audit_packet: status=ready, expires_at=now()+10min, manifest_json
  → email signed download link to owner (SES/SendGrid)

Client: getAuditPacketAction(packetId) → signed URL (TTL 10 min)
```

---

## External — third-party, env var names, webhooks

| Dependency | Purpose | Env var names (never values) |
|------------|---------|------------------------------|
| `@firecrawl/pdf-inspector` | PDF classify + text extraction (native binary) | — (npm dep) |
| Anthropic Claude API | Vision OCR for scanned pages | `ANTHROPIC_API_KEY` |
| **Primary: Local filesystem** | Invoice PDFs stored on Hostinger disk at `public/invoices/` (free, zero egress) | `INVOICE_LOCAL_DIR` — defaults to `./public/invoices/` |
| **Backup: Cloudflare R2** | Offsite copy / audit-packet ZIP if local unavailable; free tier 10GB storage + 1GB egress/month | `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`; `R2_UPLOAD_BUCKET_INVOICES` (optional prefix) |
| Email provider (SES / SendGrid) | Audit packet download link email | `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` |
| Inbound email webhook | Email-forward intake (`invoices@truestock.app`) | `INBOUND_EMAIL_WEBHOOK_SECRET` (verify signature) |

**No other externals.** Distributor portal automation explicitly out of scope (research Part 5). QuickBooks/Xero sync out of scope (Gate 1 "Not in this bundle").

---

## Decisions carried from Gate 1 + research (not re-litigated here)

- **Scan-primary** — Claude vision is primary path; pdf-inspector text path is fast-path bonus (§5.1)
- **Review queue is governor** — 30-min metric measured with human review on every doc (§5.1.2)
- **Arithmetic check never silently fixes** — mismatch is the badge, both totals shown (§1.2.2)
- **Deposits never in product cost** — `line_type=deposit` excluded from cost derivation (invariant)
- **Retention at write** — `retention_until = invoice_date + 3 years` computed at upload, not approval (§3.6)
- **No delete path** — `invoice` and `count` rows never hard-deleted (invariants 1, 6)
- **Auto-approve off** — first ~100 invoices of correction data before threshold tuning (§3.4, Gate 1)
- **Signed URL TTL = 10 min** — for audit packet download (Gate 2 decision)
- **Cron: extraction every 2 min, offsite sync 02:00 daily, audit-packet on-demand** (Gate 2 decision)
- **Upload limit: 25 MB / 10 pages** — Hostinger default body parser limit (Gate 2 decision)
- **Review pagination: 25 rows, infinite scroll** (Gate 2 decision)
- **Role perms: owner=full, manager=upload+review (no cost), staff=none** (Gate 2 decision)
- **Email-forward: single domain `invoices@truestock.app`, org resolved by sender domain → vendor match** (Gate 2 decision)

---

## Open questions for Gate 3 (implementation details, not architecture)

1. Exact Zod schema shapes for `reviewInvoiceSchema.lines` — nested vs flat array, whether `raw_pack_size` is required or optional for each `line_type`.
2. `deriveUnitCost` formula when `pack_size` is null — fall back to `raw_net / raw_qty`, or error? This affects 5 of the 9 bottled-beer products in the catalog.
3. `matchLinesToProducts` confidence threshold — what minimum confidence promotes a line from "unmatched" to "matched_product_id" set? This drives the review UI badge behavior.
4. **Offsite sync: local-first, Cloudflare R2 as backup** — primary storage is the local `public/invoices/` directory on Hostinger (free, zero egress). Cloudflare R2 (free tier: 10GB storage + 1GB egress/month) is the offsite backup copy, used for audit-packet ZIP resilience and as a secondary offsite archive. `R2_*` env vars are only set if the R2 backup path is configured; otherwise the pipeline reads/writes exclusively local.
5. `retention_until` computation: exact 3 years or calendar-year boundary? `invoice_date + 3 years` vs `Date.utcFullYear(invoice_date.getFullYear() + 3, ...)` — matters for audit-packet date ranges.
6. Cron interval: 2 min vs 1 min vs 5 min — extraction is ~83 ms/pdf × pages; 2 min gives ~40s headroom for 10-page batch on Hostinger's 5–10 connection pool. Tighter interval risks rate-limited pdf-inspector calls.
7. Signed URL TTL: 10 min vs 5 min vs 15 min — 10 min was the Gate 2 decision; shorter increases refresh frequency, longer widens the window if the email lands in spam.

These are the calls most worth challenging during Gate 3 review — changing any of them after implementation requires a schema migration + data recount.
