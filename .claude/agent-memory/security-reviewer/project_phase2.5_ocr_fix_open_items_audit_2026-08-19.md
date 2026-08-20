---
name: phase2.5-ocr-fix-open-items-audit
description: Audit of open-items #34-38 fix (extraction-pipeline.ts markdown parsing, EEXIST handling) plus new docs/vendor-templates/southern-glazers.md — one real data-exposure finding, not code-level
metadata:
  type: project
---

Audited on branch `feat/phase-2.5-invoice-template-open-items` (diff against
`origin/feat/phase-2.5-invoice-automation`), covering the fix for docs/open-items.md
#34-#38: the >=2-row "unrecognized line-item table" throw, the compound
quantity/UOM cell parser (`parseCompoundQuantityCell`), the table-aware
totals lookup (`findMarkdownEmbeddedLabelValue`), `parseDateValue`'s new
month/day bounds check, and `writeInvoiceFile`'s new EEXIST handling.

**Code-level verdict: clean.** Manually traced the new >=2-row unrecognized-table
guard and the totals-lookup precedence against every markdown fixture in
`tests/extraction-pipeline.test.ts` (Performance Foodservice included) — no
false positive/negative, no fabricated-numeric-default path, `uom` fallback
correctly never overwrites a legitimately-found separate UOM column (only
engages when the plain quantity parse already failed). Consistent with the
owner's "if the invoice data is not ready properly then we don't have data at
all" directive — the new throw is a deliberate loud-failure path, not a bug.
Could **not** execute `bun test` in this sandbox: `@firecrawl/pdf-inspector`
has no darwin-x64 native binding (Intel Mac) and no WASI fallback package is
reachable without network access — confirmed via `git stash` that this is a
pre-existing environment limitation, not caused by this diff. `bunx tsc
--noEmit` is clean. Verification here is by careful static trace, not
execution — say so explicitly if asked to confirm test-suite status later.

**The one real finding: not in the code, in the docs.**
`docs/vendor-templates/southern-glazers.md` §6 ("The real invoice this was
verified against") embeds the owner's actual Southern Glazer's invoice data —
real invoice number (5402426), real vendor Account ID (10880), real dollar
totals ($483.64/$123.78/$359.86), and a real product+SKU
("BLACK VELVET CANADIAN 80 984395") — about to be committed to git history in
the same change as a `.gitignore` rule (`tests/*.pdf`) whose own commit
message says the point is to stop real supplier pricing from landing in git
history. The doc's own §8 correctly instructs future work to extract
*structure*, not real vendor data, into fixtures (and the test file does this
correctly via `SOUTHERN_GLAZERS_SYNTHETIC_MARKDOWN`, entirely fabricated
numbers) — §6 just doesn't follow its own rule. Git history is permanent;
unlike the excluded PDF this is a markdown file that will be committed and
diffed. Concrete, actionable, not theoretical, and cheap to fix before merge
(the file is still untracked at review time) — redact §6 to structure-only or
swap in synthetic numbers matching the test fixture.

See [[project_phase2.5_slice2_extraction_pipeline_audit_2026-08-15]] and
[[project_phase2.5_slice4_cost_flow_audit_2026-08-19]] for prior clean audits
of the same pipeline family.

**RESOLVED same session, before commit.** The `fix-findings` stage of this
same Workflow run redacted every real-data instance in the vendor template
doc (§2, §3, §6, §9 — broader than this audit's §6-only report) to the
synthetic values already used in `SOUTHERN_GLAZERS_SYNTHETIC_MARKDOWN`.
Confirmed independently by the orchestrator (grep for the real invoice
number/account ID/totals/SKU across `docs/vendor-templates/
southern-glazers.md` returns no matches) before the branch was committed.
Also fixed in the same pass: a code-review finding that the new
`looksLikeUnrecognizedLineItemTable` guard false-positived on ordinary
Subtotal/Tax/Total summary tables, and the ENOTDIR sibling gap this file's
own LOW finding named — both confirmed present in the final diff. A
dedicated `verify-tests` agent then ran the full suite against a real
MariaDB (the execution this audit couldn't perform): **407 pass, 0 fail**.
