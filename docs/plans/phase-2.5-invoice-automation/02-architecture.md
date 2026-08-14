# Gate 2 — Architecture: Phase 2.5 OCR invoice automation

Cites `01-product.md`, `docs/invoice-automation-research.md` (Parts 1–5), and the existing codebase. No implementation code exists yet — this document is the contract for Gate 3.

> **Corrected 2026-08-14 after adversarial review.** The first version of this document
> contained three critical and four high findings — see
> `docs/reviews/2026-08-14-phase-2.5-adversarial-review.md`. The corrections are
> incorporated below and marked **[AR-n]** against the finding they close. Gate 2–4
> approval is withdrawn until the corrected contract is re-approved.

---

## Fit — existing modules touched

| Module | What changes | Why |
|--------|--------------|-----|
| `db/schema.ts` | Add 7 tables: `invoice`, `invoice_line`, `vendor_alias`, `extraction_job`, `audit_packet`, `audit_packet_file`, `product_cost_history`. **`vendor` already exists** (`db/schema.ts:300`) and is reused, not recreated **[AR-5]** | Core data model (research §3.1) |
| `app/api/invoices/[id]/file/route.ts` | New — the *only* path by which an invoice document is served; ownership-checks `(organization_id, invoice_id)` then streams **[AR-1]** | Invoice bytes must never be statically served |
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

**[AR-7] Role is a column here, not a sentence in the Purpose cell.** The original
role contract survived review because it lived in prose — one bullet at the bottom of the
document said "manager = upload + review (no cost)" while the screen two sections above it
rendered per-line cost. Every action below states its required role explicitly, in its own
column, so the contract can be read down a column and checked mechanically against
`lib/authz.ts` rather than inferred from a paragraph. **An action with no role is a bug in
this table, not a permissive default.**

| Action | Verb | Role | Purpose |
|--------|------|------|---------|
| `uploadInvoiceAction` | POST | owner, manager | Accept file/photo/email-forward metadata + declared size/SHA-256 → create `invoice` (status `uploaded`) + `extraction_job` (status **`awaiting_upload`**, not yet claimable) → return upload URL **[AR-6]** |
| `confirmUploadAction` | POST | owner, manager | **New.** Verify the stored object exists and its size + SHA-256 match what was declared → only then move `extraction_job` to `queued` **[AR-6]** |
| `listInvoicesAction` | GET | owner | Paginated list **with monetary columns** for review queue / archive **[AR-7]** |
| `listInvoicesRedactedAction` | GET | manager | **Separate action, separate query.** Vendor, date, invoice number, status, line descriptions and quantities. Selects no monetary column — the redaction is in the SQL, not in a filter over a full row **[AR-7]** |
| `getInvoiceAction` | GET | **owner only** | Single invoice with lines + extraction metadata for review screen. The screen *is* cost data **[AR-7]** |
| `reviewInvoiceAction` | POST | **owner only** | Submit corrected line table → ownership-check every nested `matched_product_id` **[AR-2]** → validate arithmetic → if pass: upsert `vendor_alias` matches → update lines, CAS `needs_review`→`reviewed`; if fail: return exception list |
| `approveInvoiceAction` | POST | **owner only** | **Single transaction**: compare-and-set `reviewed`→`approved`, then write `product.current_unit_cost` + `product_cost_history` **[AR-4] [AR-5]**. Replay returns the original success |
| `GET /api/invoices/[id]/file` | GET (route handler) | **owner only** | **New.** The only path to invoice bytes — ownership-checked, path-traversal-guarded, streamed from outside the web root **[AR-1]** |
| `rejectInvoiceAction` | POST | **owner only** | CAS from `needs_review` or `reviewed` → `rejected` with reason. **Never from `approved`** — see the invoice state machine below **[AR-4]** |
| `createAuditPacketAction` | POST | **owner only** | Create `audit_packet` (status `building`) → enqueue background job → return packet ID |
| `getAuditPacketAction` | GET | **owner only** | Poll packet status, ownership-checked → when `ready`, return signed download URL (TTL 10 min) |
| `getExtractionStatusAction` | GET | owner, manager | Poll `extraction_job` status + `phase` for the queue's "processing" badge. Returns status only — **never `error_message`**, which can quote invoice text **[AR-7]** |
| `resendToExtractionAction` | POST | **owner only** | Re-extract a `failed` job or a `rejected` invoice → **opens a new `extraction_job` row**, never mutates the old one **[AR-6]** |

