---
name: project-phase2.5-slice2-extraction-pipeline-audit-2026-08-15
description: Independent audit of commit 08f685e (extraction pipeline, invoice-line drafts, reap sweep, cron) — clean; no exploitable findings, two low/theoretical notes
metadata:
  type: project
---

Ran 2026-08-15 against commit 08f685e (worktree-phase-2.5-slice-1), the Phase 2.5
Slice 2 backend: `lib/domain/extraction-pipeline.ts`, `lib/domain/invoice-lines.ts`,
`lib/domain/extraction.ts` (reapStuckJobs + transition graph), `lib/domain/errors.ts`,
`instrumentation.ts`, `next.config.ts` (serverExternalPackages), `.env.example`
(ANTHROPIC_API_KEY placeholder), two new deps (`@anthropic-ai/sdk`,
`@firecrawl/pdf-inspector`). This work was recovered by a prior Claude session from a
stalled/retried Workflow run and hand-finished; the user asked for an independent pass
specifically on: client input reaching the pipeline outside `claimNextJob`'s atomic
claim, `systemActor` leaking into a real request context, injection risk in the
PDF-to-Claude-Vision path, and `ANTHROPIC_API_KEY` handling.

**Verdict: clean. No exploitable findings.** This continues the pattern of
[[project-backend-auth-audit-2026-07]] and [[project-multitenant-audit-2026-07]] —
this codebase's domain layer consistently gets tenant-scoping and ownership checks
right, verified against actual query code each time, not assumed from comments.

Specifically verified, not just read:
- `systemActor(job.organizationId)` (extraction-pipeline.ts:74) is grep-confirmed used
  in exactly one place (runClaimedJob). `job.organizationId` traces back through
  `claimNextJob`'s DB row (extraction.ts) to `createInvoiceForUpload`, which stamps it
  from `actor.organizationId` — itself re-read from the DB by `requireRole` at request
  time. No client-controlled value reaches `systemActor`; `userId: 0` is never
  persisted anywhere (grep-confirmed `getInvoice`/`updateInvoiceStatus`/
  `writeExtractedLines` only read `actor.organizationId`).
- `processExtractionQueue`/`reapStuckJobs` are grep-confirmed called from exactly two
  places: `instrumentation.ts`'s cron intervals and the test file — no route handler
  or server action calls either, so there is no client-reachable path into the
  pipeline that bypasses `claimNextJob`'s atomic CAS claim.
- `writeExtractedLines` (invoice-lines.ts) ownership-checks `invoiceId` against
  `actor.organizationId` before its delete-then-insert, inside the caller's
  transaction — matches invariant 9's "ownership-checked, not just existence-checked."
- Claude Vision output crosses the AI/domain boundary through `zodOutputFormat`
  (SDK-side) AND a second independent `extractedInvoiceSchema.parse()` in
  `parseLinesFromVision` — prompt injection embedded in an invoice PDF can produce
  bad/misleading *field values* (wrong description, wrong amount) but cannot escape
  the schema shape, and `lineNumber` is never trusted from the model (renumbered by
  array position). No eval, no template injection, no raw SQL anywhere in the pipeline
  — money/quantity fields land as `toFixed()`-formatted decimal strings via Drizzle's
  parameterised insert.
- `resolveStoredPath` (lib/storage/invoice-files.ts) resolves to an absolute path and
  checks containment against the *resolved* result (root + sep prefix, not a naive
  `startsWith`) before any read/write — `classifyPdf`/`processPdf` in the pipeline
  take that guarantee as a documented precondition and don't re-derive the path
  themselves, which is correct given the resolution happens exactly once in
  `runClaimedJob`.
- `ANTHROPIC_API_KEY`: read only via `process.env` in `getAnthropicClient`
  (extraction-pipeline.ts), never logged, never written to any DB column, never
  returned by any action. `.env.example`'s placeholder is empty (`ANTHROPIC_API_KEY=""`)
  — confirmed no real key committed. Missing-key path throws a clean, caught
  `Error("ANTHROPIC_API_KEY is not set.")` that becomes `extraction_job.errorMessage`,
  never an uncaught crash.
- `extraction_job.raw_response`/`error_message` (which could carry a stack trace or
  the full Claude response) are grep-confirmed never read by any action or route —
  Slice 2 has no review UI yet; nothing exposes them to a manager/staff or even the
  owner. Worth re-checking when the review screen (later slice) is built.
- CSP confirmed untouched in `next.config.ts` — the new `serverExternalPackages` entry
  and `headers()` array are unrelated; AGENTS.md's nonce/hydration warning does not
  apply here.
- Upload content-type allowlist (`lib/storage/invoice-content-types.ts`) has no
  SVG/HTML entry (stored-XSS-via-download vector), and `GET` serves with
  `Content-Disposition: attachment`, so this isn't reachable either way.
- Dependency audit (`bun audit`) unchanged from the existing baseline
  ([[project-baseline-audit-2026-07]]): postcss (high, sourceMappingURL arbitrary file
  read), sharp/libvips (high, dormant — `images.unoptimized: true`), esbuild/js-yaml/
  brace-expansion/nanoid/playwright (dev-only or build-tooling). The two new deps this
  slice adds, `@anthropic-ai/sdk` and `@firecrawl/pdf-inspector`, have no advisories.

Two low-severity/theoretical notes, not blocking, worth a comment or follow-up but not
re-review-worthy on their own:
1. Uploaded file bytes are never magic-byte-verified against the declared
   `contentType` — a client could declare `application/pdf` and upload arbitrary
   bytes. Mitigated in practice by: extension is derived from a fixed allowlist (never
   the client's filename), storage is outside the web root, and `GET` always serves
   `Content-Disposition: attachment` to an owner-only endpoint. Theoretical only under
   the current mitigations.
2. `extraction_job.errorMessage` (caught exception `.message`, up to 2000 chars) can
   contain Node/driver-internal detail (e.g. an ENOENT path) since it isn't scrubbed
   before storage — currently inert because nothing surfaces it to a client, but flag
   this column specifically for redaction/scrubbing review whenever the invoice review
   UI (later slice) starts reading `extraction_job` rows for display.
