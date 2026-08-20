Fixed 2026-08-19, Phase 2.5 (invoice OCR pipeline). Closes open-items.md #34-#38 and adds
a vendor template for Southern Glazer's Wine & Spirits. Built via a 6-agent Workflow run
(implement → review → fix findings → verify) on branch
`feat/phase-2.5-invoice-template-open-items`, based on `origin/feat/phase-2.5-invoice-automation`
(Slice 4 merged). See [[extraction_pipeline_text_pdf_mis_routing_fix]] (this dir) for the
prior session that opened these items and the Docker/MariaDB verification technique this
session reused unchanged.

## Southern Glazer's real invoice shape (why it needed new code, not just a bigger regex)

A portal "Order History" export, structurally unlike every previously-supported vendor:

- Line-item table headed `Item Name | Quantity | Gross Amount | Discount Amount | Net Amount`
  — **no** Unit Price, Item Number/SKU, Brand, or UOM column, ever. `unitCost`,
  `extendedCost`, `vendorItemCode`, `packSize` are correctly `null` for this vendor, not
  missing data.
- `Item Name` is a compound bullet-separated string (`NAME • SIZE • CASE PACK • CLOSURE`,
  joined with " • ") — kept unsplit as `description` on purpose; splitting would require
  guessing which fragment is which field.
- `Quantity` is a compound string mixing number + unit word (`"1 Cases"`, `"2 Units"`).
- Totals row: `Total Cases | Total Units | Gross Total | Discount Total | Net Total`, with
  a legal footnote concatenated onto the first data cell — but Gross/Discount/Net stay clean
  in the same row.
- Invoice number is standalone bold markdown `**Invoice Number: NNNNNNN**`, not in any table
  (already handled by the pre-existing text-fallback code, no change needed).

Documented in full, with verbatim headers and a field-mapping table, at
`docs/vendor-templates/southern-glazers.md` — read that before onboarding the next vendor
whose shape doesn't fit the existing allowlists.

## The six code changes (`lib/domain/extraction-pipeline.ts`)

1. Header-pattern regexes became shared constants (`DESCRIPTION_HEADER_PATTERNS`,
   `QUANTITY_HEADER_PATTERNS`, `AMOUNT_HEADER_PATTERNS`, `CODE_HEADER_PATTERNS`,
   `GROSS_/DISCOUNT_/NET_HEADER_PATTERNS`), used by both `parseLinesFromMarkdown` and
   `countMarkdownTableDataRows` — previously two independent copies that could drift.
   `DESCRIPTION_HEADER_PATTERNS` gained `/^item\s+name$/` and bare `/^item$/`; the
   Gross/Discount/Net patterns gained an optional `(?:\s+amount)?` suffix.
2. `INVOICE_DATE_HEADER_PATTERNS` gained `/^document\s*date$/`, tried table-first.
3. `totalGross`/`totalDiscount`/`totalNet` now try `findMarkdownTableValue`, then a new
   `findMarkdownEmbeddedLabelValue` (handles the footnote-polluted totals row — a label
   row with no clean separator of its own), before falling back to the original free-text
   `findLabeledAmount` search. Non-regressive: the Performance Foodservice fixture's
   "PAY THIS AMOUNT" fallback is unaffected because none of its headers match any
   `TOTAL_*_HEADER_PATTERNS`.
4. New `parseCompoundQuantityCell` — engages only when the plain numeric parse of the
   quantity cell fails; its inferred `uom` is used only when a separate UOM column found
   nothing (never overwrites a real value).
5. New `looksLikeUnrecognizedLineItemTable` guard implementing the owner's explicit
   directive ("if the invoice data is not ready properly, we don't have data at all"): a
   table with >=2 data rows, >=3 columns, and >=2 rows with a cleanly-parseable numeric
   cell, whose description column still can't be identified, throws and refuses to write
   a partial result — a distinct message from the pre-existing "zero draft lines" throw.
6. `parseDateValue` now bounds month 1-12/day 1-31 on both ISO and US regex branches,
   returning `null` on violation instead of silently rolling over via `Date.UTC` (#35).

## Two real bugs the review stage caught — both would have shipped un-tested otherwise

**Guard false-positive on ordinary summary tables (code review).** As first written, the
item #5 guard also fired on a plain 2-column `Subtotal | Tax | Total` block — an extremely
common invoice layout element, distinct from a line-item table — because bare "Total"/
"Subtotal"/"Tax" don't match `TOTAL_LABEL_HEADER_PATTERNS` (which requires "gross"/
"discount"/"net" combined with "total"), and 3 rows with numeric cells clears the
threshold. This threw away the *entire* extraction, including a correctly-parsed real
line-item table sitting right next to it — the mirror-image failure of #37 (silent drop),
now a loud but *wrong* rejection. Southern Glazer's own fixture didn't catch this because
its totals row happens to say "Gross Total"/"Discount Total"/"Net Total", which do match.
**Fix:** added a `table.headers.length < 3` exclusion — a real line-item table always
carries description + at least two more columns; a summary block is always exactly 2.
Regression test added: a bare Subtotal/Tax/Total table beside a real line-item table now
parses successfully with the line intact.

