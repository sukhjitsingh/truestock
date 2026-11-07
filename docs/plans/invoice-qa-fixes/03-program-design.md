# Gate 3 — Program Design: trustworthy invoice approval

Covers F1, F6 and F7. Follows `02-architecture.md`, approved 2026-11-06. Signatures
only, no bodies.

## Files

| File | Why it lives there |
|---|---|
| `db/schema.ts` | `vendor_alias.pack_size`, `invoice.live_file_sha256`, its unique index. |
| `drizzle/0010_*.sql` | F1 migration, generated. |
| `drizzle/0011_*.sql` | F7 migration, generated. F6 needs none. |
| `lib/domain/cost-derivation.ts` | `classifyLineForPosting` and the skip reasons. Stays free of server imports, so the browser runs the same rule. `deriveUnitCost` is unchanged. |
| `lib/domain/invoice-approval.ts` | Approval uses the classifier over every line. Report builder and read. |
| `lib/domain/invoice-lines.ts` | `LineCorrection.packSize`. Alias learning moves out of `applyLineReviewTx` into one pass on review submit. |
| `lib/domain/matching.ts` | `aliasKeyForLine`, pack size in the upsert, two-key pre-match. Node-only because of the hash, so the browser never imports it. |
| `lib/domain/invoices.ts` | Duplicate lookup, claim at confirm, release at reject, re-claim at resend. |
| `lib/validation/invoices.ts` | `packSize` on `lineCorrectionSchema`; report input schema. |
| `app/actions/invoices.ts` | New report action; union results on upload, confirm and resend. |
| `lib/invoice-posting-view.ts` (new) | Pure text for the panels: counts and one sentence per reason. Same pattern as `lib/invoice-review-outcome.ts`. |
| `components/office/invoice-review-form.tsx` | Units-per-case input, live panel, final panel, duplicate refusal on Retry and Return. |
| `components/office/invoice-upload-form.tsx` | Duplicate refusal. |

## Types and signatures

```ts
// lib/domain/cost-derivation.ts
export type PostingSkipReason =
  | "not_product_line" | "not_matched" | "no_net" | "free_goods" | "credit"
  | "no_quantity" | "no_units_per_case";

export interface PostingCandidateLine extends DerivableCostLine {
  uom: InvoiceLineUom | null;
  matchedProductId: number | null;
}
export type LinePosting =
  | { posts: true; unitCost: string; packSizeUsed: number }
  | { posts: false; reason: PostingSkipReason };

/** `each` and `keg` give 1. Anything else gives line.packSize, which may be null. */
export function effectivePackSize(line: Pick<PostingCandidateLine, "uom" | "packSize">): number | null;
/** First match wins, in the order of PostingSkipReason above. */
export function classifyLineForPosting(line: PostingCandidateLine): LinePosting;
```

```ts
// lib/domain/invoice-approval.ts
export interface PostingReportLine {
  lineId: number;
  lineNumber: number;
  description: string | null;
  productId: number | null;
  productName: string | null;
  posted: boolean;
  unitCost: string | null;
  /** Null when posted. `not_posted_at_approval`: see least confident #4. */
  reason: PostingSkipReason | "not_posted_at_approval" | null;
}
export interface PostingReport {
  /** True only once approved: `posted` then means rows that exist. */
  final: boolean;
  totalLines: number;
  postedLines: number;
  lines: PostingReportLine[];
}
export interface ApproveInvoiceResult {
  invoice: InvoiceRow;
  costLinesApplied: number; // kept: 0 on a replay, as today
  report: PostingReport;    // true numbers on a replay too
}
export async function getInvoicePostingReport(actor: Actor, invoiceId: number): Promise<PostingReport>;
async function buildPostingReportTx(tx: Tx, actor: Actor, invoiceId: number, status: InvoiceStatus): Promise<PostingReport>;
```

```ts
// lib/domain/invoice-lines.ts
export interface LineCorrection {
  id: number;
  rawGross?: string | null;
  rawDiscount?: string | null;
  rawNet?: string | null;
  matchedProductId?: number | null;
  packSize?: number | null; // new: integer 1-9999, or null to clear
}
/** Every matched product line on the invoice, deduped by key, keys sorted. */
async function learnAliasesTx(tx: Tx, actor: Actor, invoiceId: number): Promise<void>;
```

