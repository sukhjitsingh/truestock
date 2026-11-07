# Status: Phase 2 — Comprehensive UI/UX Redesign & Surface Modernization

Covers ROADMAP.md Phase 2, `docs/design-system.md`, and the full screen inventory across Mobile Floor App (`app/(count)`) and Desktop Back-Office (`app/(office)`).

- **Gate 1 — Product:** APPROVED (`gate-1-product.md`)
- **Gate 2 — Architecture:** APPROVED (`gate-2-architecture.md`)
- **Gate 3 — Program Design:** APPROVED (`gate-3-program-design.md`)
- **Gate 4 — Slice Plan:** APPROVED (`gate-4-vertical-slices.md`)

---

## State on branch `feat/ui-ux-redesign-v2` (2026-10-24)

**Built, not proven.** All seven slices have code on this branch. None has been
exercised in a browser. Do not open a PR from this branch until the browser pass
below is done — `AGENTS.md`: "A 200 is not evidence that a page works."

This directory supersedes the earlier stub at `docs/plans/phase-2-ui-redesign/`
(`00-status.md`, `gate-1-product.md`), which is left as committed.

### Verified (in a container, against a real MariaDB 11.8)

- `tsc --noEmit` clean.
- ESLint: 0 errors. Warnings remain (unused imports in a few test files, and a
  `react-hooks/incompatible-library` warning in `catalog-table.tsx`).
- `bun test`: 649 / 649 pass. These are static-render and logic tests
  (`renderToString`, pure functions, DB-backed domain tests). **They do not
  exercise client interaction** — no taps, no effects, no IndexedDB.
- Invoice preview framing headers, at the header level only: against a real
  `next dev` server, `/api/invoices/<digits>/file` returns
  `X-Frame-Options: SAMEORIGIN` and a CSP with `frame-ancestors 'self'` and
  `object-src 'self'`; `/api/invoices/abc/file` and `/api/invoices/42/file/x`
  stay `DENY` / `'none'`. `tests/invoice-preview-framing.test.ts` pins those
  values. **It cannot prove a browser renders the PDF.**
- Spot checks: no `<tr onClick>` / `<TableRow onClick>` anywhere; all four
  multi-line JS-handled `<form>`s carry `method="post"` (the catalog search form
  is deliberately `method="get"`, with its rationale in a comment); cost values
  are stripped server-side for non-owners (`lib/domain/counts.ts`,
  `app/actions/counts.ts`) and the changed pages only render what arrives.

Dependency caveat: the container's `node_modules` came from the backend branch
lockfile (Next 16.3.2). This branch's base declares Next 16.2.11. Results hold
for a superset of the deps this branch declares; rerun after the two branches
are merged.

### NOT verified — required before any PR

- Mobile counting loop end to end: scan → resolve → tenths / quantity → next.
- Offline queue (IndexedDB), retry, and the one-fresh-`client_line_id`-per-attempt rule.
- Location lock per leg, "Finish section", and the stray-bottle modal.
- SET / ADD before-and-after on the submit button, live, with no modal.
- `OfficeRail` cookie (`truestock_rail`) — no layout shift on reload.
- Dark (count) and light (office) themes; tap-target sizes on a real phone in a dim room.
- **Invoice review iframe preview.** Whether Chrome's PDF viewer renders inside
  the frame under the new headers, and whether the *parent* page's own CSP
  needs `frame-src` / `object-src` relaxed, is unknown.
- Invoice review actions (confirm / return / correct) after the form was restyled.

### Found and fixed while moving this code

- **`StrayBottleModal` re-render loop.** A reset effect called `setState` on a
  closed modal, looping on every render. Restructured into a wrapper plus
  `StrayBottleModalBody`; the effect is gone. (Caught by ESLint's
  `set-state-in-effect`, not by a test.)
- `count-leg.tsx` lost its `eslint-disable-next-line react-hooks/set-state-in-effect`
  and the comment explaining the `void flush()` effect; both restored.
- `tests/challenger-mobile-calculations.test.ts` had a test that re-implemented
  the logic it claimed to check. Relabeled "models: …" with a NOTE that it is
  not component evidence.
