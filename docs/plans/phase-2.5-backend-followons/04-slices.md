# Gate 4 — Vertical Slices: Phase 2.5 backend follow-ons

Part A and Part B touch unrelated code paths with no shared dependency
(Gate 1's note), so they run as two independent slice tracks rather than one
sequence. Neither has a UI or endpoint (both explicitly no-UI this round —
Gate 1 Screens, Gate 2 Endpoints), so "tracer bullet" here means the
smallest real, end-to-end-wired slice proven by a passing test against real
code — not a mock standing in for a UI that doesn't exist this round.

## Part A — pdf-inspector selective-OCR adoption

- [x] **Slice 1 (tracer bullet)** — add the `processPdfWithOcr` wrapper and
  the new `ProcessExtractionQueueDeps` field; wire `runClaimedJob`'s branch
  to take the skip-Vision path when `pagesRecommendingHosted` is empty.
  Proof: the new "skip-Vision path" test (Gate 3 Test plan #1) passes;
  `deps.extractInvoice` is a spy that's never called. **DONE 2026-08-23.**
- [x] **Slice 2** — wire the still-calls-Vision path (`pagesRecommendingHosted`
  non-empty → unchanged whole-buffer `extractInvoice` call) and update the
  three existing tests (Gate 3 Test plan #4, lines ~427/483/582) that
  currently assume Vision always runs. Proof: Gate 3 Test plan #2 passes,
  and all three pre-existing tests still pass with their added mock.
  **DONE 2026-08-23 — landed together with Slice 1**, since both paths are
  branches of the same `if/else` and can't be written as two separate code
  changes. Correction to this doc's own count: only **2** of the 3 named
  tests (line ~427 scanned, line ~483 mixed) actually route through the new
  branch and needed a mock — the line ~582 test (open item #33) classifies
  as `text`, never touches `processPdfWithOcr`, and needed no change.
  Also removed one now-redundant duplicate `setJobPhase(job.id, "ocr")`
  call site that predated this change (scanned previously got it from a
  separate branch; now both scanned and mixed get it from the one call this
  slice added).
- [x] **Slice 3** — the parse-failure-falls-back-to-Vision edge case (Gate 3's
  flagged least-confident decision). Proof: Gate 3 Test plan #3 passes —
  a job whose OCR-fused markdown has no parseable table still reaches
  `needs_review`/`done` via the Vision fallback, not a failure. **DONE
  2026-08-23.** The fallback logic itself (`try { parseLinesFromMarkdown }
  catch { /* fall through */ }`) already existed from Slice 1/2 — this
  slice's only remaining work was the dedicated test: a scanned job with
  empty `pagesRecommendingHosted` but pure-prose OCR markdown (no `|` table
  syntax), asserting `extractInvoice` IS called (inverse of Slice 1's
  assertion) and the job still reaches `needs_review`/`done` on the
  Vision-derived line. No production code changed.

## Part B — invoice cost-history / cost-posting backend

- [x] **Slice 1 (tracer bullet)** — create `lib/domain/cost-history.ts` with
  both functions doing the real `canSeeCost` check, the real
  ownership/tenant check (`assertProductOwned` / reused `getInvoice`), and
  the real (so far always-empty-result) query — no cost-history rows seeded
  yet. Proof: Gate 3 Test plan #2 (role gating), #3 (tenant isolation), #4
  (nonexistent id), and #5 (empty-but-real) all pass. **DONE 2026-08-23.**
- [x] **Slice 2** — prove the real money logic: ordering and
  `previousUnitCost` chaining across two real `approveInvoice` calls for the
  same product, and invoice-scoping precision. Proof: Gate 3 Test plan #1
  and #6 pass, reusing `tests/invoice-approval-path.test.ts`'s seeding
  helpers (reproduced locally in the new test file — they weren't exported).
  **DONE 2026-08-23 — landed together with Slice 1** in one
  `tests/cost-history.test.ts` (10 tests, all 6 Test plan items covered),
  same reasoning as Part A's Slices 1/2: a two-function, ~120-line file
  doesn't split meaningfully into an empty-result-only version and a
  real-money-logic version.
  **One real bug caught by the ordering test, not by inspection**: the
  ordering-+-chaining test initially failed — two approvals seeded back to
  back land in the same second, and `product_cost_history.effective_at`
  (db/schema.ts) is a `TIMESTAMP` with no fractional-seconds precision, so
  `ORDER BY effective_at DESC` alone ties and MariaDB's tiebreak is not
  guaranteed newest-first. Fixed by adding `id DESC` as a secondary sort key
  in both functions (same tiebreak pattern already used in
  `lib/domain/extraction.ts`) — no schema change, no scope creep past this
  slice's own file.

## Build order

Five slices total, in this order: A1 → A2 → A3 → B1 → B2 (Part A finishes
end to end before Part B starts, since Part A's mixed/scanned branch
already exists in production and is worth landing first; Part B is
additive-only and has no urgency ordering against it). After each slice:
run it (`bun run test:docker`), show the result, check it off here and in
`00-status.md`, then ask "Continue to slice N+1, or re-steer?" per the
standing protocol — never build past one slice without that checkpoint.