```ts
// lib/domain/matching.ts
export function normalizeAliasDescription(description: string): string;
/** The item code if present, else `desc:` + base64url SHA-256. Null if neither exists. */
export function aliasKeyForLine(line: { vendorItemCode: string | null; description: string | null }): string | null;

// upsertAliasCore, upsertAliasTx and upsertAlias gain:
//   packSize: number | null
// Same product: non-null replaces, null keeps. Different product: always replaced, so null clears.
// VendorAliasRow gains packSize: number | null.

// matchLinesToProducts keeps its signature. It now also sets packSize from the alias
// when the line's own is null, and vendor_alias_desc for a description key.
```

```ts
// lib/domain/invoices.ts
export interface DuplicateInvoice {
  invoiceId: number;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  status: InvoiceStatus;
  uploadedAt: Date;
}
/** Locking read: see least confident #6. */
async function findLiveCopyTx(tx: Tx, orgId: number, sha256: string): Promise<DuplicateInvoice | null>;
export async function findLiveCopy(orgId: number, sha256: string): Promise<DuplicateInvoice | null>;
async function claimFileTx(tx: Tx, orgId: number, invoiceId: number, sha256: string): Promise<DuplicateInvoice | null>;

export type CreateInvoiceForUploadResult =
  | { outcome: "created"; invoice: InvoiceRow }
  | { outcome: "duplicate"; duplicate: DuplicateInvoice };
export interface ConfirmUploadResult { matched: boolean; invoice: InvoiceRow; duplicate?: DuplicateInvoice }
export type ResendToExtractionResult =
  | { outcome: "resent"; invoice: InvoiceRow; extractionJobId: number }
  | { outcome: "duplicate"; duplicate: DuplicateInvoice };
```

```ts
// app/actions/invoices.ts
export type UploadInvoiceResult =
  | { outcome: "created"; invoiceId: number; uploadUrl: string; status: InvoiceStatus }
  | { outcome: "duplicate"; duplicate: DuplicateInvoice; canOpen: boolean }; // canOpen: role is owner
export async function getInvoicePostingReportAction(input: unknown): Promise<ActionResult<PostingReport>>; // owner only
```

```ts
// lib/invoice-posting-view.ts
export function postingHeadline(posted: number, total: number, final: boolean): string;
export function describeSkipReason(reason: PostingReportLine["reason"], lineNumber: number): string;
```

## Call stack

**Review**

```
InvoiceReviewForm
  classifyLineForPosting(form values)            live panel, per keystroke
  handleApprove → reviewInvoiceAction → submitInvoiceReview
    withLockRetry → transaction
      applyLineReviewTx      writes packSize and matches on the lines
      assertInvoiceHasLinesTx
      updateInvoiceStatusTx  needs_review → reviewed
      learnAliasesTx → upsertAliasTx(key, product, packSize)
```

**Approval**

```
handleApproveCosts → approveInvoiceAction → approveInvoice
  withLockRetry → transaction
    approved already?  → buildPostingReportTx, return
    every line → classifyLineForPosting → posts? → lock product, cost history, update product
    buildPostingReportTx   reads product_cost_history by source_invoice_line_id
Page load → getInvoicePostingReportAction → getInvoicePostingReport → buildPostingReportTx
```

**Next invoice**

```
runClaimedJob → matchLinesToProducts
  aliasKeyForLine per line → one batched select → product, alias id, method, pack size
```

**Upload**

```
handleSubmit: hash in browser → uploadInvoiceAction → createInvoiceForUpload
  findLiveCopyTx → duplicate? return it, nothing created
PUT file → confirmUploadAction → markUploadConfirmed → lockJobForUpload
  bytes verified → claimFileTx → lost the race? return duplicate, job stays awaiting_upload
                 → won → job awaiting_upload → queued
```

**Reject and resend**

```
updateInvoiceStatusTx(to: rejected)   sets live_file_sha256 = null, the single choke point
resendInvoiceToExtraction             claim is null? claimFileTx first, refuse on a duplicate
```

## Test plan

Against real MariaDB unless marked pure. Fixtures are synthetic.

**F1, `tests/invoice-posting.test.ts`**

