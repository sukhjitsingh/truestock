---
name: locations-row-click-a11y-fix
description: locations-table.tsx's and vendors-list.tsx's row-level onClick were both replaced with a real Edit button (2026-08-12); use this as the template if the pattern turns up again
metadata:
  type: project
---

`components/office/locations-table.tsx` used to open the edit form via an
`onClick` on the `<tr>` itself — `tabIndex: -1`, no `role`, no `aria-label`,
discoverable only by hovering. Fixed in commit `957bfeb`
(`fix(office): give locations an Edit button instead of a row-level click`):

- Row onClick and its `cursor-pointer`/hover classes removed entirely (not
  just supplemented) — the mis-click hazard is gone by construction.
- A real `Edit` button (`Button variant="outline" size="tap"`, same as the
  existing `Retire` button) added to the actions cell.
- `Edit` renders for retired rows too — only `Retire` stays conditional on
  `loc.active`. The file's own comment already says renaming a retired
  location is allowed.
- `LocationEditForm`'s heading changed from the generic "Edit location" to
  `Edit ${location.name}` — a form that names its own subject.
- `scripts/verify-browser.mjs` updated to click the row's `Edit` button
  instead of the row; kept the prefilled-name assertion + `throw` that
  guards against a mis-click landing on the wrong row (this is what caught a
  real near-miss on "Speed Rail" during the original verification — see
  `docs/plans/phase-1-to-1.5/00-status.md`, "Finding: the locations edit
  affordance is invisible and unlabelled").

**`components/office/vendors-list.tsx` had the exact same anti-pattern** — it
is in fact where it came from, since `locations-table.tsx` was modelled on it.
Filed as open item 27 and **fixed the same day in `5fd5eeb`** with the identical
three changes, plus `vendor-edit-form.tsx`'s heading. Two browser checks were
added for it (the form must be editing the row whose Edit was clicked, and the
heading must contain that vendor's name), taking `verify:browser` from 28 to 30.

The fix shape, if this pattern turns up anywhere else: replace the row click
with an explicit button — do **not** bolt a `role`/`tabIndex`/`aria-label` onto
the `<tr>`, because that keeps the mis-click hazard and only fixes the
accessibility half. `users-list.tsx` and `catalog-table.tsx` were checked and
are clean.
