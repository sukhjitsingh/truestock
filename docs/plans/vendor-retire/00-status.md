# Status: retire a vendor (open item #49)

- Gate 1 — Product: APPROVED 2026-11-09
- Gate 2 — Architecture: APPROVED 2026-11-09 (decisions A–F as drafted)
- Gate 3 — Program Design: APPROVED 2026-11-09 (amended same day: in-review invoices complete normally)
- Gate 4 — Slice plan: APPROVED 2026-11-09

## Slices
- [x] Slice 1 — schema, guard and the four guarded writes
- [x] Slice 2 — retire / reactivate end to end (actions, name-taken refusal, vendors screen)
- [x] Slice 3 — every other surface honours it (pickers, product form, catalog marker, reorder, invoices)
- [ ] Slice 4 — browser proof (e2e spec, verify-browser) and close-out

## Notes for a fresh session

- Source: `docs/open-items.md` #49, found by the 2026-11-08 user QA. Trigger:
  first time the owner stops buying from a supplier, or before Phase 3 go-live.
- **Decided by the owner 2026-11-09:** a retired vendor's name stays taken — no
  new vendor may be created with the same name, so historical invoices,
  aliases and reorder history keep pointing at one unambiguous supplier. This
  matches locations (Decision 1) and the existing per-org unique name.
- Consequence raised at Gate 1: because the name stays taken, coming back to a
  supplier needs a **Reactivate** action (locations have none today).
- Work branch: `fix/qa-open-items` (cut from `qa-release` 2026-11-09). Same
  branch also carries open items #50, #29, #30, #46a–d, #40a–f and #15, which
  do not go through the gates.
- Open item #30's vendors part is already done on `qa-release`
  (`vendors-list.tsx` uses the shared table primitives, a caption and
  `<NullValue>`); the earlier summary that it still needed work was stale.
- **Clarified by the owner 2026-11-09 (during Gate 3):** "disabled" means the
  *vendor* is disabled, not its products. A retired vendor can never be
  assigned again (pickers exclude it, saves refuse it). Products already on it
  stay fully usable — counted, edited, reassigned — and show the vendor greyed
  with a Retired marker. Approved invoices stay readable; invoices still in
  review were first drafted as held, but that part was reversed later the same
  day — see the next note. The rest matches Gates 1–3 as drafted.
- **Decided by the owner 2026-11-09 (during Gate 3), amending Gates 1 and 2:**
  an invoice already in review when its vendor is retired is **not held**. It
  can be submitted AND approved normally, and its costs post (the goods were
  delivered; the prices are real). The review screen shows an informational
  note only. A NEW invoice upload naming a retired vendor is still refused
  (`createInvoiceForUpload` guard; upload picker active-only). Rejecting is
  unchanged. Consequences: no guards on `submitInvoiceReview`,
  `approveInvoice` or `upsertAliasCore` (alias learning runs inside submit), no
  `assertInvoiceVendorActiveTx`; guarded writes are 4, not 7 (`createProduct`,
  `updateProduct`, `assignVendorToProducts`, `createInvoiceForUpload`). Gate 1
  stays APPROVED, amended 2026-11-09; Gate 2 Decision D is superseded.
  Gate 3 needs re-approval with these changes.
