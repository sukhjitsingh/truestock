# Gate 4 — Vertical Slices: trustworthy invoice approval

Covers F1, F6 and F7. Follows `03-program-design.md`, approved 2026-11-06. Build order,
one line per slice. Each slice ends in something that runs and can be checked.

1. **Tracer bullet (F1):** the review page shows a "N of M will post" panel, fed by the new owner-only report action, with a stub classifier behind it.
2. **F1 happy path:** the real classifier replaces the stub, approval posts `each` and `keg` lines to cost history and the product, and the page shows final counts from rows actually written.
3. **F1 skip reasons:** every skipped line is named with its reason before and after approval, the panel follows the reviewer's edits live, and old approved invoices report `not_posted_at_approval`.
4. **F1 units per case:** migration `0010`, the reviewer's input on `case` lines, saved on the line and the alias, and filled in on the next invoice from that vendor item.
5. **F6 happy path:** review submit learns an alias from a line with no item code, and the next invoice from that vendor pre-matches by description for the reviewer to confirm.
6. **F6 rules:** a confirmed pre-match raises confidence, and vendor and organization scoping, deposit lines and two lines sharing a key all behave as designed.
7. **F7 happy path:** migration `0011`, the claim at confirm, and a second upload of the same file refused with the original invoice named, including the `canOpen` difference by role.
8. **F7 edges:** a rejected copy allows re-upload, simultaneous confirms leave one winner and a named refusal, and Retry and Return refuse when a live copy exists.
9. **Proof on real invoices:** F1, F4, F5, F6, F7, F8, F10 and the minor items go through the real UI on the `_e2e` database with fresh accounts, each confirmed in the database, then build, code review, security review, `STATE.md` and open item #47.

## How each slice is built

`database`, then `backend`, then `frontend`, one after the other. I re-run each agent's
tests and mutants myself. Slices with new screens get a browser check before they are
ticked; slice 9 is the full proof.

## One commit per finding

Slices are the unit of work and findings are the unit of commit. F1 is slices 1–4, F6 is
5–6 and F7 is 7–8. Each slice is a local work-in-progress commit, and the slices of one
finding are squashed into one conventional commit when that finding's last slice passes.
Nothing is pushed.

## What slice 9 cannot prove

- Anything needing Vision, including invoice B and F9's scanned path, unless
  `ANTHROPIC_API_KEY` is set.
- F9 on Hostinger. That is the canary in `docs/go-live.md` and needs a separate test site.
- F6 pre-match on a real file needs a second real invoice from the same vendor, or the
  first copy rejected and re-uploaded, because F7 now refuses a plain re-upload.