**Why `listInvoices` split into two actions [AR-7].** The earlier version was one action
that branched on role internally. That is the shape that leaks: the monetary columns are
already in the result set, and "manager" is a filter applied afterwards — one refactor, one
new field added to a shared serializer, one debug log of the pre-filter row, and the cost
data is out. Two actions calling two queries means the manager path never loads a monetary
column into memory at all, so there is nothing to leak. Redaction that happens after the
`SELECT` is not redaction.

**Cron jobs (internal, no client call):**

| Job | Schedule | Purpose |
|-----|----------|---------|
| `processExtractionQueue` | Every 2 min | **Atomically claim** the next `queued` `extraction_job` (conditional update; zero rows = another worker won) → classify → text: pdf-inspector / scanned: Claude vision → write `invoice_line` drafts → update job status **[AR-6]** |
| `reapStuckJobs` | Every 5 min | **New [AR-6].** Return jobs stuck `running` past a 15-minute claim timeout to `queued` and increment `retry_count`; at 3 attempts move to `failed` with `'worker timeout'`. Without this a crashed worker strands its invoice in "processing" forever, silently |
| `offsiteSyncJob` | Daily 02:00 | Copy new object-storage files to offsite bucket (R2/S3-compatible) for redundancy. **Reads from `INVOICE_STORAGE_DIR`; the destination bucket must be private [AR-1]** |
| `buildAuditPacketJob` | On-demand (triggered by `createAuditPacketAction`) | Read `organization_id` from the packet row, then scope **every** invoice, count, product and file query to it → ZIP + manifest with SHA-256 per file → assert one distinct org → upload → email signed link **[AR-3]** |

---

## Data — tables + query outlines

All tables scoped to `organizationId` (tenant boundary). `organizationId` is NOT nullable; every row belongs to one org.

**[AR-2] Tenant scoping is structural, not conventional.** Every table below — including
every child table — carries its own `organization_id` **and** a composite
`(organization_id, parent_id)` foreign key to its parent, exactly as `product` → `vendor`
and `count_line` → `count` already do in `db/schema.ts`. Each table also gets the
`(organization_id, id)` unique index those composite FKs require. A child row therefore
*cannot* be attached to a parent in another organization: the database refuses it (1452),
rather than the application remembering to check. Every table's `id` is additionally
ownership-checked in the domain layer — a foreign key proves a row exists, not whose it
is (invariant 9).

### 1. `vendor` — **already exists, reused unchanged** [AR-5]
`db/schema.ts:300` already defines `vendor` with `organization_id`, `name`, `contact`,
`order_method`, `lead_time_days`, audit columns, and the
`vendor_organization_id_id_unique` composite index that `product`'s tenant FK targets.
**This phase adds no columns to it and must not redefine it.** The earlier draft listed
`vendor` as a new table; generating that migration would have failed or created a
duplicate.
**Queries:** `listVendors(actor)` — upload vendor picker; `getVendorByName(actor, name)` — fuzzy match on email-forward sender.

### 2. `invoice`
```sql
id, organization_id, vendor_id, status (uploaded|processing|needs_review|reviewed|approved|rejected),
source (photo|pdf|email_forward), file_path, file_sha256, page_count,
invoice_date, due_date, invoice_number, total_gross, total_discount, total_net,
currency, retention_until, approved_at, approved_by,
created_at, updated_at
```
**[AR-4] The invoice status machine — declared here, once.** AR-6 forced this discipline
onto `extraction_job` and stopped at the job table. The invoice status is the one with
money attached, and it was left as a bare six-value enum with no transitions defined
anywhere in any gate document. Same defect, higher stakes: the reason `ready_for_classify`
was catchable is that someone had written the job lifecycle down to compare it against.

```
uploaded ──► processing ──► needs_review ──► reviewed ──► approved   (terminal)
                  │               │              │
                  │               └──────────────┴──► rejected  ──► (re-extract)
                  └──► needs_review (extraction failed, flagged for manual entry)
```

Rules, each enforced as a compare-and-set on the transition, never a bare `SET status`:

