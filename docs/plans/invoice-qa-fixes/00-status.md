# Status: invoice QA fixes (F1, F6, F7)

- Gate 1 — Product: APPROVED 2026-11-06
- Gate 2 — Architecture: APPROVED 2026-11-06
- Gate 3 — Program Design: in progress
- Gate 4 — Slice plan: pending

## Slices
Not planned until Gate 4.

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

`ANTHROPIC_API_KEY` was empty when this started, so anything needing Vision or
invoice B is unverified. `tests/invoices/` holds real documents: never commit it.
