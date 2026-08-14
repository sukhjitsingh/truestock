# Gate 4 — Vertical Slices: Phase 2.5 OCR invoice automation

Read `03-program-design.md` before reading this. This gate decomposes the research phases A–E (covered in Gate 1) into vertical tracer bullets, each ending in a working, testable state. **Slice 1 is the tracer bullet** — it does almost nothing the user would notice, but it runs end to end and the user can see it.

The phase order (from research §3.8, PRD Gate 1 covers A–E; F = auto‑approve stays deferred past ~100 invoices of correction data).

---

## Slice 1 — tracer bullet: Upload + Archive (Phase A)

**Goal:** User can upload a file (photo/PDF/email-forward metadata) → it lands in the archive list, viewable on the office page. **No AI.** Pure ingestion. This is the "hello world" that proves the full stack (form → server action → DB → list page) works before any OCR logic is added.

**What's stubbed / mocked:**
- `uploadInvoiceAction` accepts any file, creates `invoice` (status=`uploaded`) + `extraction_job` (status=`pending`), returns signed PUT URL.
- Object storage: a minimal mock PUT endpoint (or local `public/invoices/` temp directory) accepts the upload; on success, `extraction_job.status` → `ready_for_classify`.
- Archive list page queries `invoice` rows where `status != 'approved'` and renders: invoice number, date, vendor, **retention_until**, and a "view" link.
- No `invoice_line` rows are written yet.

**What the user can see:**
- In the office, a new row appears in the "Invoices" table after uploading any file.
- Clicking "view" shows the invoice metadata (date, vendor, total) stored in the DB.
- The file itself is not yet processed — it sits in the mock upload directory.

**Acceptance criteria (tracer bullet):**
- `POST /api/invoices/upload` (server action) returns `{invoiceId, uploadUrl}`.
- `PUT` to `uploadUrl` (mock) → `invoice.status = uploaded`, `extraction_job.status = ready_for_classify`.
- `GET /(office)/office/invoices/page` → list shows the just‑uploaded invoice.
- `git diff` against pre‑slice baseline adds < 5 new files (no OCR logic yet).

---

## Slice 2 — Extraction + Review (Phase B)

**Goal:** The cron-driven extraction pipeline runs, classifies each pending `extraction_job`, extracts lines via the chosen path (pdf-inspector for text‑based PDFs, Claude Vision for scanned/mixed), writes `invoice_line` drafts, and the review queue renders those lines with exception badges. **This is the core OCR‑plus‑human-in-the‑loop slice.**