| From | To | Guard |
|---|---|---|
| `uploaded` | `processing` | worker claimed the job |
| `processing` | `needs_review` | extraction wrote lines, or failed and needs manual entry |
| `needs_review` | `reviewed` | arithmetic check passed; owner submitted **[AR-7]** |
| `needs_review` \| `reviewed` | `rejected` | owner, with reason |
| `reviewed` | `approved` | owner; the CAS in flow D; **the only transition that writes cost** |
| `rejected` | `processing` | `resendToExtractionAction`, via a **new** `extraction_job` |

**`approved` is terminal and nothing transitions out of it.** This is the rule most worth
stating, because the endpoint list contained `rejectInvoiceAction` with no guard at all —
so rejecting an already-approved invoice was reachable. The result would have been quiet
and unrecoverable: `product_cost_history` is append-only (invariants 1, 6), so the cost
rows stay and `product.current_unit_cost` keeps the value the invoice set, while the
invoice itself now reads `rejected`. Every valuation downstream is then costed from a
document the system says it refused. A correction to an approved invoice is a **new
adjustment record**, exactly as invariant 1 requires for closed counts — never a status
edit.

**Unique:** `(organization_id, id)` — required by the composite FKs that `invoice_line`,
`extraction_job` and `product_cost_history` point at.
**Composite tenant FK [AR-2]:** `(organization_id, vendor_id)` → `vendor`. The upload form
supplies `vendor_id` from a client picker, so it is a client-supplied id like any other:
without this FK an invoice can be filed against another tenant's vendor, and every archive
and audit-packet query downstream then reports it under that vendor's name.
**Indexes:** `(organization_id, status, invoice_date DESC)` — review queue; `(organization_id, vendor_id, invoice_date DESC)` — archive; `(organization_id, retention_until)` — retention sweep.
**Queries:** `listInvoicesForOwner(actor, filters)` and `listInvoicesRedacted(actor, filters)` — **two functions, two SELECTs; there is deliberately no role-agnostic `listInvoices`** [AR-7]; `getInvoice(actor, id)` — review screen, owner-only; `findByNumber(actor, vendorId, invoiceNumber)` — duplicate detection. All take `Actor` and filter on `actor.organizationId`; a cross-tenant id returns `NotFoundError`, never an answer confirming the row exists.

### 3. `invoice_line`
```sql
id, organization_id, invoice_id, line_number, raw_name, raw_qty, raw_uom, raw_pack_size,
raw_gross, raw_discount, raw_net, line_type (product|deposit|freight|tax|other),
matched_product_id, matched_vendor_alias_id, confidence, exception_flags (json),
created_at, updated_at
```
**Unique:** `(invoice_id, line_number)` — deterministic ordering. Plus
`(organization_id, id)` for the composite FKs below.
**Composite tenant FKs [AR-2]:** `(organization_id, invoice_id)` → `invoice`,
`(organization_id, matched_product_id)` → `product`,
`(organization_id, matched_vendor_alias_id)` → `vendor_alias`. The `matched_product_id`
FK is the one that matters most: it makes a cross-tenant product id a database error
rather than a silent cost overwrite on approval.
**Queries:** `getLinesByInvoice(actor, invoiceId)` — review table; `upsertLines(actor, invoiceId, lines[])` — extraction write + review correction; `getUnmatchedLines(actor)` — matching ladder input. Every one takes `Actor` and filters on `actor.organizationId`.

### 4. `vendor_alias` (the "fix once" memory)
```sql
id, organization_id, vendor_id, vendor_item_code, matched_product_id,
confidence, created_at, updated_at
```
**Unique:** `(organization_id, vendor_id, vendor_item_code)` — one alias per vendor code.
Plus `(organization_id, id)` for the composite FK `invoice_line.matched_vendor_alias_id`
points at.
**Composite tenant FKs [AR-2]:** `(organization_id, vendor_id)` → `vendor`,
`(organization_id, matched_product_id)` → `product`.

**This is the stickiest form of AR-2 and the one most worth guarding.** Both of this
table's parent references arrive from the client: the review screen calls
`upsertAlias(actor, vendorId, code, productId)` with ids the reviewer's browser supplied.
Every other cross-tenant id in this phase does its damage once, on one invoice line. An
alias is *remembered* — it is rung 1 of the matching ladder, so a bad `matched_product_id`
written here is silently re-applied to every future invoice from that vendor, and each
approval repoints cost at the same wrong product. The damage compounds while looking
progressively more legitimate, because a high-confidence alias match is exactly what the
review UI stops flagging.
**Queries:** `findAlias(actor, vendorId, vendorItemCode)` — matching ladder rung 1; `upsertAlias(actor, vendorId, code, productId)` — review correction persists. Both take `Actor`; `upsertAlias` ownership-checks `vendorId` and `productId` before the write, in addition to the FKs.