- The invoice file route moved from `attachment` to `inline` so the review
  screen can preview it; that needed the scoped framing headers above
  (`lib/csp.ts`, `middleware.ts`, `next.config.ts`). The CSP stays in
  `middleware.ts`; only a *scoped* `X-Frame-Options` lives in `next.config.ts`,
  and it must stay in lockstep with `lib/csp.ts`.

### Reviewer audit of the `count-leg.tsx` rewrite

`count-leg.tsx` shrank by 369 lines against the base. A read-only review for
lost behavior (count-write path, idempotency, offline queue, location lock)
found two blockers and several should-fixes. Each was confirmed by reading the
code against the base before it was acted on. Static-render and pure-function
tests now pin the fixes; **none of them has been exercised by a tap.**

**Fixed on this branch**

1. **Blocker — fill saves double-counted.** The rewritten `FillEntry` is seeded
   with the line's existing fills and returns the whole list, but the
   no-server-id path sent that list through the additive, ledgered `increment`,
   which appended it onto itself (`[0.3]` + one new bottle became
   `[0.3, 0.3, 0.8]`, optimistically and on the server). Now
   `lib/fill-save.ts` `planFillSave` classifies the edit: `none` sends nothing,
   `append` sends only the added bottles through the ledgered path with a fresh
   `client_line_id`, and `replace` (a bottle changed or removed) uses the
   un-ledgered REPLACE only when the line has a server id, otherwise it refuses
   with a message. Save is disabled until the list differs.
   `tests/fill-save.test.ts`.
2. **Blocker — sealed bottles uncountable in tenths locations.** The redesign
   made `QuantityEntry` the `else` of `showFill`, so on Speed Rail / Back Bar
   (sealed backup is 60-75% of units) there was no way to enter a sealed count.
   Restored the base's always-rendered `QuantityEntry` under a "Sealed bottles
   here" heading.
3. **Plausible-but-wrong defaults** (AGENTS.md). `FillEntry` no longer
   preselects 50% (the placeholder is "—" and "+ Add bottle" is disabled until
   a level is tapped); the stray-bottle modal no longer preselects the first
   other section (the counter must choose).
4. **Unknown barcode vs. failed lookup.** The catalog tab opened the enroll form
   when the lookup *failed* or threw, offering to create a duplicate of a
   product that might already carry the barcode. Now only `ok` with no match
   enrolls; a refusal or an offline throw shows a message. The barcode-less
   "Add" buttons are removed: `EnrollForm` always sends
   `barcode: { barcode, ... }`, which the schema rejects below 4 characters.
   Products with no usable barcode are added from the back office.
5. **Stray modal offline.** A thrown search now says "Offline" instead of "No
   matching products found in catalog."
6. **Invented case size.** `caseSize ?? 1` is gone from the ADD delta in
   `quantity-entry.tsx` and the rescan announcement in `count-leg.tsx`; a case
   of unknown size is an unknown number of units (same rule as
   `computeLineUnits`).

**Known and left as is**

- Ordinary "change/remove a bottle" saves on an existing line use the
  un-ledgered REPLACE (`editCountLineFillsAction`) — that is the base's
  `canCorrect` path and was never in `count_line_write`. Not a regression, but a
  retried REPLACE is idempotent only because it sets, not adds.
- `rescanAnnouncement` is never cleared, so two identical announcements in a row
  (possible only for an unknown case size) will not re-announce.
- Dead props on `FillEntry` (`productId`, `locationName`, `canCorrect`) and an
  owner-only live-cost display on the save button: harmless, not removed.
- `tests/challenger-mobile-calculations.test.ts` and
  `tests/mobile-count-redesign-m2.test.ts` assert strings and helpers they
  re-implement locally (`describeAfter`); they are logic models, not component
  evidence.
- About 118 removed comment lines in `count-leg.tsx` (type docs, helpers,
  `SyncIndicator`) were not restored. The incident-recording comments on the
  write path were.
- The invoice review iframe has no `sandbox` attribute on purpose: a sandboxed
  frame blocks Chrome's built-in PDF viewer. It is same-origin, framed only on
  `/api/invoices/<id>/file` by the scoped headers above.

**Still unverified** — everything under "NOT verified" above, now including
tapping through the fill editor (add, change, remove, save while offline, reopen)
and the sealed entry in a tenths location.

---

## Vertical Slices Execution Plan

