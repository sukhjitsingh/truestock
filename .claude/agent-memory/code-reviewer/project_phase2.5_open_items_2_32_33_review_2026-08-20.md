---
name: phase2.5-open-items-2-32-33-review
description: Review of open-items #2 (fill-correction ledger writeType), #32 (invoice header-field corrections), #33 (matchLinesToProducts DB-backed pipeline test) on feat/phase-2.5-open-items-2-32-33 — clean, no findings
metadata:
  type: project
---

Reviewed 2026-08-20: uncommitted working tree on
`feat/phase-2.5-open-items-2-32-33` (based on `feat/phase-2.5-invoice-automation`
@ c2cf661), closing docs/open-items.md #2/#32/#33. No findings — every invariant
in scope verified sound, independently re-run (not just trusted from the diff's
own close-notes):

1. **Invariant 3/5 (idempotency) on the new fill-correction ledger path**
   (`lib/domain/counts.ts:editCountLineFills`, `db/enums.ts:countLineWriteTypeEnum`).
   Copies the EXACT `findReplayedLine` pre-check + ledger-insert-goes-second-
   uncaught + outer try/catch-`isDuplicateKeyError`-fallback-to-replay shape
   `applyIncrement`/`setCountLineQuantities` already use — not a new pattern.
   `partial_fills_before`/`partial_fills_after` (nullable JSON) carry the full
   state transition since a whole-array REPLACE has no delta representation in
   `partial_fills_delta`'s additive-append shape; that column correctly stays
   `[]` on `fill_correction` rows. Independently ran the new
   `tests/count-write-path.test.ts` "fill corrections write a ledger entry"
   block against a real MariaDB (isolated worktree stack, see below) — 27/27
   pass, including the replay-same-clientLineId-inserts-nothing-new case.
2. **Invariant 9 on the header-correction feature**
   (`lib/domain/invoices.ts:resolveHeaderCorrectionData`,
   `lib/domain/invoice-lines.ts:submitInvoiceReview`'s new 4th param). Introduces
   NO new client-supplied foreign id and NO new ownership check surface — every
   field it can touch is a scalar column on the invoice row already
   ownership-checked by `updateInvoiceStatusTx`'s own tenant-scoped
   `SELECT ... FOR UPDATE`, reused unchanged. Confirmed via the existing
   cross-tenant `submitInvoiceReview`/`reviewInvoiceAction` tests (unchanged by
   this diff) plus the new header-correction tests, 38/38 pass.
3. `headerCorrectionSchema` (`lib/validation/invoices.ts`) is properly bounded
   to DB column widths — `invoiceNumber` max(100) matches `varchar(100)`, the
   new `invoiceTotalMoneyStringSchema` regex allows exactly 6 integer + 4
   decimal digits matching `DECIMAL(10,4)`. Closes the "AI-output Zod schemas
   not bounded to DB column widths" gap flagged in the Slice 2 review
   ([[project-phase2.5-slice2-extraction-pipeline-review-2026-08-15]]).
4. Item #33's new pipeline test (`tests/extraction-pipeline.test.ts`) genuinely
   drives `processExtractionQueue` end to end (seeds a real `vendor_alias`,
   asserts `matchedProductId`/`matchedVendorAliasId`/`matchConfidence` on the
   saved rows) rather than re-deriving the matching loop inline — closes the
   "tests that duplicate pipeline logic instead of calling
   runClaimedJob/processExtractionQueue aren't real coverage" gap flagged in
   the Slice 3 review ([[project-phase2.5-slice3-matching-review]]). 30/30 pass.

Verification method: `tsc --noEmit` and `eslint` both clean independently
confirmed. Full targeted test files (count-write-path, invoice-review-path,
extraction-pipeline) re-run against real MariaDB in a **fresh throwaway isolated
worktree-test stack** (`docker-compose.worktree-test.yml -p <unique-project-name>`,
matching the existing `testing_parallel_worktree_docker_and_migration_race`
backend memory) rather than trusted from the diff's own close-notes. That
memory's warning is still live and bit this review directly: pointing `bun test`
at the shared main-checkout `truestock-mariadb`/`truestock_test` (port 3307)
produced `ER_DUP_ENTRY` on `user`/`location` fixture inserts from a concurrent
process racing `resetDatabase()`, and running two files concurrently even
against a fresh isolated stack raced `migrateTestDatabase()`'s DDL (both files'
`beforeAll` started migrating a not-yet-migrated DB at once) — **run
`drizzle-kit migrate` once up front, then one test file per `bun test`
invocation**, against an isolated stack, is the reliable sequence for a
reviewer verifying DB-backed tests in this repo, not just for implementers.

No new recurring-pattern gaps to flag for the next slice — this is the second
clean review in a row (after [[project-phase2.5-slice4-cost-flow-review-2026-08-19]]).
