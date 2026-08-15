---
name: project-phase2.5-slice2-extraction-pipeline-review-2026-08-15
description: Recurring patterns found reviewing commit 08f685e (extraction pipeline / invoice-line drafts) — watch for these again in Slices 3-5 of Phase 2.5 invoice automation
metadata:
  type: project
---

Reviewed commit 08f685e (`lib/domain/extraction-pipeline.ts`, `lib/domain/invoice-lines.ts`,
`lib/domain/extraction.ts`'s `reapStuckJobs`). Invariant 9 (tenant scoping) is sound —
`systemActor(job.organizationId)` traces to DB-sourced values only, `writeExtractedLines`
does its own ownership SELECT before delete-insert, matches the security-reviewer's
independent audit that same day ([[project-backend-auth-audit-2026-07]]-style verdict:
clean). The "plausible-but-wrong default" principle (AGENTS.md) is honored throughout —
every AI-extracted field stays `null` rather than being coerced, decimal-string conversion
never invents precision. These parts do not need re-checking from scratch next time; spot-
check that new slices keep the same discipline.

Three patterns worth checking again as Slices 3 (matching), 4 (cost flow), 5 (audit packet)
land, since they're structural to this feature area, not one-off mistakes:

1. **New pure/testable domain logic shipped with zero direct unit tests.**
   `extraction-pipeline.ts`'s own docstring says its stages are "exported individually so
   each is unit-testable without a network call or a real PDF" — true of
   `parseLinesFromVision`, `arithmeticCheck`, `pdfInspectorCrossCheck`,
   `normalizeLineType`/`normalizeUom` — yet none has a test. More importantly,
   `writeExtractedLines`'s ownership check (the one genuinely new invariant-9 code path in
   this commit) has no direct test either — every OTHER domain write function in this
   codebase with an ownership check gets one (see `count-write-path.test.ts`,
   `catalog-write-path.test.ts`). The commit's own test file
   (`tests/extraction-job-lifecycle.test.ts`) is thorough and mutation-checked, but it only
   covers `lib/domain/extraction.ts`'s job-lifecycle machinery (the four adversarial cases
   `04-slices.md` names for the cron), not the pipeline/parsing/write-path logic that
   landed alongside it. Check for this gap again in Slice 3's `matching.ts` and Slice 4's
   `cost-derivation.ts` — both are exactly this same shape (pure functions + one
   ownership-checked write).

2. **AI-output Zod schemas aren't bounded to the DB column widths/precisions they feed.**
   `extractedLineSchema`/`extractedInvoiceSchema` (extraction-pipeline.ts) validate shape
   and nullability but not `.max()` length on `description`/`vendorItemCode`/
   `packDescription`/`invoiceNumber`, so a garbled extraction produces a raw MariaDB
   truncation/out-of-range error instead of a clean domain error at the Zod boundary.
   Low-probability (real invoices don't have 600-char descriptions) but cheap to fix and
   matches this project's own "validate every input at the boundary" rule — AI output
   crossing into the domain layer is a boundary like any other. Worth adding `.max()`
   bounds matching `db/schema.ts`'s varchar lengths whenever a new AI-extraction Zod
   schema is added in a later slice.

3. **A document-level check failure has nowhere to land when zero lines are extracted.**
   `arithmeticCheck`/`pdfInspectorCrossCheck` failures are surfaced by mutating
   `line.exceptionFlags` for every line in the array — if extraction returns zero lines
   (blank page misread, a page Claude couldn't parse) but the check still fails (total
   doesn't reconcile to $0), the loop that appends "doesn't add up" iterates nothing, and
   the invoice reaches `needs_review` with no visible signal beyond an empty line table.
   This is exactly the "nothing looks broken until weeks later" failure mode AGENTS.md
   warns about (the locked-location invariant, the SET/ADD button). No invoice-level flag
   exists to catch this. Worth an invoice-level (not just line-level) exception channel
   before the review screen (Slice 2's second half) ships, or a rule that a header-total
   vs zero-lines mismatch fails the job outright instead of silently reaching review.

Also flagged, lower priority: `MAX_OUTPUT_TOKENS = 8192` is untested against a real
multi-line invoice (this project has zero real invoice samples yet, per the pipeline
file's own comment) and the code only checks `parsed_output == null`, not
`stop_reason === "max_tokens"` — a truncated response fails with a generic "no
parsed_output" message rather than one that says what actually happened. And
`reapStuckJobs`'s query (`lt(claimedAt, cutoff)`) would silently never reap a `running` job
whose `claimedAt` is NULL — unreachable today (only `claimNextJob`'s atomic UPDATE ever
sets status to `running`, and it always sets `claimedAt` in the same statement), but the
transition graph's own comment explicitly invites a future caller to drive `queued ->
running` through the generic `updateJobStatus` CAS path directly ("just not the primitive
that usually performs it") without necessarily setting `claimedAt` — a latent landmine if
that invitation is ever taken up. Worth an `isNull(claimedAt)` clause in that query as
defense in depth.
