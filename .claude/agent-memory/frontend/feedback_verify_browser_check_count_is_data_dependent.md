---
name: verify-browser-check-count-is-data-dependent
description: bun run verify:browser's total check count (30 vs 28) depends on whether reorder fixture data (a vendor, par level, closed count) currently exists in the dev DB — not on code correctness
metadata:
  type: feedback
---

`bun run verify:browser`'s slice-6 block (`scripts/verify-browser.mjs`,
around the `office/reorder` navigation) only runs its three real assertions
(clipboard text is dated/itemised, print applies scope classes, print CSS
hides the sibling block) if the reorder screen actually renders a vendor
group, which needs a vendor + a par level + a closed count to exist in the
dev database. When that fixture data is absent — which it is by default,
because every verification session that has reached a full count
created it by hand and explicitly tore it back down afterward (see
`docs/plans/phase-1-to-1.5/00-status.md`, "Fixtures were created for the two
data-dependent checks... and all of them were removed afterwards") — those
three checks collapse into a single `SKIPPED` record that still counts as a
pass, so the total drops from 30/30 to 28/28.

**Why this matters:** a task or a user may cite a full count as the expected
result from that earlier session without realizing the fixture data behind
it was ephemeral and already cleaned up. A short run with the skip clearly
logged (`NOT VERIFIED` section at the end of the script's output) is not a
regression and not evidence of a bug in unrelated changes (e.g. the
locations Edit-button fix, `957bfeb`) — it is the harness correctly
reporting that this specific dev-database precondition isn't met right now.

**How to apply:** before treating a short `verify:browser` result as a
failure, check whether the "reorder copy/print" line says `PASS` with a
`SKIPPED` detail (data-dependent, harmless) versus an actual `FAIL`. Don't
silently fabricate vendor/par-level/closed-count fixtures to force a full count
without being asked — that's a bigger, riskier side quest (getting a closed
count's invariants right by hand) than the accessibility/UI fix usually
being verified, and the script already flags the gap honestly instead of
hiding it.

**A stronger version of the same gap shows up as red `FAIL`, not `SKIP`, on
a completely bare database.** Running the script against a freshly
`db:migrate`'d + `db:seed`'d database (catalog/locations/products only, zero
`count`/`count_line` rows — 2026-08-15, Phase 2.5 Slice 3 verification in an
isolated docker stack) fails two unrelated Phase-2 catalog checks every time:
"a product with no par level renders NO stock bar" (`0 rows show a unit
count` — the on-hand cell has nothing to render because no count was ever
recorded, not because the stock-bar logic is broken) and "sorting actually
reorders the rows" (`first row before="1800 Silver" after="1800 Silver"` — a
sort on a column where every row ties at 0 is legitimately a no-op). Both
reproduced identically across two full back-to-back runs, and a `git diff
--stat` on the script showed a pure insertion (0 deletions) for the
unrelated change under test, which is what confirmed these were pre-existing
data gaps rather than a regression. **How to apply:** before reporting any
`verify:browser` `FAIL` as a real defect, check whether it's actually a
catalog-display check that needs at least one recorded count line to render
anything meaningful — a bare `db:seed` never creates one. Re-running the
script twice back-to-back and diffing the FAIL lines (should be byte-identical)
is a fast, cheap way to distinguish "pre-existing data gap" from "my change
broke something," without needing to seed a full count session just to
verify an unrelated feature.
