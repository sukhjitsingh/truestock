# Gate 4 — Vertical Slices: Phase 2.5 OCR invoice automation

Read `03-program-design.md` before reading this. This gate decomposes the research phases A–E (covered in Gate 1) into vertical tracer bullets, each ending in a working, testable state. **Slice 1 is the tracer bullet** — it does almost nothing the user would notice, but it runs end to end and the user can see it.

> **Corrected 2026-08-14 after adversarial review.** See
> `docs/reviews/2026-08-14-phase-2.5-adversarial-review.md`. Corrections marked **[AR-n]**.
> Gate 2–4 approval is withdrawn until the corrected contract is re-approved.
>
> **Rule added as a result of this review:** each slice's acceptance criteria now include
> its adversarial test. A slice is not done when the happy path works — it is done when
> the way it fails silently has a failing-first test proving it does not.

The phase order (from research §3.8, PRD Gate 1 covers A–E; F = auto‑approve stays deferred past ~100 invoices of correction data).

---

## Slice 1 — tracer bullet: Upload + Archive (Phase A)

**Goal:** User can upload a file (photo/PDF/email-forward metadata) → it lands in the archive list, viewable on the office page. **No AI.** Pure ingestion. This is the "hello world" that proves the full stack (form → server action → DB → list page) works before any OCR logic is added.

**What's stubbed / mocked:**
- `uploadInvoiceAction` accepts any file plus a declared byte length and SHA-256, creates `invoice` (status=`uploaded`) + `extraction_job` (status=**`awaiting_upload`** — *not* claimable) **[AR-6]**, returns a PUT URL.
- Storage: the upload lands under **`INVOICE_STORAGE_DIR` (default `./var/invoices/`), outside the Next.js web root** — never `public/` **[AR-1]**.
- `confirmUploadAction` verifies the object exists and its size + SHA-256 match what was declared; only then does `extraction_job.status` → **`queued`** **[AR-6]**.
- Archive list page queries `invoice` rows **scoped to `actor.organizationId`** where `status != 'approved'` and renders: invoice number, date, vendor, **retention_until**, and a "view" link.
- `GET /api/invoices/[id]/file` exists from this slice on — it is the *only* way to retrieve a document, and it ships with the ownership check and traversal guard from day one, not bolted on later **[AR-1]**.
- No `invoice_line` rows are written yet.

**What the user can see:**
- In the office, a new row appears in the "Invoices" table after uploading any file.
- Clicking "view" shows the invoice metadata (date, vendor, total) stored in the DB.
- The file itself is not yet processed — it sits in the storage directory.

**Acceptance criteria (tracer bullet):**
- `POST /api/invoices/upload` (server action) returns `{invoiceId, uploadUrl}`.
- `PUT` to `uploadUrl` → file lands under `INVOICE_STORAGE_DIR`; `invoice.status = uploaded`, `extraction_job.status = awaiting_upload`.
- `confirmUploadAction` with a matching size + hash → `extraction_job.status = queued`. With a mismatched hash → stays `awaiting_upload`.
- `GET /(office)/office/invoices/page` → list shows the just‑uploaded invoice.
- **Adversarial (must fail first):**
  - `invoice_file_not_statically_served` — fetching the stored path directly returns 404.
  - `invoice_file_requires_owner` — manager/staff get 403, anonymous gets 401.
  - `invoice_file_rejects_path_traversal` — a `../` path is refused, not served.
  - `job_not_claimable_before_upload` — a job in `awaiting_upload` is never claimed.
  - `job_status_enum_is_closed` — writing `ready_for_classify` is rejected.
- **Two-tenant fixture is seeded in this slice**, not later. Every subsequent slice's isolation test depends on it, and retrofitting it after four slices of single-tenant tests means re-verifying all of them.
- `git diff` against pre‑slice baseline adds < 8 new files (was < 5; the authenticated file route and the two-tenant fixture are the addition, and both are load-bearing).

---

## Slice 2 — Extraction + Review (Phase B)

**Goal:** The cron-driven extraction pipeline runs, classifies each `queued` `extraction_job`, extracts lines via the chosen path (pdf-inspector for text‑based PDFs, Claude Vision for scanned/mixed), writes `invoice_line` drafts, and the review queue renders those lines with exception badges. **This is the core OCR‑plus‑human-in-the‑loop slice.**