### 5. `extraction_job`
```sql
id, organization_id, invoice_id,
status (awaiting_upload|queued|running|done|failed),
phase (classify|text_extract|ocr|parse)  -- observability only, never a claim predicate
pdf_type (text|scanned|mixed|image), pages_needing_ocr (json), error_message,
claimed_at, claimed_by, started_at, completed_at, retry_count
```
**[AR-6] One state machine, declared once.** The earlier draft had three incompatible
vocabularies: the enum said `pending`, Slice 1 wrote `ready_for_classify` (not in the
enum — MariaDB would reject it), and the cron claimed `pending`. The lifecycle is now
exactly `awaiting_upload → queued → running → done | failed`, and nothing writes a value
outside it. Progress *within* extraction is the separate `phase` column, so adding a
pipeline step never changes the claim predicate.

**The job is created `awaiting_upload`, not `queued`.** This is the ordering fix, and it
matters more than the naming: the invoice row and the job row are created *before* the
client has uploaded the file. A job that is claimable at creation gets picked up by the
2-minute cron while the object does not yet exist, and fails as what looks like OCR
flakiness. A job only becomes `queued` after the upload is confirmed **and** the stored
object's byte length and SHA-256 match what was declared at upload.

**Claiming is atomic.** `claimNextJob` is a conditional update
(`SET status='running', claimed_at=NOW(), claimed_by=:worker WHERE status='queued' ... LIMIT 1`),
and a zero-row result means another worker won. Two cron ticks overlapping — which they
will, since extraction can exceed 2 minutes — must never both claim one job.
**[AR-6] A claimed job that never finishes must come back.** The lifecycle as first
corrected has no edge out of `running` except `done` or `failed`, both written by the
worker — so if the worker dies mid-extraction (deploy, OOM on a 10-page scan, Hostinger
restarting `lsnode`), the row stays `running` forever. Nothing re-claims it, because the
claim predicate is `status='queued'`. The invoice sits in the queue showing "processing"
indefinitely and no error is ever raised, which is the same silent shape as every other
finding in this review: the feature looks busy rather than broken, and the only symptom is
an invoice nobody notices is missing weeks later.

`claimed_at` was described as making a stuck job "diagnosable". Diagnosable is not
recoverable. The reaper is the missing edge:

```
running ──(claimed_at < NOW() - INTERVAL 15 MINUTE)──► queued   -- retry_count += 1
running ──(same, but retry_count >= 3)──────────────► failed    -- error: 'worker timeout'
```

Reclaiming is safe because extraction is idempotent by construction: it writes
`invoice_line` **drafts** keyed by `(invoice_id, line_number)` and the invoice has not yet
been reviewed or approved, so a second pass overwrites drafts rather than duplicating
anything. Nothing downstream of extraction has run.

**`retry_count` is now bounded, and it is bounded here.** It was declared in the schema and
never incremented or read by any transition — a column that looks like a safety limit and
enforces nothing. Three attempts, then `failed` with the reason recorded, so a PDF that
reliably kills the worker stops taking the queue down with it on every sweep.

**`updateStatus` must not be a hole in the machine.** As written it accepts any status for
any job and would happily write `done → queued` or skip `running` entirely, which defeats
the point of declaring the lifecycle. It takes the expected current status and performs a
conditional update; an unexpected transition is an error, not a silent write.

**Composite tenant FK [AR-2]:** `(organization_id, invoice_id)` → `invoice`.
**Queries:** `claimNextJob(workerId)` — cron worker, atomic as above; `updateStatus(id, from, to, data?)` — pipeline steps, transition-guarded; `reapStuckJobs()` — the timeout sweep above; `getByInvoice(actor, invoiceId)` — review queue badge.

### 6. `audit_packet`
```sql
id, organization_id, status (building|ready|expired|failed), date_from, date_to, file_path, file_sha256, manifest_json, expires_at, created_at, completed_at
```
**Unique:** `(organization_id, id)` — required by `audit_packet_file`'s composite FK.
**Queries:** `create(actor, dateFrom, dateTo)` — on-demand; `get(actor, id)` — poll + download, ownership-checked so one owner cannot poll or download another org's packet by id.

