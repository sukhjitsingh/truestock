# Status: retire a vendor (open item #49)

- Gate 1 — Product: in progress (drafted 2026-11-09, awaiting approval)
- Gate 2 — Architecture: pending
- Gate 3 — Program Design: pending
- Gate 4 — Slice plan: pending

## Slices
(written at Gate 4)

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