**What's new:**
- `cron: processExtractionQueue()` (every 2 min) claims the next pending job, runs `classifyPdf` → `pdfType`; if `TextBased` → `processPdf` → markdown + tables; if `Scanned`/`Mixed` → calls Anthropic Claude Vision API → structured JSON → `parseLinesFromVision`.
- `arithmeticCheck(lines, invoice.total_gross)` → pass/fail + mismatch amount; if fail, exception flags set.
- `pdfInspectorCrossCheck(lines, markdown)` → dropped‑line flags.
- `invoice_line` drafts written to DB (confidence, `exception_flags` json).
- `invoice.status` → `needs_review`.
- `app/actions/invoices.ts:reviewInvoiceAction()` renders the review-invoice screen with the extracted lines, per-line gross/discount/net editable, and exception badges across the top (**price jump**, **duplicate**, **doesn't add up**, **unmatched item**).

**What the user can see:**
- After the 2‑min cron fires, the review queue populates with invoices that have `status = needs_review`.
- Clicking an invoice shows the line table with auto‑extracted quantities, descriptions, and gross/discount/net.
- Exception badges appear where the arithmetic check failed or the cross‑check flagged a drop.
- The user can edit a line, click **Approve** (status → `reviewed`) or **Return** (status → `uploaded` for re‑extract).

**Acceptance criteria:**
- Cron processes one job: `extraction_job` → `done`; `invoice_line` drafts exist; `invoice.status = needs_review`.
- Review-invoice screen renders with extracted lines + badges.
- `reviewInvoiceAction` with corrected lines → arithmetic passes → `invoice.status = reviewed`.

---

## Slice 3 — Matching (Phase C)

**Goal:** The "fix once" memory — vendor‑alias upsert — persists across invoices. When a line's `vendor_item_code` is extracted and no alias exists, it is created; next time the same vendor appears, the line is already matched to the product. This slice makes the review experience better on subsequent invoices.

**What's new:**
- `lib/domain/matching.ts:findAlias(orgId, vendorId, vendorItemCode)` → returns existing alias or `null`.
- `lib/domain/matching.ts:upsertAlias(orgId, vendorId, vendorItemCode, productId)` → creates or updates; unique on `(organization_id, vendor_id, vendor_item_code)`.
- `lib/domain/matching.ts:matchLinesToProducts(lines, orgId)` → for each line with a matched `vendor_item_code`, sets `line.matched_product_id` and `line.matched_vendor_alias_id`.
- If no alias exists, the line stays "unmatched" and the user sees an **unmatched item** badge in the review UI.

**What the user can see:**
- In the review-invoice screen, a line extracted from an invoice from Vendor X shows an **unmatched item** badge the first time.
- The user can click "map to product" → selects the catalog product → the alias is created.
- The next invoice from Vendor X arrives in the review queue; the same line now shows the **unmatched item** badge is gone, and the product is pre‑selected.
- The line table remembers the mapping; `confidence` on the alias row reflects how many times it's been confirmed.

**Acceptance criteria:**
- First invoice from a new vendor: line gets **unmatched item** badge; user can map to product → alias created.
- Second invoice from same vendor: same line is pre‑matched; no badge; product pre‑selected in the UI.
- `upsertAlias` is idempotent — calling it with the same `(vendor_id, vendor_item_code)` twice produces the same row.

---

## Slice 4 — Cost Flow + Alerts (Phase D)

**Goal:** When the owner approves an invoice, unit costs are derived and written to the product catalog — finally powering the valuation and reorder list that was the whole point of the feature. Also: any anomaly alerts (price jump, discount > 50%) surface in the review UI.

**What's new:**
- `app/actions/invoices.ts:approveInvoiceAction()` (requireRole("owner")):
  - FOR each `line WHERE line_type = product AND matched_product_id`:
    - `lib/domain/cost-derivation.ts:deriveUnitCost(line)` → `raw_net / qty / pack_size` (deposits always return `null` per invariant).
    - `db/schema.ts:UPDATE product.unit_cost, product.unit_cost_updated_at = now()`.
    - `db/schema.ts:INSERT INTO cost_history (product_id, unit_cost, source_invoice_id, effective_at)` — append‑only, never overwrites.
  - `invoice.status = approved, approved_at = now(), approved_by = actor.userId`.
  - `retention_until` already set at upload; no-op if already set.
- Alert logic in the review UI: if a line's `raw_discount / raw_gross > 0.5`, badge **"discount > 50%"** appears; if `raw_net < 0`, badge **"negative net"** appears (should not happen, but the check exists).

**What the user can see:**
- After approving an invoice, the product catalog (back‑office list) now shows `unit_cost` for the first time — a real number, not typed by hand.
- The valuation & reorder list (Phase 3) now reads from `product.unit_cost` instead of showing `null`.
- In the review screen for a future invoice, if a line has a discount > 50%, a **discount > 50%** badge appears; the user can review and override if needed.

**Acceptance criteria:**
- Owner approves an invoice with at least one `line_type = product` + `matched_product_id`.
- `product.unit_cost` is updated to a non‑null value derived from that invoice.
- `cost_history` has one new append‑only row (check DB directly).
- If a line has `raw_discount / raw_gross > 0.5`, the review badge **"discount > 50%"** appears.

---

## Slice 5 — Audit Packet (Phase E)

**Goal:** Owner can request a date‑range export → a background job builds a ZIP of invoices + counts + a SHA‑256 manifest → an email with a signed download link (TTL 10 min) is sent. This satisfies the two‑year retention / state‑audit obligation.

**What's new:**
- `app/actions/invoices.ts:createAuditPacketAction(dateFrom, dateTo)` (requireRole("owner")) → creates `audit_packet` (status=`building`), enqueues `buildAuditPacketJob(packetId)`, returns `{packetId}`.
- Background job `buildAuditPacketJob(packetId)`:
  - Queries `invoice` rows where `invoice_date >= dateFrom AND invoice_date <= dateTo`.
  - Streams matching invoices to a ZIP file (using a minimal `adm-zip` or equivalent).
  - For each file: computes `SHA-256` → `audit_packet_file` rows (source_table, source_id, file_path, sha256).
  - Uploads ZIP to object storage → `audit_packet.file_path`, `audit_packet.file_sha256`.
  - Updates `audit_packet`: `status = ready`, `expires_at = now() + 10min`, `manifest_json` = `{file_count, total_sha256}`.
  - SES/SendGrid: sends email to `owner.email` with a signed download link (TTL 10 min).
- `app/actions/invoices.ts:getAuditPacketAction(packetId)`:
  - If `status = ready` → returns `{downloadUrl, expiresAt}`.
  - If `status = building` → returns `{status: "processing"}`.
  - If `status = expired` / `failed` → returns `{status: "unavailable"}`.

**What the user can see:**
- In the office, a new "Create audit packet" form: pick a start date & end date → submit.
- After submission, a status badge appears: **processing** → then **ready**.
- Clicking "ready" triggers an email to the owner's inbox (simulated in dev; real on Hostinger).
- The email contains a link that expires in 10 minutes; clicking it downloads a ZIP named `truestock-audit-YYYYMMDD-YYYYMMDD.zip`.
- The ZIP contains one `.json` manifest and one `.csv` (or `.jsonl`) per invoice with the stored metadata.

**Acceptance criteria:**
- `createAuditPacketAction` with valid dates → `audit_packet` row created (status=`building`), `packetId` returned.
- `buildAuditPacketJob` completes → `audit_packet` updated to `ready`, `expires_at` set, manifest uploaded.
- Email sent with signed URL (TTL 10 min) — in dev, the email lands in a test inbox; on Hostinger, it goes to the owner.
- `getAuditPacketAction(packetId)` with `status = ready` → returns `{downloadUrl, expiresAt}` that downloads the correct ZIP.
- ZIP manifest contains per‑file SHA‑256 hashes; ZIP file count matches `invoice` rows in the date range.

---

## Slice 6 — (not built; auto‑approve deferred)

**Phase F** (auto‑approve) is deliberately never enabled before ~100 invoices of correction data calibrate the confidence threshold (research §3.4, Gate 1). This slice does not exist in the build — the feature ships with human review on every document, and the 30‑minute metric is measured with that design constraint.

**What's in the slice directory:** nothing — the `00-status.md` checklist notes: "auto‑approve off for the first ~100 invoices by design."

---

## Slice build order & "banned" patterns

| Slice | Phase | Ends with |
|-------|-------|-----------|
| 1 | A (Archive) | User uploads a file → it appears in the archive list |
| 2 | B (Extraction + Review) | Review queue shows extracted lines + exception badges; user can approve/return |
| 3 | C (Matching) | Alias persists across invoices; next invoice from same vendor already matched |
| 4 | D (Cost Flow + Alerts) | Product catalog shows `unit_cost`; valuation & reorder list work |
| 5 | E (Audit Packet) | Owner requests export → email with signed ZIP link arrives; download works |

**Banned:** Horizontal building — do not implement all database tables, then all API endpoints, then all UI pages, then start testing. Each slice must be **vertically** thin but end-to-end: a user can see a tangible result after each one.

**After every slice:** prove it works (run the server action, curl the endpoint, or browser-test the page), check it off in `00-status.md`, then ask "Continue to slice N+1, or re‑steer?"

---

## Slice 1 readiness check (tracer bullet)

Before moving off Slice 1, verify these **four** things:

1. `POST api/invoices/upload` (server action) returns `{invoiceId, uploadUrl}` with HTTP 200.
2. `PUT` to the returned `uploadUrl` (using the mock endpoint) lands the file; DB query shows `invoice.status = uploaded` AND `extraction_job.status = ready_for_classify`.
3. `GET /(office)/office/invoices` lists the just‑uploaded invoice in the table (visible in the office UI).
4. No new DB tables or OCR logic are required — this slice only touches `invoice`, `extraction_job`, the upload form, and the archive list page.

If all four pass, the tracer bullet is successful and Slice 2 can begin.