### 7. `audit_packet_file` (manifest line items)
```sql
id, organization_id, audit_packet_id, source_table (invoice|count|product), source_id, file_path, sha256
```
**Composite tenant FK [AR-2]:** `(organization_id, audit_packet_id)` → `audit_packet`.
**`source_id` is polymorphic and therefore cannot be FK-guarded [AR-3].** It points into
`invoice`, `count` or `product` depending on `source_table`, so the database cannot
enforce that the referenced row belongs to `organization_id` the way it can everywhere
else in this phase. This is the one place in the audit-packet path where tenant scoping
rests on application code rather than a constraint — which is precisely where AR-3's leak
lived. The compensating controls are the ones in flow E: every source query is filtered by
the `orgId` read from the packet row, and the manifest asserts a single distinct
`organization_id` before the ZIP is finalised. Both are required, not belt-and-braces.
**Queries:** `insertBatch(actor, packetId, files[])` — job worker; `getManifest(actor, packetId)` — manifest JSON.

### 8. `product_cost_history` — **new; was referenced but never designed** [AR-5]
The earlier draft wrote `INSERT INTO cost_history` in two flows without ever defining the
table, and updated `product.unit_cost_updated_at`, a column that does not exist. The live
product cost column is **`current_unit_cost`** (`db/schema.ts:393`); there is no
update-time column. Cost provenance — the audit trail answering "why is this bottle
costed at $18.42?" — is the entire point of the phase, so it gets a real table.

```sql
id, organization_id, product_id,
source_invoice_id, source_invoice_line_id,
unit_cost DECIMAL(10,4) NOT NULL,      -- same precision as product.current_unit_cost
previous_unit_cost DECIMAL(10,4),      -- NULL on first costing; enables the price-jump badge
effective_at, created_by, created_at
```
**Unique:** `(source_invoice_line_id)` — **this is the idempotency key** [AR-4]. Approving
the same invoice twice cannot write two history rows for one line; the duplicate rolls
back, exactly as `count_line_write.client_line_id` does for count writes (invariant 5).
**Composite tenant FKs [AR-2]:** `(organization_id, product_id)` → `product`,
`(organization_id, source_invoice_id)` → `invoice`,
`(organization_id, source_invoice_line_id)` → `invoice_line`.
**Append-only** — rows are never updated or deleted (invariants 1, 6). `product.current_unit_cost`
is the denormalised "latest"; this table is the truth about how it got there.
**Indexes:** `(organization_id, product_id, effective_at DESC)` — cost history per product.
**Queries:** `getCostHistory(actor, productId)` — product detail; `getLatestCost(actor, productId)` — price-jump comparison.

---

## Flow — end-to-end call order (main path)

**A. Upload → Archive (Phase A — no AI)**
```
Client: uploadInvoiceAction(metadata, declaredSize, declaredSha256)
  → validate (Zod) → create invoice row (status=uploaded)
  → create extraction_job (status = awaiting_upload)   ← NOT claimable yet  [AR-6]
  → return {invoiceId, uploadUrl}

Client: PUT file to uploadUrl  → written under INVOICE_STORAGE_DIR (never public/)  [AR-1]

Server: confirmUploadAction(invoiceId)
  → assert stored object exists
  → assert byte length === declaredSize
  → assert SHA-256 === declaredSha256   → store as invoice.file_sha256
  → ONLY THEN: extraction_job.status = queued   ← now claimable by cron
```

**[AR-6] Why the job starts `awaiting_upload`.** The earlier draft created the job as
`pending` — the same value the cron claims — at the moment the *invoice row* was created,
which is before the client has finished uploading. The 2-minute cron would claim jobs
whose file does not exist yet and fail on a missing object, presenting as intermittent
OCR flakiness rather than an ordering bug. Verifying size and hash before queueing also
means a truncated upload is caught here, at the one point where re-uploading is cheap,
rather than as a mangled extraction later.

