# Known defects found by the test foundation

Written 2026-10-26 on `test/playwright-foundation`. **None of these are fixed.** They
were found while writing the automated suites, recorded here so they can be picked up
later without re-deriving anything, and each is pinned by a test that is green today
and goes red the day the defect is fixed.

`docs/open-items.md` #41 stays authoritative for *when* each one becomes due (its
trigger). This file is the detail: where it lives, how to reproduce it, what it costs,
a suggested fix, and which test to flip. The suggested fixes are proposals, not
decisions; where a product call is involved it says so.

| # | Defect | Breaks | Where | Pinned by |
|---|---|---|---|---|
| 1 | A deactivated product is still countable | invariant 6 (write path) | `lib/domain/counts.ts`, `lib/domain/catalog.ts` | `tests/known-defects.test.ts` group A |
| 2 | A zero, blank or negative invoice net becomes a unit cost, and approval posts it | invariant 2 | `lib/domain/cost-derivation.ts` | group B |
| 3 | `wasteFactor` accepts 1 or more | invariant 10 | `lib/validation/catalog.ts` | group C |
| 4 | A keg enrolled after the seed gets waste factor 0.000 (judgement call) | invariant 10 | `lib/domain/catalog.ts` | group D |
| 5 | The last-owner guard races | beside invariant 11 | `lib/domain/users.ts` | group E |
| 6 | The owner's inline cost cell never shows "Saved" | none (UX) | `components/office/catalog-table.tsx` | `e2e/specs/office-catalog.e2e.ts` |

**Suggested order if these are worked:** 1 and 2 first. Both produce numbers that look
plausible and are wrong, which AGENTS.md calls the worst failure mode this app has. Then
4 (decide it), 3, 5, 6.

---

## 1. A deactivated product is still countable

**Where:** `upsertCountLineRow` in `lib/domain/counts.ts` and `resolveBarcodeForCount`
in `lib/domain/catalog.ts`.

**What happens.** With `product.active = false`, the first write, an increment and a
scan-by-barcode all succeed. `upsertCountLineRow` checks `location.active` (the fix
from 2026-08-12) but its product lookup selects cost and case size and never reads
`active`. `resolveBarcodeForCount` queries `product_barcode` only and does not join
`product`, so a retired product's barcode still resolves.

**Impact.** A counter who loaded the product before it was retired keeps writing to it
with no error anywhere; a retired product's barcode scans as if live. The count total
looks fine and the retired product shows up in valuation. This is exactly the shape
invariant 6 describes for locations.

**Suggested fix.**
- In `upsertCountLineRow`, select `product.active` in the existing lookup and throw a
  `DomainError` when it is false. Per invariant 6 the check goes **above** the
  existing-line lookup so it runs on every write, not only the insert.
- In `resolveBarcodeForCount`, join `product` and decide the behaviour for a retired
  hit. **Product call:** returning `null` would send the counter into scan-to-enroll
  for a barcode that still exists in `product_barcode`; check how that collides with
  barcode uniqueness before choosing, and consider returning a distinct "retired"
  result so the screen can say so.

**Pinned by:** `tests/known-defects.test.ts`, group A (three `test.failing`: first
write, increment, scan-by-barcode), each beside a passing control.

## 2. A zero, blank or negative net becomes a unit cost, and approval posts it

**Where:** `deriveUnitCost` in `lib/domain/cost-derivation.ts`; its caller
`approveInvoice` in `lib/domain/invoice-approval.ts`.

**What happens.** `quantity` and `packSize` are refused when `<= 0`, but `rawNet` is
only checked with `Number.isFinite`. `-60.00` becomes `"-6.0000"`; `0.00`, `""` and
`" "` become `"0.0000"` (`Number("")` is 0, not NaN). `approveInvoice` takes any
non-null result: it inserts a `product_cost_history` row and overwrites
`product.current_unit_cost` with it.

**Impact.** One mis-extracted line (a blank net, a credit memo line, a free-goods line)
silently sets a product's cost to zero or negative, and every valuation and margin
number built on it is wrong. The history row makes it auditable but does not stop it.

**Suggested fix.** `if (rawNet <= 0) return null;` beside the existing checks.
`null` already means "not determinable" and `approveInvoice` already `continue`s on it,
so the line is skipped rather than overwriting a real cost. **Product call:** a
genuine $0 line (promo, free goods) is also skipped under this rule; that is almost
certainly what you want, but it should be a decision. Consider whether a skipped line
should be visible on the review screen rather than silently dropped.

**Pinned by:** group B (`B1`–`B3` on `deriveUnitCost`, plus a `test.failing.each` on
`approveInvoice` posting).

## 3. `productUpdateSchema.wasteFactor` accepts 1 or more

**Where:** `lib/validation/catalog.ts` line 141: `z.number().min(0).max(9.999).optional()`.

**What happens.** 9.999 is the capacity of the `DECIMAL(4,3)` column, not a domain
limit. Theoretical depletion divides by `1 - waste_factor` (invariant 10), so a value
of 1 divides by zero and anything above goes negative.

**Impact.** Latent today (nothing computes theoretical depletion yet; that is Phase 2),
but one bad edit now would poison the variance report the day it is built.

