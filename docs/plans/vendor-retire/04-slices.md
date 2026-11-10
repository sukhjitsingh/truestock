# Gate 4 — Vertical slices: retire a vendor

Follows `03-program-design.md` (approved 2026-11-09, amended: in-review invoices
complete normally). Four slices in dependency order; each ends working, tested and
shown before the next starts. Test names below are the ones in 03's test plan.

1. **Schema, guard and the four guarded writes** — a vendor can be retired (via the domain) and nothing new can gain it.
2. **Retire / Reactivate end to end** — actions, name-taken refusal, and the two-tap vendors screen.
3. **Every other surface honours it** — pickers, product form, catalog marker, reorder block, invoice upload and review note.
4. **Browser proof and close-out** — the e2e spec, `verify-browser.mjs` coverage, docs.

## How each slice is built

`database` → `backend` → `frontend` + `ui-design` (sequential, both edit `app/`), then
`code-reviewer` and `security-reviewer` in parallel (read-only). I re-run each agent's
tests and mutation checks myself. Each slice lands as its own conventional commit on `fix/qa-open-items`; the branch is
pushed and PRed into `qa-release` only after slice 4 and the full review.

**Done for every slice:** `bun run typecheck`, `bun run lint` (0 errors), and
`bun test --timeout 30000` with `DATABASE_URL` pointing at `…/truestock_test`, tails pasted.
Any slice touching `app/` or `components/` also needs a browser run showing it working.