Checkboxes below are the original plan. "Built" is not "done" — see the state
section above; they stay unchecked until the browser pass.

- [ ] **Slice 1 (Tracer Bullet):** Design Tokens, Frosted Glass & Shared UI Table Primitives (`globals.css`, `components/ui/table.tsx`, `components/ui/null-value.tsx`, `components/ui/button.tsx`, `components/ui/money.tsx`)
- [ ] **Slice 2:** Mobile Counting Floor Core Loop & Liquid Bottle Vial Simulation (`fill-entry.tsx`, `vial-display.tsx`, tenths keypad, partial fills chip list)
- [ ] **Slice 3:** Cases/Eaches Steppers, Live Consequence Deltas & Rescan Live Region (`quantity-entry.tsx`, `count-leg.tsx`, Invariants 3 & 4)
- [ ] **Slice 4:** Location Leg Locking & Stray Bottle Escape Hatch (`count-leg.tsx`, `stray-bottle-modal.tsx`, `location-picker.tsx`, Invariant 6)
- [ ] **Slice 5:** Desktop Back-Office Shell (`OfficeRail` 64px-208px with cookie, `OfficeBreadcrumb`, Dashboard `/office`)
- [ ] **Slice 6:** Role-Gated TanStack Table & Office Management (`catalog-table.tsx`, `locations-table.tsx`, `vendors-list.tsx`, `users-list.tsx`, Invariants 6, 8, 11)
- [ ] **Slice 7:** Split-Screen Invoice OCR Review & Regulatory Audit Packet Export (`invoice-review-form.tsx`, `audit-packet.tsx`, CAS lifecycle)

---

## Non-Negotiable Invariants Status

These checkboxes record *design intent* — which file is meant to enforce each
invariant. They are not test results for this redesign. Invariants 1, 2, 6, 9, 10
and 11 are enforced by domain code this branch does not touch. Invariants 3, 4,
5, 7 and 8 also depend on client behavior (the fresh `client_line_id` per write
attempt, cases and eaches kept separate, role-gated rendering) that has not been
exercised in a browser — the server-side ledger for 5 is untouched, the client
half is in the rewritten `count-leg.tsx`.

- [x] Invariant 1: Closed counts are immutable (`lib/domain/counts.ts`)
- [x] Invariant 2: Stamped snapshot costs used for valuation (`lib/domain/valuation.ts`)
- [x] Invariant 3: Re-scanning existing bottle increments line (`db/schema.ts`, `lib/domain/counts.ts`)
- [x] Invariant 4: Cases and loose eaches stored separately (`db/schema.ts`, `lib/domain/counts.ts`)
- [x] Invariant 5: `client_line_id` UUID ledger makes writes idempotent (`count_line_write`)
- [x] Invariant 6: Soft deletion enforced on write path for products & locations (`lib/domain/counts.ts`)
- [x] Invariant 7: Auth checked in every action & POST forms (`lib/authz.ts`)
- [x] Invariant 8: Staff and Manager role strictly excludes cost/margin DOM elements (`catalog-table.tsx`, `counts/page.tsx`)
- [x] Invariant 9: Tenant isolation scoped to organization (`Actor.organizationId`)
- [x] Invariant 10: Draft depletion grossed up by waste factor (`pour / (1 - waste_factor)`)
- [x] Invariant 11: Deactivating user revokes active sessions in same transaction (`lib/domain/users.ts`)
- [x] CSP Nonce Compliance: Served from `middleware.ts` with per-request nonce without hydration regressions

---

## Notes for Implementation Agents

1. **Dual-Surface Theme Rule:** Hardcoded `.dark` on `app/(count)/layout.tsx`; default `:root` Light on `app/(office)/layout.tsx`.
2. **OfficeRail Cookie:** Use `truestock_rail` cookie with server layout read to eliminate client-side layout shift. Toggle is top-anchored.
3. **OfficeBreadcrumb:** Ensure `/office/invoices` section prefix is explicitly included.
4. **Table Primitives Migration:** Refactor `locations-table.tsx`, `vendors-list.tsx`, and `users-list.tsx` to utilize `components/ui/table.tsx` and `<NullValue>` primitives.
5. **Role Gating:** Build TanStack Table `columns` arrays at call time; never use `columnVisibility` for cost-related columns.