- `classify_each_posts_without_pack_size` (pure): `each`, no pack size, posts at net / qty.
- `classify_keg_posts_as_one` (pure).
- `classify_each_ignores_parsed_pack_size` (pure): `each` with pack 12 still divides by 1.
- `classify_case_without_pack_is_skipped` (pure): reason `no_units_per_case`.
- `classify_blank_and_other_uom_need_pack` (pure).
- `classify_reason_for_each_skip` (pure): one case per reason, including precedence.
- `approval_posts_each_lines`: the F1 regression, cost history and `current_unit_cost` written.
- `approval_posts_what_it_can`: 5 mixed lines, 3 rows written, 2 reported with reasons.
- `approval_report_counts_rows_written`: posted count equals history rows.
- `replay_returns_same_report`: second approve, same report, no new rows.
- `preview_matches_approval`: report before approval equals report after, line by line.
- `old_approved_invoice_reports_not_posted`: posted-eligible line with no history row.
- `report_refuses_other_tenant`, `report_refuses_manager_and_staff`.
- `review_saves_pack_size_on_line_and_alias`, `review_rejects_zero_pack_size`.
- `alias_move_clears_pack_size`, `alias_same_product_keeps_pack_size_on_null`.
- `prematch_fills_remembered_pack_size`, `prematch_keeps_printed_pack_size`.

**F6, `tests/matching.test.ts` (additions)**

- `alias_key_prefers_item_code`, `alias_key_normalizes_case_and_spacing`,
  `alias_key_keeps_digits_apart` (`750ml` vs `1.75l`), `alias_key_null_when_nothing`,
  `alias_key_fits_column` (pure).
- `review_learns_alias_without_item_code`: the F6 regression.
- `second_invoice_prematches_by_description`: method `vendor_alias_desc`.
- `untouched_prematch_reconfirms_alias`: confidence climbs on submit.
- `alias_scoped_to_vendor`, `alias_scoped_to_org`.
- `no_vendor_invoice_learns_nothing`.
- `deposit_line_never_learns_alias`.
- `two_lines_same_key_one_upsert`.

**F7, `tests/invoice-duplicate-upload.test.ts`**

- `second_upload_refused_names_original`: nothing created.
- `refused_across_orgs_is_not`: same bytes, other organization, allowed.
- `reply_shows_no_other_tenant_detail`.
- `rejected_copy_allows_reupload`.
- `abandoned_upload_blocks_nothing`: no confirm, so no claim.
- `simultaneous_confirms_one_wins`: real race, one claim, loser gets the duplicate.
- `resend_refused_when_live_copy_appeared`: reject, re-upload, resend.
- `resend_from_needs_review_keeps_claim`.
- `reject_releases_claim_on_every_source_status`.
- `manager_gets_canOpen_false`, `owner_gets_canOpen_true`.

**Screens, `tests/invoice-posting-view.test.ts` (pure), then a browser**

- `headline_before_and_after`, `every_reason_has_text`.

Every test above must fail with its fix removed. Each finding also needs a real invoice
through the real UI, confirmed in the database, as Gate 4 will set out.

## Least confident decisions

1. **The denominator is every line, deposits and freight included.** That matches the
   mockup ("3 of 5"), but a bar owner might read a skipped deposit as a problem. The
   alternative counts product lines only, and lists the rest separately.
2. **A printed pack size beats the remembered one.** It came from this document. The
   cost: if extraction misreads it the same way every time, the reviewer corrects it on
   every invoice. Both are visible and editable.
3. **Aliases are learned from every matched line on submit, not only corrected ones.**
   The schema comment expects a confirmed pre-match to raise confidence, and the current
   code never does. It adds locks inside the review transaction, so keys are sorted, and
   the flaky `3 simultaneous submitInvoiceReview` test is the one to watch.
4. **`not_posted_at_approval` is an extra reason.** An invoice approved before this fix
   can have an `each` line that would post now but never did. Saying so beats reporting
   it as posted, or inventing another reason.
5. **An `unknown` line that a reviewer matched is skipped as non-product.** The reviewer
   can't change a line's type. If extraction labels real goods `unknown`, those lines
   won't post, though the screen will say why. Checked on real invoices during the build.
6. **The race loser's lookup has to be a locking read.** At repeatable read, a plain
   select after the 1062 can miss the winner's row, leaving a refusal with no name.
7. **The race loser leaves an `uploaded` row with no date.** F10's list names those on
   every range, so one lost race or abandoned upload stays visible there until someone
   rejects it. Honest but noisy. Cleaning those up is out of scope.
8. **Two lines with one key on one invoice: the later line wins.** It's rare, and it
   needs a different product on each line to matter. The alternative is to learn nothing
   from that key.
