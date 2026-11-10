# Gate 1 — Product: retire a vendor

No databases, schemas, endpoints or file names in this document. That is Gate 2.

**Gate 1 APPROVED 2026-11-09. Amended 2026-11-09 (during Gate 3):** the owner
reversed the treatment of invoices already in review when their vendor is
retired. They are no longer held; they complete normally (Behaviour point 6,
Owner decision 4).

---

## Problem

**From the 2026-11-08 QA:** vendors can be created and edited, but there is no
way to say "we don't buy from them any more." A supplier the bar has dropped:

- stays in every place a vendor is chosen — the product form, the "assign
  vendor to selected products" bar, and invoice review;
- keeps its own block on the reorder list for every product still pointing at
  it, so the order sheet tells the manager to call a supplier the bar no longer
  uses;
- cannot be deleted, and must not be — past invoices, remembered invoice line
  names and old reorder lists all name it, and deleting it would orphan that
  history.

The quiet failure to prevent is the same one the rest of the app guards
against: a manager picks the dropped supplier from a list out of habit, a
product's reorder line goes to the wrong place, and nothing looks wrong until
an order never arrives. Hiding the vendor from the lists is not enough on its
own — a screen opened before the vendor was retired still offers it, and that
choice must be refused when it is saved, not silently accepted.

**Owner decision (2026-11-09):** a retired vendor's name stays taken. Nobody can
create a new vendor with the same name, so history always points at one
supplier.

---

## Success metric

**One number:**

> **Zero products, new invoices or reorder lines assigned to a retired vendor
> after it was retired** — except what was already assigned before, which is
> kept and shown as needing a new vendor.

Measured by: a check run against the database after the feature ships (and in
an automated test that runs on every change): any assignment to a retired
vendor dated after its retirement is a failure (an invoice already in review
when the vendor was retired is not a new assignment). The automated test also proves
that a screen opened *before* retirement cannot save the retired vendor.

**Supporting checks, each pass/fail:**

- **Two taps to retire, from the vendors screen.** Retire → Confirm, the same
  pattern locations use. No modal.
- **The confirm says what is affected.** "12 products still use this vendor —
  they will need a new one." The manager knows before confirming.
- **Nothing disappears from history.** Past invoices, audit packets and closed
  counts still show the vendor's name.
- **Coming back is deliberate.** A retired vendor shows a Reactivate button that
  asks for confirmation (Reactivate → Confirm reactivate?) and says what will
  change before it does anything. Reactivate is required by the decision
  above: without it, a supplier the bar returns to could never be entered
  again, because its name is taken.

---

## Announcement

> **You can now retire a vendor.** When the bar stops buying from a supplier,
> tap Retire on the vendors screen and confirm. It drops out of every vendor
> list — the product form, bulk assign and invoice upload — and Truestock
> refuses to assign anything new to it, even from a screen that was already
> open. Products that still point at it show up on the reorder list under
> **"Retired vendor — choose a new one"**, so nothing is ordered from the wrong
> place. Its history stays intact: old invoices and audit packets still name
> it, invoices already in review can still be reviewed and approved (new
> invoices from it can't be uploaded), and its name stays reserved, so if you ever go back to that supplier,
> tap Reactivate.

---

## Behaviour, in plain terms

1. **Who can retire:** owner and manager — the same people who can create and
   edit vendors today.
2. **What retiring does:** marks the vendor retired. Nothing is deleted.
3. **Lists:** a retired vendor is left out of every place a vendor is chosen.
   On the vendors screen it stays visible with a **Retired** badge and a
   **Reactivate** button, and the header reads "4 active, 1 retired".
4. **Saving a retired vendor is refused**, with a message that names it:
   *"Southern Glazer's is retired. Choose another vendor, or reactivate it on
   the Vendors screen."* This covers assigning it to one product, to many at
   once, and uploading a new invoice that names it.
5. **Products already assigned keep the link** (the history is real) but are
   flagged: the reorder list groups them under "Retired vendor — choose a new
   one", and the catalog shows the vendor name with a Retired marker. The
   manager reassigns them with the existing bulk-assign bar.
6. **Invoices:** past invoices from a retired vendor stay readable, approved
   and in audit packets. An invoice already in review when its vendor is
   retired is **not held**: it can be submitted and approved normally, and its
   costs post (the goods were delivered; the prices are real). The review screen
   shows an informational note — *"{name} is retired. This invoice can still be
   reviewed and approved; new invoices from this vendor can't be uploaded."* —
   that blocks nothing. Rejecting is unchanged. A *new* invoice upload naming a
   retired vendor is refused with the message in point 4, and the upload picker
   lists active vendors only.
7. **Name stays taken:** creating or renaming a vendor to a retired vendor's
   name is refused with *"A retired vendor already uses this name — reactivate
   it instead."*
8. **Reactivate, with a confirmation** (owner request 2026-11-09). Same two-tap
   pattern as Retire, no modal: the first tap arms the row and states the
   consequence — *"Reactivate Old Town Wine Co.? It will appear in every vendor
   list again, and 3 products assigned to it will stop being flagged."* — with
   Cancel beside **Confirm reactivate?**. Only the second tap reactivates. The
   vendor then returns to every list and its products stop being flagged.

---

## Owner decisions (2026-11-09, at this gate)

1. **Retiring is allowed while products still use the vendor.** Those products
   keep the link and are flagged (point 5), rather than the retire being
   refused until every product is reassigned.
2. **Reactivate is included.** Required because the name stays taken.
3. **Reactivate asks for confirmation** before it acts — two taps, stating the
   consequence, the same no-modal pattern as Retire (point 8).
4. **Invoices already in review are not held** (added 2026-11-09, during Gate 3).
   When a vendor is retired, an invoice already in review can still be
   submitted and approved normally and its costs post: the goods were
   delivered and the prices are real. The review screen shows an informational
   note and blocks nothing. A new invoice upload naming a retired vendor is
   still refused. Rejecting is unchanged (point 6).

---

## Screens

- `mockups/vendors-screen.html` — the vendors list: an active row, a row with
  Retire armed showing the "12 products" warning, a retired row with
  Reactivate, a retired row with Reactivate armed showing its confirmation,
  and the refusal for a taken name.
- `mockups/reorder-and-refusal.html` — the reorder list's "Retired vendor —
  choose a new one" block, and the refusal shown when a screen opened before
  retirement tries to save the retired vendor.