**EEXIST handling missed the ENOTDIR sibling case (both reviewers, independently).**
`writeInvoiceFile`'s new try/catch (open item #38) only matched `err.code === "EEXIST"`,
which Node throws only when the stray non-directory file *is* the exact leaf directory
being created. When the stray file is an **ancestor** segment instead (e.g.
`INVOICE_STORAGE_DIR` itself — arguably the more likely deployment mistake, confirmed
empirically with a real `fs.mkdir` repro), Node throws `ENOTDIR`, which fell through to
the raw `throw err`, defeating the fix's own stated purpose. **Fix:** catch matches both
codes, one message. Not client-exploitable (the only caller wraps all non-domain errors in
a generic 500), but was still a real gap in what the fix claimed to close.

**Lesson:** both bugs were in code a prior implementation stage's own hand-verification
had called correct — the guard was traced against every existing fixture and judged safe,
and the EEXIST fix was traced against the exact scenario it was built for. Neither
hand-trace exercised a case the implementer didn't think to construct (a bare-labeled
summary table; a stray file one level higher). Independent review inventing its own
adversarial inputs, not just re-reading the diff, is what caught both — matches
[[Workflow model tiering]] pattern generally.

## New: real vendor data almost committed into a doc, not the gitignored PDF

Security review caught that `docs/vendor-templates/southern-glazers.md` reproduced the
owner's actual invoice numbers in prose (invoice #5402426, account ID 10880, real dollar
totals, a real product+SKU) — in 4 sections (§2, §3, §6, §9; the review only flagged §6,
broader on inspection during fix). This is the same open-items #36 problem
(don't let real vendor pricing into git history) resurfacing through a different file type
than the one #36's `.gitignore` rule actually blocks. **Lesson for any future vendor
template/doc built from a real invoice: redact to the same synthetic values already used
in the test fixture before the doc is ever staged — a `.gitignore` rule on the source PDF
does not protect a markdown doc built by hand from reading that PDF.**

## `docker-up-guard.sh` — a second Docker gotcha, distinct from the darwin-x64 binding gap

`scripts/docker-up-guard.sh` refuses `bun run docker:up` when it detects a live LAN dev
session already using the Docker stack, to avoid silently resetting that session's network
config (see open-items #24, closed 2026-08-12). The implementation-stage agent hit this
correctly and did *not* override it — meaning the raw `docker run --rm ... node:22-bookworm-slim`
technique from [[extraction_pipeline_text_pdf_mis_routing_fix]] (pointed directly at the
already-running `truestock-mariadb` container via `host.docker.internal`) is the one that
still works unattended, since it never calls `docker:up` at all. The dedicated `verify-tests`
stage used exactly that technique and got the full suite running: 407 pass, 0 fail, 1131
`expect()` calls, 30 files, 125.43s.

## Mock-based sanity check without Docker (new, reusable)

Before the dedicated Docker verify stage ran, the implementation agent sanity-checked the
pure-function logic (`parseLinesFromMarkdown`, `parseDateValue`, the new guard) directly on
the host despite the missing `darwin-x64` `@firecrawl/pdf-inspector` binding, using a
temporary test file with Bun's `mock.module("@firecrawl/pdf-inspector", ...)` to stub the
native import. This unblocks fast local iteration on parsing logic — nothing that touches
the DB or the real native binding — without needing Docker at all. The temp file was
deleted afterward; not a permanent fixture, but worth reaching for again on the next
markdown-parsing change before waiting on a full Docker verify pass.

## Verification

`407 pass, 0 fail, 1131 expect() calls, 30 files` via the Docker/MariaDB technique above —
`tests/extraction-pipeline.test.ts` 29/29 (includes the new item #34 DB-backed `mixed`-
classification regression), `tests/invoice-storage.test.ts` 18/18. Lint 0 errors (1
pre-existing unrelated warning in `catalog-table.tsx`). `tsc --noEmit` clean.

## Workflow-authoring gotcha (process note, not code)

Workflow scripts are parsed as plain JavaScript. Backtick characters used for markdown
code fences or inline code, embedded raw inside a backtick-delimited JS template literal
in the prompt text, break the parser — they're template-literal syntax to JS, not markdown
to the reader. Fix: build large prompt-text blocks as arrays of plain quoted strings joined
with `.join('\n')`, and use plain "=== BEGIN/END ===" markers instead of triple-backtick
fences for embedded fixture text. Also confirmed empirically this session: `Workflow`'s
`resumeFromRunId` replays a successfully-completed `agent()` call's cached result instantly
and only re-runs agents that actually errored (a mid-run monthly-spend-limit failure on 4/5
agents resumed cleanly, redoing only the failed 4).