**B. Extraction Pipeline (Phase B — cron-driven)**
```
Cron (processExtractionQueue, every 2 min):
  → claimNextJob(workerId) → extraction_job   // atomic conditional update on status='queued'
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

Client: reviewInvoiceAction(invoiceId, correctedLines[])   // requireRole("owner")  [AR-7]
  → getInvoice(actor, invoiceId)      // ownership-checked; cross-tenant ⇒ NotFoundError
  → assertProductsOwned(actor, correctedLines.map(l => l.matched_product_id))   ← [AR-2]
       // ONE batched ownership check, before any write, over every client-supplied
       // product id in the payload. Cross-tenant or unknown ⇒ NotFoundError, whole
       // request rejected. Not per-line inside the loop: a partial reject would leave
       // some lines and aliases written and some not, with the invoice still in review.
  → arithmeticCheck(correctedLines, invoice.total_gross) → if fail: return exceptions
  → FOR each line:
       IF vendor_item_code extracted AND no alias:
            upsert vendor_alias (actor, vendorId, code, matchedProductId)
       IF product matched:
            update line.matched_product_id, matched_vendor_alias_id
  → CAS invoice.status: needs_review → reviewed        ← not a bare SET  [AR-4]
       // zero rows ⇒ it was approved or rejected while this reviewer had the screen
       // open ⇒ return a conflict the UI can show, never a silent overwrite
  → return updated invoice
```

**[AR-2] Why the check is here and not only at approval.** Approval is where a bad
`matched_product_id` overwrites another tenant's cost, so it is tempting to check only
there. But review is where the id is *persisted* — into the line and, worse, into
`vendor_alias`, which then feeds rung 1 of the matching ladder on every later invoice.
Checking only at approval means the poisoned alias is already saved and will be re-offered
as a high-confidence match the reviewer is being trained to accept. The id is validated at
the boundary it enters through.

**D. Approve → Cost Flow (Phase D)** — [AR-4] [AR-5]

The earlier draft looped product updates and history inserts and *then* marked the
invoice approved, with no transaction, lock, conditional transition, or idempotency key.
Three ways that goes wrong: a crash mid-loop leaves some products repriced with the
invoice still `reviewed` and no record of which; a double-click applies every cost twice;
a retry re-derives from an already-approved invoice. Half-applied cost data is worse than
none, because valuation still returns a confident number.

```
Client: approveInvoiceAction(invoiceId)  // requireRole("owner") — cost write, invariant 8
  → getInvoice(actor, invoiceId)         // ownership-checked; cross-tenant ⇒ NotFoundError
  → db.transaction(async (tx) => {

      // 1. Compare-and-set FIRST, so the state transition is the concurrency gate.
      //    Zero rows updated ⇒ someone already approved it ⇒ not an error.
      const [res] = await tx.update(invoice)
        .set({ status: 'approved', approvedAt: now(), approvedBy: actor.userId })
        .where(and(
          eq(invoice.id, invoiceId),
          eq(invoice.organizationId, actor.organizationId),
          eq(invoice.status, 'reviewed'),        // ← CAS: only reviewed → approved
        ))
      if (res.affectedRows === 0) return ALREADY_APPROVED   // idempotent success

      // 2. Only now write costs — inside the same transaction.
      FOR each line WHERE line_type = 'product' AND matched_product_id IS NOT NULL:
           unitCost = deriveUnitCost(line)   // deposits excluded — invariant
           if (unitCost === null) continue

           // previous_unit_cost is READ INSIDE THE TRANSACTION, immediately before the
           // write, from the row being updated. [AR-5]
           prev = SELECT current_unit_cost FROM product
                    WHERE id = line.matched_product_id
                      AND organization_id = actor.organizationId
                    FOR UPDATE            -- ← serialises two invoices touching one product

           INSERT INTO product_cost_history (
             organization_id, product_id, source_invoice_id, source_invoice_line_id,
             unit_cost, previous_unit_cost = prev, effective_at, created_by)
           -- UNIQUE(source_invoice_line_id) ⇒ a replay rolls the whole tx back
           UPDATE product SET current_unit_cost = unitCost
             WHERE id = line.matched_product_id
               AND organization_id = actor.organizationId   -- ← tenant-scoped write
    })
  → retention_until already set at upload
  → return approved invoice
```

Four things this fixes, in order of how quietly they would have failed:
- **`current_unit_cost`, not `unit_cost`** — the column the earlier draft named does not
  exist, and neither does `unit_cost_updated_at`. The update time now lives in
  `product_cost_history.effective_at`, where it belongs.
