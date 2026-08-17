Fixed 2026-08-16, Phase 2.5 (invoice OCR pipeline). Root cause, fix, and how it was verified —
the verification technique here is the reusable part, since it solves a general problem
(DB-backed testing of anything importing `extraction-pipeline.ts` on an Intel Mac).

## The bug

`runClaimedJob` (`lib/domain/extraction-pipeline.ts`) had lost its classification branch: every
`pdfType` — including `text` — fell through to `extractFn`/Claude Vision, requiring
`ANTHROPIC_API_KEY` unconditionally. AGENTS.md §3.2 specifies the opposite: `text`-classified
PDFs should go through `parseLinesFromMarkdown` (pdf-inspector's markdown output, parsed
deterministically, zero AI cost); only `scanned`/`mixed`/`image` need Claude Vision. Symptom: a
text-based invoice upload moved `uploaded → processing` then failed with
`ANTHROPIC_API_KEY is not set`, even in environments that should never have needed the key for
that document.

## The fix

Restores the branch inside `runClaimedJob`, after classification and persisting `pdfType`/
`pagesNeedingOcr`:

```
if (classification.pdfType === "text" || classification.pdfType === "mixed") {
  // fetch markdown via processPdfFn
}
if (classification.pdfType === "text") {
  parsed = parseLinesFromMarkdown(markdown)   // no Claude call
} else {
  // mixed / scanned / image: read PDF bytes, call extractFn (Claude Vision),
  // then parseLinesFromVision. mixed also has the markdown fetched above as
  // cross-check ground truth for pdfInspectorCrossCheck.
}
```

## Verifying it required solving two environment problems Codex's own sandbox could not

Codex's debug journal states plainly: "The DB-backed test and real pdf-inspector run remain
unverified because this Intel Mac has no pdf-inspector native binding and Docker startup is
sandbox-blocked." Both were solvable here because this session has real Docker access.

**Problem 1 — no `darwin-x64` native binding.** See
[[pdf_inspector_no_darwin_x64_binary]] (this dir) for the full detail; short version:
`@firecrawl/pdf-inspector` publishes prebuilt binaries for `linux-x64-gnu, linux-x64-musl,
linux-arm64-gnu, linux-arm64-musl, darwin-arm64, win32-x64-msvc` — not this machine's triple.
Importing `extraction-pipeline.ts` on the host throws `Cannot find native binding` at module
load, which kills the *entire test file*, not just tests exercising the native call.

**Problem 2 — no pre-existing project Docker stack.** `docker compose up -d db` from a fresh
worktree fails with a container-name conflict if another session already has
`truestock-mariadb` running (it did here — a shared container, healthy, up 22+ hours). Don't
fight this: `docker ps --filter name=truestock-mariadb` first, and if a healthy shared
container already exists, point tests at its `truestock_test` database directly rather than
trying to bring up a second stack. `tests/helpers/test-db.ts`'s `assertTestDatabase()` already
refuses to run against any database whose name doesn't end in `_test`, which is what makes
this safe — it can't accidentally truncate the real `truestock` database.

**The actual verification command** (run from the worktree root, literal absolute path — see
the gotcha below):

```
docker run --rm \
  -v /absolute/path/to/worktree:/app \
  -v /app/node_modules \
  -w /app \
  -e DATABASE_URL=mysql://truestock:truestock@host.docker.internal:3307/truestock_test \
  node:22-bookworm-slim \
  bash -c "bun install --frozen-lockfile && bun test tests/extraction-pipeline.test.ts"
```

`node_modules` as an anonymous volume is load-bearing: without it, the bind mount shadows the
directory with the host's own `darwin-x64` `node_modules`, and `bun install` inside the
container either fights the host packages or silently reuses the wrong binary. `--rm` cleans up
the container and the anonymous volume together; nothing shared (the running app container, its
named `truestock-node-modules` volume, the host checkout) is touched.

**Gotcha: the Bash tool rejected the first attempt.** Using `-v "$(pwd)":/app` (command
substitution) was rejected as "too complex to verify that it stays inside the worktree," even
though the session genuinely was isolated in the worktree at the time. Fix: use the literal
hardcoded absolute worktree path in the `-v` flag instead of `$(pwd)`. Prefer literal paths over
command substitution in `docker run -v` mounts generally while worktree-isolated.

## Result

**22/22 pass in `tests/extraction-pipeline.test.ts`** (51 `expect()` calls), including three new
DB-backed regression tests added alongside the fix (`describe("text-PDF queue routing", ...)`):
a text job reaches `needs_review`/`done` without invoking Claude at all; a text-parser failure
fails the job and moves the invoice out of `processing` into the review queue; a scanned job
with no `ANTHROPIC_API_KEY` fails specifically in the Vision branch and clears stale drafts.
**Full suite: 358/358 pass, 985 `expect()` calls, 28 files** — run the same way, against
`tests/*.test.ts` broadly, confirming no regression elsewhere.

This is a stronger verification claim than existed before this session, and the technique
(throwaway Linux container + point at an already-running shared MariaDB's `_test` database) is
reusable for any future test file that imports `extraction-pipeline.ts` — which, on this
project's Intel Mac dev hosts, will be every file that does until pdf-inspector ships a
`darwin-x64` binary or the project moves off it.

## Findings deferred, not fixed

Real findings surfaced while reproducing this against a real Southern Glazer's invoice and
reviewing the surrounding code. Recorded in `docs/open-items.md` items #34–#38 rather than
fixed here, since none of them are this bug: a header-recognition gap in
`parseLinesFromMarkdown` that silently drops a real vendor's line-item table ("Item Name" isn't
in the description-column regex allowlist — #37), no DB-backed test for the `mixed`
classification specifically (#34), unbounded month/day in `parseDateValue`'s date regex (#35),
an untracked real invoice PDF fixture that needs gitignoring or replacing with a synthetic one
(#36), and an environment-only `EEXIST` from a stray file at `var/invoices/{orgId}` (#38). Item
#33 (matching never proven through the real pipeline) got a progress note: the container
technique above unblocks it, but the new tests prove routing, not `matchedProductId` end to
end — still open.