**What's new:**
- `cron: processExtractionQueue()` (every 2 min) **atomically claims** the next **`queued`** job — a conditional `UPDATE ... WHERE status='queued' LIMIT 1`, where zero rows affected means another worker won **[AR-6]**. Extraction routinely exceeds the 2-minute interval, so overlapping ticks are the normal case and a non-atomic claim would double-process. Then runs `classifyPdf` → `pdfType`; if `TextBased` → `processPdf` → markdown + tables; if `Scanned`/`Mixed` → calls Anthropic Claude Vision API → structured JSON → `parseLinesFromVision`.
- `arithmeticCheck(lines, invoice.total_gross)` → pass/fail + mismatch amount; if fail, exception flags set.
- `pdfInspectorCrossCheck(lines, markdown)` → dropped‑line flags.
- `invoice_line` drafts written to DB (confidence, `exception_flags` json).
- `invoice.status` → `needs_review`.
- `app/actions/invoices.ts:reviewInvoiceAction()` renders the review-invoice screen with the extracted lines, per-line gross/discount/net editable, and exception badges across the top (**price jump**, **duplicate**, **doesn't add up**, **unmatched item**).
- **[AR-7] This screen is owner-only.** Per-line gross/discount/net, invoice totals, and the **price jump** badge are all supplier cost data, and `lib/authz.ts:140` already defines `canSeeCost()` as `role === "owner"`. The earlier plan gave managers "review (no cost)", which this screen makes impossible to satisfy — a price-jump badge leaks the direction and rough size of a cost change even with the numbers blanked. Managers keep **upload** plus a **redacted list** (vendor, date, invoice number, status, line descriptions and quantities) served by a *separate query that never selects a monetary column*, so redaction cannot be undone by a later UI change.
- **[AR-2]** `reviewInvoiceAction` ownership-checks **every** `matched_product_id` in the submitted payload — as one set query, before writing anything. A foreign key proves a row exists, not whose it is.
- `rejectInvoiceAction` (owner) — CAS `needs_review` | `reviewed` → `rejected`, reason required. **Refused from `approved`** **[AR-4]**.
- `resendToExtractionAction` (owner) — opens a **new** `extraction_job` (`awaiting_upload` is skipped; the file is already confirmed, so it starts `queued`) and leaves the previous job's `error_message` and `retry_count` intact for diagnosis **[AR-6]**.

> Both actions appeared in the Gate 2 endpoint table and the Gate 3 action list but were
> in **no slice**, so nothing built them and nothing tested them. They are here because
> this is the slice that owns the review screen's Return button.

**What the user can see:**
- After the 2‑min cron fires, the review queue populates with invoices that have `status = needs_review`.
- Clicking an invoice shows the line table with auto‑extracted quantities, descriptions, and gross/discount/net.
- Exception badges appear where the arithmetic check failed or the cross‑check flagged a drop.
- The user can edit a line, click **Approve** (CAS `needs_review` → `reviewed`) or **Return** (CAS `needs_review` → `rejected` with a reason, which is the re-extract entry point).

> **[AR-4] This bullet previously read "Return (status → `uploaded` for re-extract)".**
> `needs_review → uploaded` is not an edge in the invoice state machine — there is no path
> back to `uploaded` at all, because `uploaded` means "no file confirmed yet". This is the
> exact defect `ready_for_classify` was: a slice writing a status value the declared
> machine does not contain. It survived the first correction because AR-6 only made us
> write down the *job* lifecycle, and this is the *invoice* one. Re-extract is
> `rejected → processing` via a new `extraction_job`.

**Acceptance criteria:**
- Cron processes one job: `extraction_job` → `done`; `invoice_line` drafts exist; `invoice.status = needs_review`.
- Review-invoice screen renders with extracted lines + badges.
- `reviewInvoiceAction` with corrected lines → arithmetic passes → `invoice.status = reviewed`.
- `cron: reapStuckJobs()` (every 5 min) returns timed-out `running` jobs to `queued` and fails them at 3 attempts **[AR-6]**.
- **Adversarial (must fail first):**
  - `job_claim_is_atomic` — two workers claiming concurrently: exactly one gets the job **[AR-6]**.
  - `stuck_running_job_is_reaped` — kill a worker mid-extraction; the job returns to `queued` and completes on the next sweep instead of stranding the invoice in "processing" forever **[AR-6]**.
  - `reaped_job_fails_after_three_tries` — a reliably-fatal PDF lands in `failed`, rather than re-entering the queue on every sweep **[AR-6]**.
  - `job_transition_is_guarded` — `updateStatus(id, 'done', 'queued')` throws; the pipeline's own helper cannot bypass the lifecycle **[AR-6]**.
  - `review_conflicts_when_status_moved` — the review CAS affects zero rows when the invoice moved on, and returns a conflict rather than overwriting **[AR-4]**.
  - `manager_cannot_open_review_screen` — `getInvoiceAction` returns 403 for manager **[AR-7]**.
  - `extraction_status_hides_error_message` — the manager-visible status poll never returns `error_message`, which can quote invoice text **[AR-7]**.
  - `manager_invoice_payload_has_no_money` — asserted over the **serialized** manager payload, so adding a monetary column to the query fails the test rather than silently shipping **[AR-7]**.
  - `get_invoice_cross_tenant_is_not_found` — org A requesting org B's invoice gets `NotFoundError`, never a response confirming the row exists **[AR-2]**.

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
- `app/actions/invoices.ts:approveInvoiceAction()` (requireRole("owner")), **entirely inside one `db.transaction`** **[AR-4]**:
  - **First**, compare-and-set `invoice.status` `reviewed` → `approved` (also stamping `approved_at`, `approved_by`), scoped to `actor.organizationId`. **Zero rows affected means it was already approved — return the original success, not an error.** This CAS is the concurrency gate; everything below only runs if it won.
  - Then FOR each `line WHERE line_type = product AND matched_product_id`:
    - `lib/domain/cost-derivation.ts:deriveUnitCost(line)` → `raw_net / qty / pack_size` (deposits always return `null` per invariant; `null` ⇒ skip).
    - Read `previous_unit_cost` **inside the transaction**, `SELECT current_unit_cost ... FOR UPDATE` on the product row being written **[AR-5]**. Read outside it, two invoices approved close together for the same product both record the same "previous" cost, and the price-jump badge — the only reason the column exists — compares against the wrong baseline.
    - `INSERT INTO product_cost_history (organization_id, product_id, source_invoice_id, source_invoice_line_id, unit_cost, previous_unit_cost, effective_at, created_by)` — append‑only, **`UNIQUE(source_invoice_line_id)`** so a replay rolls the transaction back rather than doubling history **[AR-4]**.
    - `UPDATE product SET current_unit_cost = :unitCost WHERE id = :matchedProductId AND organization_id = actor.organizationId` — note the **real column name** and the tenant-scoped write **[AR-5] [AR-2]**.
  - `retention_until` already set at upload; no-op if already set.
- Alert logic in the review UI: if a line's `raw_discount / raw_gross > 0.5`, badge **"discount > 50%"** appears; if `raw_net < 0`, badge **"negative net"** appears (should not happen, but the check exists).

**What the user can see:**
- After approving an invoice, the product catalog (back‑office list) now shows **`current_unit_cost`** for the first time — a real number, not typed by hand.
- The valuation & reorder list (Phase 3) now reads from **`product.current_unit_cost`** instead of showing `null`. *(Both bullets said `unit_cost` until 2026-08-14 — the column AR-5 established does not exist. The acceptance criteria below already used the real name, so this slice contradicted itself.)*
- In the review screen for a future invoice, if a line has a discount > 50%, a **discount > 50%** badge appears; the user can review and override if needed.

**Acceptance criteria:**
- Owner approves an invoice with at least one `line_type = product` + `matched_product_id`.
- **`product.current_unit_cost`** is updated to a non‑null value derived from that invoice **[AR-5]**.
- `product_cost_history` has one new append‑only row (check DB directly).
- If a line has `raw_discount / raw_gross > 0.5`, the review badge **"discount > 50%"** appears.
- **Adversarial (must fail first):**
  - `review_rejects_cross_tenant_product` — org A submitting org B's `matched_product_id` gets `NotFoundError`, and **org B's cost is unchanged** **[AR-2]**.
  - `invoice_line_fk_refuses_cross_tenant` — with the app-layer check removed, the database still refuses (1452) **[AR-2]**.
  - `approve_is_idempotent_on_replay` — approving twice writes one history row per line **[AR-4]**.
  - `approve_concurrent_applies_once` — two simultaneous approvals apply costs once **[AR-4]**.
  - `approve_rolls_back_on_midway_failure` — a failure on line 3 of 5 leaves zero cost rows and the invoice still `reviewed` **[AR-4]**.
  - `schema_matches_live_columns` — migration applies clean from empty; `vendor` is not recreated **[AR-5]**.
  - `approved_invoice_cannot_be_rejected` — `approved` is terminal; rejecting it is refused. Otherwise the cost rows stay (append-only) while the invoice reads `rejected` **[AR-4]**.
  - `previous_unit_cost_chains` — two approvals for one product record A→B then B→C, not two jumps from the same baseline **[AR-5]**.
  - `no_reference_to_unit_cost_column` — a grep-style assertion that no query names `product.unit_cost` or `unit_cost_updated_at`, the two columns AR-5 found referenced but nonexistent **[AR-5]**.

---

## Slice 5 — Audit Packet (Phase E)

**Goal:** Owner can request a date‑range export → a background job builds a ZIP of invoices + counts + a SHA‑256 manifest → an email with a signed download link (TTL 10 min) is sent. This satisfies the two‑year retention / state‑audit obligation.

**What's new:**
- `app/actions/invoices.ts:createAuditPacketAction(dateFrom, dateTo)` (requireRole("owner")) → creates `audit_packet` (status=`building`), enqueues `buildAuditPacketJob(packetId)`, returns `{packetId}`.
- Background job `buildAuditPacketJob(packetId)` — **every query below is organization-scoped** **[AR-3]**:
  - Loads the packet row and reads `orgId = packet.organization_id` **from that row**. The job is handed only a `packetId`; it never accepts an organization from a caller.
  - Queries `invoice` rows where **`organization_id = orgId`** `AND invoice_date >= dateFrom AND invoice_date <= dateTo`. *The earlier draft omitted the organization predicate entirely — tenants share a calendar, so this ZIP would have contained every organization's invoices for the range, emailed as a durable file, with nothing appearing broken.*
  - Queries `count` rows on the **same** `organization_id` predicate. The earlier draft promised counts in the ZIP and defined no count query at all.
  - Streams matching invoices to a ZIP file (using a minimal `adm-zip` or equivalent), resolving each file path inside `INVOICE_STORAGE_DIR` and refusing anything outside it **[AR-1]**.
  - For each file: computes `SHA-256` → `audit_packet_file` rows (organization_id, source_table, source_id, file_path, sha256).
  - **Asserts exactly one distinct `organization_id` across every manifest row** before the packet is marked ready — a cheap backstop if a future query loses its predicate.
  - Uploads ZIP to storage → `audit_packet.file_path`, `audit_packet.file_sha256`.
  - Updates `audit_packet`: `status = ready`, `expires_at = now() + 10min`, `manifest_json` = `{file_count, total_sha256}`.
  - SES/SendGrid: sends email to the **packet owner's** address with a download link (TTL 10 min).
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
- ZIP manifest contains per‑file SHA‑256 hashes; ZIP file count matches `invoice` rows in the date range **for that organization**.
- **Adversarial (must fail first):**
  - `audit_packet_excludes_other_tenants` — two orgs with invoices on **overlapping dates**; org A's ZIP contains only org A's invoices and the manifest has exactly one distinct `organization_id` **[AR-3]**.
  - `audit_packet_counts_are_scoped` — counts in the packet obey the same predicate **[AR-3]**.
  - `get_audit_packet_cross_tenant_is_not_found` — org A requesting org B's `packetId` gets `NotFoundError`, not a download URL **[AR-2]**.
  - Download expiry is enforced **server-side at request time** — an expired link returns unavailable even if the URL is intact **[AR-1]**.

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
| 4 | D (Cost Flow + Alerts) | Product catalog shows `current_unit_cost`; valuation & reorder list work |
| 5 | E (Audit Packet) | Owner requests export → email with signed ZIP link arrives; download works |

**Banned:** Horizontal building — do not implement all database tables, then all API endpoints, then all UI pages, then start testing. Each slice must be **vertically** thin but end-to-end: a user can see a tangible result after each one.

**After every slice:** prove it works (run the server action, curl the endpoint, or browser-test the page), check it off in `00-status.md`, then ask "Continue to slice N+1, or re‑steer?"

---

## Slice 1 readiness check (tracer bullet)

Before moving off Slice 1, verify these **four** things:

1. `POST api/invoices/upload` (server action) returns `{invoiceId, uploadUrl}` with HTTP 200.
2. `PUT` to the returned `uploadUrl` lands the file **under `INVOICE_STORAGE_DIR`, outside the web root**; DB query shows `invoice.status = uploaded` AND `extraction_job.status = awaiting_upload`. After `confirmUploadAction` verifies size + SHA-256, the job reads `queued` **[AR-1] [AR-6]**.
3. `GET /(office)/office/invoices` lists the just‑uploaded invoice in the table (visible in the office UI).
4. No new DB tables or OCR logic are required — this slice only touches `invoice`, `extraction_job`, the upload form, and the archive list page.

If all four pass, the tracer bullet is successful and Slice 2 can begin.