- **One transaction** — costs and the status transition commit together or not at all.
- **CAS before the loop** — the conditional status update *is* the lock. Two concurrent
  approvals: one updates a row, the other updates zero and returns the original success.
- **`UNIQUE(source_invoice_line_id)`** — a retry that somehow passes the CAS still cannot
  duplicate history; the insert fails and the transaction rolls back.
- **`previous_unit_cost` is read in the transaction, `FOR UPDATE`** — the earlier version
  listed the column in the `INSERT` and never said where the value came from. Read outside
  the transaction it is stale, and two invoices approved close together that touch the same
  product both record the *same* "previous" cost. The history then shows two jumps from one
  starting price instead of a chain, and the price-jump badge — the whole reason the column
  exists — computes against the wrong baseline. `FOR UPDATE` serialises them so the second
  approval sees what the first actually wrote.

**E. Audit Packet (Phase E — on-demand)**
```
Client: createAuditPacketAction(dateFrom, dateTo)  // requireRole("owner")
  → create audit_packet (building)
  → enqueue buildAuditPacketJob(packetId) → return {packetId}

Job: buildAuditPacketJob(packetId)                             // [AR-3]
  → packet = SELECT * FROM audit_packet
               WHERE id = packetId                              -- the job carries the id,
               -- organization_id is READ FROM THE PACKET ROW, never passed in
  → orgId = packet.organization_id       // ← the tenant predicate for everything below
  → query invoices WHERE organization_id = orgId
                     AND invoice_date BETWEEN packet.date_from AND packet.date_to
  → query counts   WHERE organization_id = orgId
                     AND started_at    BETWEEN packet.date_from AND packet.date_to
  → for each invoice file: resolve path, assert file.organization_id = orgId, stream to ZIP
  → compute SHA-256 per file → audit_packet_file rows (organization_id = orgId)
  → ASSERT: every audit_packet_file row has exactly one distinct organization_id
  → upload ZIP → file_path, file_sha256
  → update audit_packet: status=ready, expires_at=now()+10min, manifest_json
  → email signed download link to packet's owner (SES/SendGrid)

Client: getAuditPacketAction(packetId)  // ownership-checked (packet_id, organization_id)
  → signed URL (TTL 10 min)
```

**[AR-3] The earlier draft selected invoices by date range alone.** Tenants share a
calendar, so the first owner to request a packet would have received a ZIP of *every
organization's* invoices for that range — emailed to them, as a durable file, with the
feature appearing to work perfectly. The same slice promised counts in the ZIP and
defined no tenant-scoped count query at all. The organization predicate is now read from
the packet row itself and carried through every invoice, count, product, and file query,
with a single-distinct-org assertion on the manifest as the backstop.

---

## External — third-party, env var names, webhooks

| Dependency | Purpose | Env var names (never values) |
|------------|---------|------------------------------|
| `@firecrawl/pdf-inspector` | PDF classify + text extraction (native binary) | — (npm dep) |
| Anthropic Claude API | Vision OCR for scanned pages | `ANTHROPIC_API_KEY` |
| **Primary: Local filesystem** | Invoice PDFs stored on Hostinger disk **outside the web root**, served only through an authenticated route handler **[AR-1]** | `INVOICE_STORAGE_DIR` — defaults to `./var/invoices/`, a sibling of `public/`, never inside it |
| **Backup: Cloudflare R2** | Offsite copy / audit-packet ZIP if local unavailable; free tier 10GB storage + 1GB egress/month | `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`; `R2_UPLOAD_BUCKET_INVOICES` (optional prefix) |
| Email provider (SES / SendGrid) | Audit packet download link email | `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` |
| Inbound email webhook | Email-forward intake (`invoices@truestock.app`) | `INBOUND_EMAIL_WEBHOOK_SECRET` (verify signature) |

**No other externals.** Distributor portal automation explicitly out of scope (research Part 5). QuickBooks/Xero sync out of scope (Gate 1 "Not in this bundle").

### [AR-1] Standing rule: no invoice byte is ever served from `public/`

The earlier draft made `public/invoices/` the primary store. Next.js serves that tree as
static content *ahead of the application* — no `requireSession`, no role check, no
organization predicate. Anyone who obtained or guessed a path could retrieve a supplier
invoice containing negotiated pricing and business volumes, unauthenticated. That is
simultaneously a cross-tenant breach (invariant 9) and a cost-visibility breach
(invariant 8), reachable from a browser with no account.