**Suggested fix.** Cap below 1 in the schema (for example `.max(0.999)`, or a tighter
product limit such as 0.5, since the seeded kegs sit at 0.100). Schema-only is enough;
a CHECK constraint is optional and would need a drizzle-kit migration.

**Pinned by:** group C (`test.failing.each` over 1, 1.5 and 9.999).

## 4. A keg enrolled after the seed gets waste factor 0.000 (judgement call)

**Where:** the `createProduct` insert in `lib/domain/catalog.ts`; also
`updateProduct` for the re-filing case.

**What happens.** `createProduct` has no waste-factor input and no UI anywhere sets it
(`components/` never mentions it), so only the 9 seeded kegs carry the `0.100` that
AGENTS.md promises ("Draft products get 0.100"). A keg enrolled through scan-to-enroll
gets `0.000`. Re-filing an existing bottle as a keg through `updateProduct` also
leaves it at `0.000`.

**Impact.** Once variance exists, that keg looks about 10% over-supplied against its
theoretical depletion, producing exactly the false positives invariant 10 exists to
prevent.

**Why it is a judgement call.** If the intended product decision is "the owner sets the
waste factor per keg later", delete the two tests and say so in AGENTS.md instead. But
then nothing makes that happen.

**Suggested fix.** Default `waste_factor` to `0.100` when `unitType` is `keg`, **derived
from the seed catalog and asserted in a test** (AGENTS.md is explicit that a hardcoded
plausible default is how the 750 ml / half-barrel keg-size bug happened). Optionally
expose it on the enroll form, but that form has a 20-second budget, so a derived
default is better than another field.

**Pinned by:** group D (`D1` enroll a keg, `D2` re-file a bottle as a keg).

## 5. The last-owner guard races

**Where:** `setUserActive` in `lib/domain/users.ts` (and `setUserRole`, same shape).

**What happens.** `countActiveOwners` runs on `db` **before** `db.transaction`, and
nothing locks the owner rows. Two owners deactivating each other concurrently both see
"another active owner exists", both pass, and the organization is left with zero
active owners. Reproduced on the first try and on 8 reruns. `setUserRole` demoting the
other owner has the same read-then-write shape; it is **untested**.

**Impact.** An organization can lock itself out of every owner-only screen (cost,
invoices, users) with no in-app recovery. Needs two owners acting at the same moment,
so rare, but the result is severe.

**Suggested fix.** Move the owner count inside the transaction and take a lock first:
`SELECT ... FOR UPDATE` on the organization's active owner rows (or on the organization
row), then count, then update. Apply the same to `setUserRole`. This repo has a
documented gap-lock deadlock on the count-line upsert
(`truestock-countline-gap-lock-deadlock` memory), so re-run the concurrency test
several times after the change and watch for deadlocks, not only for the guard holding.
Add the equivalent `setUserRole` test while there.

**Pinned by:** group E (`test.failing` on the race, beside a control that proves the
guard works serially).

## 6. The owner's inline cost cell never shows "Saved"

**Where:** `EditableProductCell` (and the memoized `columns` array) in
`components/office/catalog-table.tsx`.

**What happens.** Editing a cost and pressing Enter saves correctly (the value is in
the database and survives a reload), but the status goes `Unsaved` → `Saving…` →
nothing. The cell is designed to show `Saved` for two seconds. The `<input>` is a
different DOM node after the save.

**Impact.** The owner gets no confirmation that a cost edit landed, on the one screen
where a silently lost cost edit matters. The data is fine; the trust signal is missing.

**Probable cause (by reading; not proven by a fix).** A successful save calls
`patchRow`, which changes `rows`, which re-derives `visibleIds`, which rebuilds the
memoized `columns`. Every cell renderer is then a new function; TanStack's `flexRender`
mounts a function as a component, so React sees a new component type and **remounts**
the cell, discarding its `saved` state.

**Suggested fix.** Either keep the `saved` status where a remount cannot lose it (state
held by the table, keyed by product id and field), or make the column definitions
stable so `rows` changing no longer rebuilds them (pass the changing data through a
ref or context, not through the `columns` memo's dependencies). Prove the cause first:
if the stable-columns change alone makes the probe go red, the diagnosis is right.

**Pinned by:** `e2e/specs/office-catalog.e2e.ts`, "KNOWN DEFECT: the inline cost cell
never shows its 'Saved' confirmation". It first proves the save reached the database,
then asserts "Saved" never appears. It is deliberately not `test.fail()`, which would
count any failure (a changed selector, a timeout) as the expected one.

---

## Working a defect

1. Run the pin and confirm it is green today:
   `bun run test:docker tests/known-defects.test.ts` (defects 1–5), or the Playwright
   spec (defect 6; see `e2e/README.md` for the rig).
2. Fix the code. The pin goes **red on purpose**; that is the signal the defect is gone.
3. Delete `.failing` from the now-passing test (or flip the e2e assertion), keep the
   control beside it, and rename if the title describes the defect. It is now a
   permanent regression guard.
4. Update `docs/open-items.md` #41, and this file: strike the entry through and note
   the date and the commit.
5. Mutation-check the fix: revert it and confirm the test goes red again. A green test
   whose guarded change was never reverted proves nothing about that change.
