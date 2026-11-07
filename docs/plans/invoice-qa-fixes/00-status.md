# Status: invoice QA fixes (F1, F6, F7)

- Gate 1 — Product: APPROVED 2026-11-06
- Gate 2 — Architecture: APPROVED 2026-11-06
- Gate 3 — Program Design: APPROVED 2026-11-06
- Gate 4 — Slice plan: APPROVED 2026-11-06

## Slices
- [ ] Slice 1 — tracer bullet: "N of M will post" panel, report action, stub classifier
- [ ] Slice 2 — F1 happy path: real classifier, `each` and `keg` post, final counts
- [ ] Slice 3 — F1 skip reasons, live panel, `not_posted_at_approval`
- [ ] Slice 4 — F1 units per case, migration 0010
- [ ] Slice 5 — F6 happy path: alias without item code, pre-match by description
- [ ] Slice 6 — F6 rules: confidence, scoping, deposits, shared keys
- [ ] Slice 7 — F7 happy path: migration 0011, claim, named refusal
- [ ] Slice 8 — F7 edges: rejected copy, race, Retry and Return
- [ ] Slice 9 — proof on real invoices, build, reviews, STATE.md, open item #47

## Notes for a fresh session
Covers F1, F6 and F7 from `docs/qa/2026-11-06-invoice-failures-handoff.md`, tracked
as open item #47. F5, F4, F8, F9, F10 and the minor items are fixed outside these
gates. Owner decisions, 2026-11-06 (all taken as recommended):

- **F1 approval:** post what can be posted. Show the count and reasons before
  approval, and the final counts after.
- **F1 pack size:** `each` lines count as 1 automatically. `case` lines take a
  reviewer input, remembered per vendor item. Do not use `product.case_size`:
  it stays NULL for liquor by design.
- **F5 (feeds F1's report):** net 0 and negative net post no cost and are
  reported as skipped with the reason.
- **F6 alias key:** item code when present, otherwise the normalised description,
  scoped to the vendor. The reviewer still confirms every pre-match.
- **F7:** refuse a byte-identical file within one organization and name the
  existing invoice. Allow it if the earlier copy was rejected.

`ANTHROPIC_API_KEY` was empty when this started, and the owner chose on 2026-11-06 to
skip the Vision test until there is a key. Anything needing Vision or invoice B is
reported as not verified, never as passed. `tests/invoices/` holds real documents: never commit it.