The rule, and it admits no exceptions:

1. Invoice originals, page renders, and audit ZIPs live under `INVOICE_STORAGE_DIR`,
   **outside the Next.js web root**. Deployment must not symlink it into `public/`.
2. The only read path is `GET /api/invoices/[id]/file`, which: `requireSession` →
   `requireRole("owner")` (cost data, invariant 8) → ownership-check
   `(organization_id, invoice_id)`, returning `NotFoundError` on a cross-tenant miss →
   resolve the stored path → **verify the resolved absolute path is still inside
   `INVOICE_STORAGE_DIR`** (path-traversal guard; the stored path is never concatenated
   raw) → stream with `Content-Disposition: attachment`.
3. Audit-packet ZIPs use the same handler shape, keyed on `(organization_id, packet_id)`,
   with the 10-minute expiry checked server-side at request time — not merely encoded in
   a URL.
4. A test asserts a direct static fetch of a stored invoice path returns 404, so a future
   change of storage directory cannot silently re-expose the tree.

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
- **Role perms — CORRECTED [AR-7]: owner=full (incl. all review and cost), manager=upload
  + non-monetary metadata only, staff=none.** The earlier decision read "manager =
  upload+review (no cost)", which this document's own review screen makes impossible:
  that screen shows per-line gross, discount and net, invoice totals, and **price-jump
  exception badges**. All of it is supplier cost data, and a price-jump badge leaks the
  direction and rough magnitude of a cost change even with the number blanked.
  `lib/authz.ts:140` already defines `canSeeCost()` as `role === "owner"`, so the old
  contract was not merely risky — it could not be implemented as written without
  violating invariant 8.
  The corrected split: **invoice review and approval are owner-only.** Managers keep
  upload (they can photograph a delivery as it lands, which is the operationally useful
  half) and may list invoices with **vendor, date, invoice number, status, line
  descriptions and quantities** — and nothing monetary. That redaction is enforced by a
  *separate server query that never selects a monetary column*, not by hiding fields in
  the component, so a later UI change cannot leak what the query never fetched.
- **Email-forward: single domain `invoices@truestock.app`, org resolved by sender domain → vendor match** (Gate 2 decision)

---

## Open questions for Gate 3 (implementation details, not architecture)

1. Exact Zod schema shapes for `reviewInvoiceSchema.lines` — nested vs flat array, whether `raw_pack_size` is required or optional for each `line_type`.
2. `deriveUnitCost` formula when `pack_size` is null — fall back to `raw_net / raw_qty`, or error? This affects 5 of the 9 bottled-beer products in the catalog.
3. `matchLinesToProducts` confidence threshold — what minimum confidence promotes a line from "unmatched" to "matched_product_id" set? This drives the review UI badge behavior.
4. **Offsite sync: local-first, Cloudflare R2 as backup** — primary storage is the local `INVOICE_STORAGE_DIR` (default `./var/invoices/`) on Hostinger, **outside the web root** (free, zero egress) **[AR-1]**. Cloudflare R2 (free tier: 10GB storage + 1GB egress/month) is the offsite backup copy, used for audit-packet ZIP resilience and as a secondary offsite archive. `R2_*` env vars are only set if the R2 backup path is configured; otherwise the pipeline reads/writes exclusively local. **If R2 is used, its bucket must be private** — a public bucket recreates the finding this correction closes, one layer further away where it is harder to notice.
5. `retention_until` computation: exact 3 years or calendar-year boundary? `invoice_date + 3 years` vs `Date.utcFullYear(invoice_date.getFullYear() + 3, ...)` — matters for audit-packet date ranges.
6. Cron interval: 2 min vs 1 min vs 5 min — extraction is ~83 ms/pdf × pages; 2 min gives ~40s headroom for 10-page batch on Hostinger's 5–10 connection pool. Tighter interval risks rate-limited pdf-inspector calls.
7. Signed URL TTL: 10 min vs 5 min vs 15 min — 10 min was the Gate 2 decision; shorter increases refresh frequency, longer widens the window if the email lands in spam.

These are the calls most worth challenging during Gate 3 review — changing any of them after implementation requires a schema migration + data recount.