**Known local-only failure:** the vendor trailing-space test fails on a local MariaDB
(NO PAD collation, open item #51). It is not a regression; note it in the tails.

**Owner decision 4, restated:** in-review invoices of a retired vendor are NOT guarded.
No guard on `submitInvoiceReview`, `approveInvoice` or `upsertAliasCore`; exactly four
writes are guarded. The submit / approve / alias tests assert they **succeed**.

## Slice 1 — Schema, guard and the four guarded writes

- **Goal:** `vendor.active` exists; `assertVendorActive` refuses a retired vendor in `createProduct`, `updateProduct` (only when `vendorId` is set), `assignVendorToProducts` and `createInvoiceForUpload`; `listVendors` takes `includeInactive` and returns `active` + `productCount`. No UI. Deactivate/reactivate do not exist yet, so tests retire a vendor with a direct `UPDATE`.
- **Files:** `db/schema.ts`, `drizzle/0013_*.sql` + `meta/` (via `bun run db:generate`), `lib/domain/errors.ts` (`VendorRetiredError`), `lib/domain/vendor-active.ts`, `lib/domain/catalog.ts` (guards, `VendorSummary`, `listVendors`), `lib/domain/invoices.ts` (guard; delete its private `assertVendorOwned`), `lib/domain/reports.ts` (`vendorActive`, retired-first sort), `tests/vendor-retire.test.ts`.
- **Tests (`tests/vendor-retire.test.ts`):** the four `each guarded write refuses a retired vendor…` cases; `guard runs above other lookups` (+ cross-tenant companion); `clearing the vendor (vendorId: null) is allowed`; `a save that leaves vendorId out succeeds…`; `an invoice in review whose vendor is retired can be submitted and approved…`; `alias learning still records aliases…`; `rejectInvoice … still works`; `race: retire in an open tx…` (both directions); `success metric: nothing gains the retired vendor…`; `retiring keeps products linked`; `listVendors is active-only by default…`; `reorderList sorts retired-vendor items first…`; `audit packet still names a retired vendor`; `invoices of a retired vendor stay readable`. `bun run check:migrations-immutable` must pass.
- **Mutation checks:** delete the `assertVendorActive` call in each of the four writes, one at a time; only that write's case goes red. Move the guard below the product lookup in `updateProduct` → `guard runs above other lookups` red. Drop `FOR UPDATE` from the guard → the race test red.
- **Builder:** `database` (schema, migration), then `backend` (guard, writes, reports, tests).
- **Done:** common criteria; migration applies on `truestock_test`. No browser proof (nothing under `app/` or `components/`).

## Slice 2 — Retire / Reactivate end to end

- **Goal:** an owner or manager retires and reactivates a vendor in two taps; a retired vendor's name stays taken with a clear message. First slice a person can see.
- **Files:** `lib/validation/catalog.ts` (`vendorIdSchema`), `lib/domain/catalog.ts` (`deactivateVendor`, `reactivateVendor`, `VENDOR_NAME_RETIRED` branch in `createVendor` / `updateVendor`), `app/actions/catalog.ts` (`deactivateVendorAction`, `reactivateVendorAction`, `listAllVendorsAction`; `listVendorsAction` becomes active-only), `components/office/vendors-list.tsx`, `app/(office)/office/vendors/page.tsx`, `tests/vendor-retire.test.ts` (additions), `tests/vendor-retire-actions.test.ts`.
- **Tests:** `deactivateVendor sets active=false and returns the count of active products only`; `… are idempotent`; `retire / reactivate on another tenant's or a nonexistent vendor id is NotFound…` (invariant 9); `name reuse: create or rename to a retired vendor's name is VENDOR_NAME_RETIRED…` (the existing duplicate case in `vendor-write-path.test.ts` passes untouched); `reactivate returns the vendor to listVendors and the guard accepts it again`. Actions file: staff refused (row unchanged), manager and owner allowed, retired vendor absent from `listVendorsAction` and present in `listAllVendorsAction`, messages reach the client verbatim, invalid input writes nothing.
- **Mutation checks:** drop `organization_id` from the `UPDATE` in `deactivateVendor` → the cross-tenant case red. Remove `requireRole` from `deactivateVendorAction` → staff-refused red. Make the collision branch always throw `ConflictError` → the `VENDOR_NAME_RETIRED` case red.
- **Builder:** `backend`, then `frontend` + `ui-design` for `vendors-list.tsx` (Retired badge, "N active, M retired", armed text with product count, Cancel).
- **Done:** common criteria; browser run on the vendors screen: Retire → armed text → Confirm → badge; Cancel changes nothing; Reactivate likewise.

## Slice 3 — Every other surface honours it

- **Goal:** a retired vendor can no longer be picked anywhere; products already on it stay fully usable and are marked; reorder flags them; invoices behave per decision 4.
- **Files:** `components/office/product-edit-form.tsx` (send `vendorId` only when changed; "(retired)" option), `catalog-table.tsx` (Vendor column with Retired marker; bulk bar stays active-only), `reorder-vendor-block.tsx` (`flagged`), `invoice-review-form.tsx` (informational note; Submit and Approve stay enabled), pages `catalog/page.tsx`, `catalog/[productId]/page.tsx`, `reorder/page.tsx` (group by `vendorId`), `invoices/page.tsx`, `invoices/[invoiceId]/page.tsx` (names from `listAllVendorsAction`, so no "Vendor #id"), `tests/vendor-retire-ui.test.ts`.
- **Tests:** `edit form vendor options: active vendors plus the current retired vendor labelled "(retired)"…`; `edit form payload omits vendorId when unchanged and includes it when changed`. Domain behaviour is already covered by slice 1.
- **Mutation checks:** make the payload helper always send `vendorId` → omit-when-unchanged red; drop the current-vendor option → options test red. Disabling Submit/Approve for a retired vendor would fail slice 1's submit-and-approve test.
- **Builder:** `frontend`, then `ui-design` for the marker, flagged block and note (dim-bar contrast, large targets). If the diff gets unwieldy, split the invoice screens into 3b; each half still ends working.
- **Done:** common criteria; browser run: retired vendor absent from the product form, bulk bar and upload pickers; a product on a retired vendor can be edited (par/name) and reassigned; a stale-form save shows the refusal with the form still open; reorder shows the flagged block first with no Copy/Print; an in-review invoice of a retired vendor shows the note and can be submitted and approved.

## Slice 4 — Browser proof and close-out

- **Goal:** the behaviour is pinned in a real browser against a production build, not only by unit tests.
- **Files:** `e2e/specs/vendors-retire.e2e.ts`, `scripts/verify-browser.mjs` (beside the open-item-27 vendors check); then `docs/open-items.md` (close #49), `STATE.md`, `docs/history/state-log.md`, `00-status.md`.
- **Tests:** the five e2e cases in 03 (two-tap Retire with product count; Cancel; Reactivate confirm text; pickers + invoice-list name; flagged reorder block), plus `verify-browser.mjs`: retire/reactivate round trip, reorder block, stale-form refusal.
- **Mutation checks:** make `listVendorsAction` return all vendors → the picker case red; remove `flagged` from the reorder page → the reorder case red.
- **Builder:** `frontend` writes the specs; `code-reviewer` and `security-reviewer` run over the whole diff in parallel; fixes go back to the owning agent.
- **Done:** common criteria plus `bun run build` and `bun run e2e` green; reviewer findings resolved; items closed in the docs above.
