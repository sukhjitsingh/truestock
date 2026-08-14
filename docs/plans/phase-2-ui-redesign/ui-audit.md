# UI audit — prototypes and design tokens

**Phase:** ROADMAP Phase 2 (UI redesign).
**Scope:** all 11 files in `prototypes/` (4,851 lines) plus `app/globals.css`.
**Date:** 2026-08-13.
**Status:** findings only. Nothing here is fixed yet — fixes land after the PRD is approved.

Line references are `file:line` against the files as they stand today.

---

## How to read this

Every defect carries a tag:

- **`[proto]`** — exists only in `prototypes/`. Cheap to fix, no product risk.
- **`[app]`** — the same defect, or its cause, exists in the shipped app under
  `app/` or `components/`. These are the ones that matter.
- **`[token]`** — the defect is in `app/globals.css` or `docs/design-system.md`
  itself, so it propagates to everything downstream.

Severity is ranked by this project's own standard: **can it produce a number that
is plausible and wrong, or an action the user did not intend?** Cosmetic drift
ranks below that no matter how widespread.

---

## P0 — can cause a wrong action or a wrong number

### P0.1 `[token]` The chart palette *is* the status palette

`app/globals.css` defines, in both themes:

| Token | Light | Status token with the identical value |
|---|---|---|
| `--chart-2` | `#1f7a3d` | `--success` |
| `--chart-3` | `#92600a` | `--warning` |
| `--chart-4` | `#b8305a` | `--negative` |

and in `.dark`: `--chart-2: #6fcf8e` = `--success`, `--chart-3: #f0b429` =
`--warning`, `--chart-4: #f0718a` = `--negative`.

`docs/design-system.md` §3 reserves green/amber/red **exclusively** for stock and
count-session status, and says explicitly: *"don't cross the two."* The chart
tokens cross them. A category breakdown drawn in `--chart-1..5` puts a green
segment and a red segment on a bar-inventory dashboard, where green already means
*in stock* and red already means *86'd*. The reader is not wrong to interpret it
that way — the palette taught them to.

This is the project's signature failure mode: it renders fine, it looks right, and
it means something other than what it says. **No chart may be drawn until the
series palette is re-derived.** Fix is a distinct, hue-separated categorical ramp
that does not reuse any status hue, with contrast computed rather than eyeballed.

### P0.2 `[proto]` Whole card rows wrapped in an anchor — the banned pattern, in card form

`prototypes/count-scan.html:269-285` and `:287-303`:

```html
<a href="count-fill-tenths.html?product=tanqueray" style="display:block">
  <article class="card-row"> … <h3>Tanqueray London Dry Gin</h3> … </article>
</a>
```

AGENTS.md bans the row itself as the edit affordance. This is that pattern with an
`<a>` instead of a `<tr onClick>`, and it carries the same three defects plus one
more: the accessible name concatenates the heading, subtitle, status pill,
quantity and dollar value into a single announcement — *"Tanqueray London Dry Gin
750ml · Back Bar 1 open bottle · 60% full 0.6 units $11.10, link"* — and an `<h3>`
is nested inside a link, so the heading text becomes link text.

The back office is **clean** on this: zero `<tr onclick>`, zero `role="row"` with
handlers, zero `<tr>` with `cursor:pointer` across all 11 files. The ban held
where it was written down. It was never written down for cards.

### P0.3 `[proto]` Chevrons on rows that do nothing

`count-scan.html:209, 224, 243, 258` render a `>` chevron inside four card rows
with no link, no button and no handler. Only two rows on that screen (`:275`,
`:293`) actually navigate — with an identical chevron. Same visual affordance,
opposite behaviour, on one screen.

`count-session.html:219-289` then renders six visually identical `.card-row`
elements with no chevron and no link at all. A counter learns on one screen that
rows are tappable and finds they are not on the next.

Root cause is `[token]`: `docs/design-system.md`'s canonical card row
(`prototypes/design-system.html:447, 466`) includes a chevron but documents no
interaction contract, so every consumer guessed.

### P0.4 `[proto]` Focus made invisible on the most-used input in the product

`count-scan.html:123`:

```css
.search-scan input:focus { outline: none; }
```

No border change, no box-shadow, no substitute. This is the search-and-scan field
— the control the counting loop runs through. `docs/design-system.md` §7 sets a
global `:focus-visible` outline as a floor and says don't remove it.

`scan-to-enroll.html:68` also sets `outline:none` but *does* substitute
`border-color: var(--ring)` plus a 2px inset ring. So the same component has two
different focus treatments across two screens, one of which has none.

### P0.5 `[proto]` The role-gated column is CSS-hidden, and the annotation claims it isn't

`office-counts-list.html:291` annotates: *"a second header cell and a second
per-row branch, **not a CSS-hidden column**."*

`office-counts-list.html:267`:

```js
thValue.style.display = ownerMode ? "" : "none";
```

The `<th>` at `:199` is hidden with CSS. The `<td>` at `:252` *is* branch-omitted.
So the header and the body use two different strategies, and the documentation
describes the one that wasn't used.

This matters more than a prototype bug normally would, because it is the exact
pattern `docs/design-system.md` calls a binding rule and `docs/design-reference.md`
B5 restates: columns are **absent** from a manager's table, never hidden or
filtered at render.

**The shipped app gets this right** — `components/office/catalog-table.tsx` builds
the column set per role, and there is a committed browser check asserting a
manager's DOM contains no `Unit cost for` string at all. `office-catalog.html`
also gets it right, using two separate `<table>` elements (`:473`, `:496`). Only
this one prototype regressed, and its annotation hides the regression.

### P0.6 `[proto]` No `<form>`, no `method="post"`, anywhere

Grep for `method=` across all 11 files: **zero hits.** Grep for `<form`: **one
hit** — `scan-to-enroll.html:130`, which is `<form id="enrollForm"
onsubmit="return false">`: no `method`, no `action`. Its submit button
(`#saveBtn`, `:183`) sits *outside* the form in `.bottom-bar` with no `form=`
attribute and no `type`, so it cannot submit the form it belongs to.

`office-product-edit.html` has **no `<form>` element at all** despite 12
inputs/selects (`:254-350`) and two "Save changes" buttons (`:245`, `:403`). Same
for `count-sealed-qty.html:163,172` and the catalog search at
`office-catalog.html:444`.

AGENTS.md's rule exists because a form with no method defaults to **GET** and
serialises every field into the query string if hydration hasn't attached — which
is how a plaintext password reached the access log on the login form. The
prototypes are static mockups so nothing leaks *today*; the risk is that this
shape gets copied into React.

### P0.7 `[proto]` ~25 focusable controls that announce as interactive and do nothing

`count-session.html:163, 166`; `count-fill-tenths.html:154, 157`;
`count-sealed-qty.html:133, 136`; `count-scan.html:174, 311`;
`office-catalog.html:367, 383, 416, 420, 423` (rail create/expand/collapse/more/
refresh), `:434-437` (view tabs — `aria-selected` never changes), `:446-452`
(filter pills — `aria-pressed` never changes); `office-counts-list.html:182-185`
(filter pills); and every `.sort` span (see P1.2).

### P0.8 `[proto]` Row menu reports a permanently-collapsed state and gets clipped

`office-catalog.html:589` hardcodes `aria-expanded="false"`; `toggleMenu`
(`:661-666`) never updates it. The popover has no arrow-key navigation, no Escape
handler, and never moves focus in or restores it on close, despite carrying
`role="menu"` (`:592-608`) with a mix of `<a role="menuitem">` and `<button
role="menuitem">`.

It is also `position: absolute` inside a 57px row while `.table-card` sets
`overflow: hidden` (`:293`) — **the 190px menu is clipped on the last rows of
every page**, which is where the row actions become unreachable rather than merely
awkward.

### P0.9 `[proto]` Closed bottom sheet stays focusable

`count-scan.html:324-339` is `role="dialog"` with no `aria-modal`, no focus trap
and no Escape handler; close is click-only (`:466-467`). It is hidden with
`transform: translateY(100%)` (`:135`) and nothing else — no `inert`, no
`aria-hidden`, no `display:none` — so its six location buttons remain in the tab
order while the sheet is closed.

Given AGENTS.md's rule that **the active location is locked per leg because a
wrong active location fails silently**, a tabbable off-screen location switcher is
precisely the failure that rule exists to prevent.

---

## P1 — the table system

There are **10 `<table>` elements** across 5 prototypes
(`office-catalog.html:474, 497`; `office-counts-list.html:189`;
`office-count-summary.html:324`; `office-reorder.html:214, 233, 252, 270`;
`office-product-edit.html:358`).

### P1.1 `[token]` The design system defines no table at all

`prototypes/design-system.html` defines 9 component classes: status pill, card
row, detail header, bottom action bar, search+scan field, stepper, status
timeline, bottom tab bar, form field. It defines **no table, no pagination, no
sort control, no empty state, no avatar, no filter pill, no view tab, no
segmented control, no stepper, no banner, no sheet, no popover, no tooltip, no
toast, no hover state, no zebra, no chip, no null-value treatment.**

Every one of those was independently reinvented across 5–10 prototypes with
different values. **This is the single largest root cause in this document** —
almost everything in P1 and P2 is downstream of it.

### P1.2 `[proto]` Sort is decorative and keyboard-unreachable

`office-catalog.html:477-483`, `office-counts-list.html:192-198`:

```html
<th>Product <span class="sort" aria-hidden="true">⇅</span></th>
```

A `<span>`, so not focusable or activatable. `aria-hidden="true"`, so invisible to
assistive tech. `.sort { cursor: pointer }` (`office-catalog.html:302`), so it
signals interactivity that does not exist — no click handler is bound anywhere. No
`aria-sort` on any `<th>`.

It is also applied inconsistently: catalog sorts Product/Category/Vendor/Unit
cost/Stock but not Size or Case; counts-list sorts Count/Started/Closed but not
Type/Status/Opened by/Closed by. `office-count-summary.html:327`,
`office-reorder.html:215` and `office-product-edit.html:361-365` have no sort
affordance at all.

**`[app]`** — no table in the shipped app has sorting either. `@tanstack/react-table
^8.21.3` is installed and imported by nothing.

### P1.3 `[proto]` Pagination is labelled and not implemented

`office-catalog.html:489-492` and `:511-514` render "Showing 19 of 97 products"
and then offer no next/prev, no page-size selector, no page numbers, no load-more.
The other 78 products are unreachable. `office-counts-list.html`,
`office-count-summary.html` and `office-reorder.html` have no footer at all — not
even a row count.

**`[app]`** — `/office/catalog` reads with a hard `limit: 100` server-side and the
catalog holds 101 products, 99 active. Open-item #14 already covers the aggregate
half of this; the pagination half is new here.

### P1.4 `[proto]` No table has an accessible name or column scope

Across all 11 files: **zero** `scope=` attributes, **zero** `<caption>` elements,
**zero** `aria-label`/`aria-describedby` on any `<table>`. Also zero zebra
striping and zero empty states — no `<tbody>` anywhere renders a no-rows message.

Two `<th>` cells are entirely empty with no accessible name
(`office-counts-list.html:200`, `office-product-edit.html:365`), and the hand-rolled
sr-only spans at `office-catalog.html:484, 506` omit `clip`/`clip-path`/
`white-space:nowrap`, so they can be focused into view and still affect layout.

### P1.5 `[proto]` No row-level Edit button on any table

- `office-catalog.html:586-611` — Edit is the first item inside a popover behind a
  32px `⋯` button. Two interactions and a hidden menu for the primary row action.
- `office-counts-list.html:230-236` — no Edit; text links only, or the plain string
  `View only` for closed rows.
- `office-count-summary.html:359-366`, `office-reorder.html:217-219` — no row
  actions of any kind.
- `office-product-edit.html:369-379` — inline inputs, but the only button is a
  **30px** destructive Remove (`:378`). No Edit, no per-row Save, and `Primary`
  (`:377`) is static text with no control to change which barcode is primary.

AGENTS.md requires an explicit Edit **button** naming its subject in the heading.
Neither the popover nor a bare text link satisfies that.

**`[app]`** — `locations-table.tsx` and `vendors-list.tsx` were fixed on
2026-08-12 and now carry real Edit buttons. The prototypes still show the old
shape.

### P1.6 `[proto]` Numeric alignment

| Table | Correct | Defect |
|---|---|---|
| `office-catalog.html` | `Unit cost` right-aligned (`:649`) | **Stock** `"22 units"` left in a 170px column (`:565, 568, 575`); **Size** (`:646`); **Case** (`:647`) |
| `office-counts-list.html` | `Total value` (`:252`) | `Started`/`Closed` get `tabular-nums` but **no `.num`** (`:249, 251`) → tabular yet left-aligned |
| `office-count-summary.html` | Units, Extended value ✔ | — |
| `office-reorder.html` | all 4 numeric columns ✔ | — |
| `office-product-edit.html` | — | barcode `080480000341` in a plain left-aligned text input, no `tabular-nums` (`:370`) |

Also: `office-counts-list.html:253` applies `.num` (right-align) to the **actions**
column, conflating numeric alignment with an action cell. And `.num` sets only
`text-align: right` — it never sets `font-variant-numeric`, so tabular figures
depend entirely on the body-level rule. `docs/design-system.md` §4 says
`tabular-nums` is global and never opted into per component, which is right; the
risk is that `.num` reads as if it guarantees something it does not.

### P1.7 `[proto]` Truncation without a tooltip, and one table with no truncation at all

`office-catalog.html:619-620` and `:641` apply `.truncate` with **no `title`
attribute**, inside `.cell-product { max-width: 320px }` (`:314`). `St-Germain
Elderflower Liqueur` and `Young's Market Co. of AZ` clip with no way to read the
full value.

`office-count-summary.html:361` has the opposite problem — product names are not
truncated at all, so they wrap and break the fixed 48px row height.

### P1.8 `[proto]` Rows are cramped, and one empty state is enormous

`office-catalog.html:303` fixes `tbody tr { height: 57px }` with `td { padding: 0
.875rem }` (`:307`) — **zero vertical padding**. But `.stock-cell` (`:650`) renders
a text line *plus* a 4px bar with 5px margin, and `.cell-product` (`:314`) is a
40px glyph plus two text lines. Both two-line cells sit in a 57px box with ~4px of
clearance.

Meanwhile `office-reorder.html:94` sets `.empty-state { padding: 4rem 2rem }` —
64px, when nothing else in the system exceeds 32px.

### P1.9 `[proto]` Four duplicated table headers that cannot align

`office-reorder.html:215, 234, 253, 271` repeat an identical
`Product / On hand / Par / Reorder point / Suggested order` header per vendor
group, each with `style="width:40%"` hardcoded. Four independently-sized tables
mean the columns do not line up across vendor groups — on a screen whose whole job
is reading down a column of quantities.

### P1.10 `[proto]` A designed empty state that was never wired

`office-product-edit.html:162` defines `.empty-barcodes` (dashed border, "no
barcodes" treatment) and the markup never uses it. Dead CSS for the one empty
state anyone bothered to design.

---

## P2 — identity, and system integrity

### P2.1 `[proto]` No user identity anywhere in the counting app

No avatar, no initials, no account link, no sign-out on any of `count-scan.html`,
`count-fill-tenths.html`, `count-sealed-qty.html`, `count-session.html`,
`scan-to-enroll.html`. The only "who am I" signal is the **prototype-only** role
`<select>` (`count-scan.html:159-165` and four equivalents), which
`docs/design-system.md` explicitly forbids from ever shipping.

The design system defines an Account bottom-tab with a person glyph
(`design-system.html:619-622`) and **zero prototypes render a bottom tab bar** —
`count-scan.html:345` documents dropping it. So the one profile affordance the
system defines has no home.

**`[app]`** — the shipped app is fine here: `components/count/tab-bar.tsx` renders
the 4-tab bar and `/count/account` exists with name, email, role and sign-out. The
prototypes are behind the app, not ahead of it. On a shared bar phone with 12-hour
sessions, "which account is recording this count" is not cosmetic.

### P2.2 `[proto]` The back-office avatar is a decorative div that looks like a control

`office-catalog.html:409`, `office-counts-list.html:159`,
`office-count-summary.html:170`, `office-reorder.html:157`,
`office-product-edit.html:218` — all five are:

```html
<div class="avatar-tile" aria-hidden="true">JM</div>
```

Not a `<button>`, not focusable, and `aria-hidden="true"` removes the only
user-identity element on the screen from the accessibility tree entirely. No menu,
no sign-out, no "signed in as". It is also **34×34px** (`office-catalog.html:225`)
— on no scale: not 32, not the 44px `tap-min`.

### P2.3 `[proto]` The topbar loses three controls on 4 of 5 screens

`office-catalog.html:397-410` has global search, notifications with an unread dot,
messages and avatar. `office-counts-list.html:157-160`,
`office-count-summary.html:168-171`, `office-reorder.html:155-158` and
`office-product-edit.html:211-220` have **only** breadcrumb + avatar.

### P2.4 `[proto]` `.tabular` is used 14 times and defined nowhere

`count-scan.html:214, 229, 248, 281`; `count-session.html:201, 226, 238, 262, 286,
440`; `count-fill-tenths.html:389`; `count-sealed-qty.html:182, 186, 276`.

Only `.tabular-nums` exists, and only in the 6 back-office/design-system files.
The numbers render tabular anyway because `body { font-variant-numeric:
tabular-nums }` applies globally. **It works by accident**, and the class is a
no-op that will be carried into React as a Tailwind class name that does not
exist — where it will also silently do nothing.

### P2.5 `[proto]` Status colours spent on vendor and person identity

`office-catalog.html:528-546` sets `vendorColor` to `#2563eb` (= `--accent`),
`#92600a` (= `--warning`), `#1f7a3d` (= `--success`), `#b8305a` (= `--negative`)
across 19 data rows. `office-counts-list.html:212-218` uses the same four hexes for
`openedColor`/`closedColor`. `office-reorder.html:208, 227, 246, 264` inlines them
as `style="background:#b8305a"` and friends.

Two defects in one: raw hex bypassing the tokens, and **the four reserved status
colours spent on identity** — contradicting the annotation in the same file
(`office-catalog.html:705`: *"green/amber/red are reserved for stock/count
status"*). Sizes also differ: 22px in catalog and counts-list, 28px in reorder,
with `color:#fff` hardcoded instead of `--primary-foreground`.

This is P0.1's defect wearing different clothes — the same collision, arrived at
independently.

### P2.6 `[token]` Letter-spacing: the back office systematically ships the wrong value

The token is **`.06em`** (`design-system.html:251, 253`).

| Value | Occurrences | Where |
|---|---|---|
| `.06em` | 31 | counting app + design system — correct |
| **`.04em`** | **20** | the **entire back office** — `.attn-pill`, `.status-pill` (×3 files), `.field label`, `.headline-label`, `.summary-card .label`, `.barcode-table th`; plus counting-app `.count-id`, `.loc-pill`, `.quick-btn` |
| `.08em` | 9 | prototype chrome only |
| `.02em` | 2 | `.toggle-btn` (`design-system.html:278` — on the design-system page itself), `.bottom-hint` |
| `.05em` | 1 | `.mode-btn` (`count-sealed-qty.html:75`) |

The most-repeated token violation in the corpus.

### P2.7 `[token]` The two halves of the system are structurally incompatible

The counting app declares spacing as **real CSS custom properties** —
`--card-gap --card-pad --bar-pad --section-gap --tap-min --tap-primary`
(`count-scan.html:16` and four equivalents). The design system and the entire back
office express the same concepts as **literal values inside utility classes**
(`design-system.html:150, 155-156, 203-206`). There is no single place to change
"card padding."

Same split on radius: the design system derives four radii from `--radius: 1rem`
via `calc()`; all 5 counting files hardcode `--radius-sm:12px … --radius-xl:20px`
and **omit `--radius` entirely**. Numerically identical today — so changing the
base radius silently updates the back office and not the counting app.

And on `rounded-full`: **9999px** in the design system and back office
(`design-system.html:184`), **999px** throughout the counting app.

And on the font stack: `--font-sans: ui-sans-serif, system-ui, -apple-system,
"Segoe UI", sans-serif` in the design system and all back-office files; all 5
counting files hardcode `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
Inter, sans-serif` with **no `--font-sans` variable declared at all** — a
different first choice, and `Inter`, which appears nowhere else.

**`[app]`** — `app/globals.css` is the healthy version of this: one `@theme`
block, named spacing tokens, the `calc()` radius chain. The prototypes diverged
from it, not the other way round. The fix is to regenerate the prototypes from the
real token file rather than to reconcile eleven copies.

### P2.8 `[token]` `--header` is dropped from 3 of 5 back-office prototypes

Present in `office-catalog.html:44-45` and `office-product-edit.html:33-34`.
**Absent** from `office-counts-list.html:13-29`,
`office-count-summary.html:13-29`, `office-reorder.html:13-28` — while
`office-catalog.html:22-24` describes the block as *"copied verbatim from
app/globals.css."* Three of the copies are not verbatim.

### P2.9 `[token]` The design-system page violates its own tokens

| Line | Violation |
|---|---|
| `:292-293` | `.ratio-pass{background:#e4f5e6;color:#1f7a3d}` / `.ratio-note{…#fdf0dc;#92600a}` — hardcoded **light-theme** hex instead of `var(--success-bg)`/`var(--success)`. **They do not respond to the theme toggle on the page whose purpose is demonstrating the theme toggle.** |
| `:513` vs `:523` | Two adjacent instances of one control: the first carries both `.border-input` *and* an inline `style="border:1px solid var(--input)"`; the second omits the class and keeps the inline style |
| `:535, 632, 637, 641` | `.border-input` exists (`:188`) and every input uses the inline style instead |
| `:555` | `class="… bg-muted" style="background:var(--border)"` — the class is silently overridden |
| `:322-323` | The page's own identity is `<strong style="font-size:0.9375rem">` + `<span style="font-size:0.8125rem">` — raw inline sizes where `.text-row-subtitle`/`.text-caption` exist |
| `:278` | `.toggle-btn` letter-spacing `.02em`, a value defined nowhere |

### P2.10 `[proto]` Invented type sizes, and two files that disagree about one class

**14px (`.875rem`) and 12px (`.75rem`) do not exist in the type scale**, and
between them they carry the entire back office: every `td`
(`office-catalog.html:307` and 3 more), all `.crumbs`, `.view-tab`,
`.breakdown-label`, `.comparison`, `.barcode-table td`, every `thead th`, `.chip`,
`.type-chip`, `.headline-label`, `.summary-card .label`, `.field .hint`,
`.avatar-tile`.

Weight drift on top: `.9375rem @ 700` where the token is 400 (`.section-title`,
`.vendor-name`, `.empty-state p`); `1.5rem @ 700` and `1.125rem @ 700` where the
token is 600.

And a direct contradiction: `.no-cost-note` is **13px** in `count-scan.html:111`
and **12px** in `count-session.html:113` — same class name, same component, two
files.

### P2.11 `[proto]` Vocabulary drift

Seven treatments for "value absent": `Not entered` · `Not set` · `Not valued yet` ·
`No par set` · `Unpriced` · `No cost on file — excluded from valuation` · `—`.
`docs/design-system.md` §8 is emphatic that a missing value must never read as
`$0.00`, and the app's `Money` component gets that right — but there is no agreed
*word* for the absence.

Sizes: `750ml` / `750ML` / `750 ml`; `Half Barrel` / `Half barrel` / `58,674 ML`;
`12oz Can` / `12 oz`; `1.75L Handle` / `1.75 L`. Three variables at once — space
before the unit, case of the unit, and Title vs sentence case for the noun.

Categories: `Draft Keg` (`scan-to-enroll.html:146-150`) vs `Draft`
(`office-catalog.html:629-635`, `office-product-edit.html:265-270`), in three
different orderings.

Locations: `Storeroom` vs `Storage`/`Cellar`; `Tap 1` vs `Tap Line 1` vs `Tap-3`.

Count ids: `#1246799` (7 digits) · `#1247` (4) · `#42`–`#48` (2).

Count types: `Spot` / `Full` / `Monthly close` / `Full count` / `FULL COUNT` /
`FULL`.

Filter pills use two incompatible mental models: facet-named
(`Category: Spirits`, `Vendor`, `Active status`) in `office-catalog.html:446-452`
versus value-named (`All statuses`, `Full counts`, `Spot counts`) in
`office-counts-list.html:182-185`.

### P2.12 `[proto]` Two incompatible conventions for uppercase labels

The design system writes labels in **sentence case in source** and lets
`text-transform: uppercase` do the work (`design-system.html:429-431, 495-496,
553-563, 631`).

The counting app writes **literal ALL CAPS in source on top of** the same CSS:
`count-scan.html:197` `JUST COUNTED`; `count-fill-tenths.html:163-165, 171, 207`
and its JS at `:301, 310`; `count-sealed-qty.html:142-144`;
`count-session.html:172` and its JS status map at `:320`.

`count-session.html:187, 208, 214` then uses sentence case for the *same*
`.text-label` component, so that file is internally inconsistent with the other
counting screens.

Consequence: copy cannot be changed in one place, and screen readers announce
shouted strings.

Table headers are sentence case everywhere except `office-product-edit.html:152`,
where `.barcode-table th` uppercases to `BARCODE / FORMAT / PACK LEVEL / PRIMARY`.

Annotations use Title Case for columns the UI writes in sentence case —
"Unit **C**ost column present" (`office-catalog.html:466, 469`) against the actual
header `Unit cost` (`:482`); same for "Total **V**alue"
(`office-counts-list.html:178, 291`) against `Total value` (`:199`).

### P2.13 `[proto]` Spacing values off any grid

**Missing literal spaces between words: none.** A grep for `</span>[A-Za-z]`,
`[a-z]<span` and unspaced `&middot;` found zero across all 11 files.

But three places substitute flex `gap` for real word spacing, so the DOM text is
unspaced and copy-paste yields run-together strings:

- `office-counts-list.html:227` → `<span>JM</span>Jordan M.` — copies as `JMJordan M.`
- `office-catalog.html:641` → `<span>SG</span>Southern Glazer's`
- `office-catalog.html:568, 576` → `'· Out'` spaced only by `.stock-line{gap:.375rem}`

Off-grid values, none derived from a token: `.3125rem` (5px), `.1875rem` (3px),
`.0625rem` (1px), `.5625rem` (9px). Table rows come in three heights — 57px, 48px,
52px — and three cell paddings. Card padding has **five** values across
`.section-card`, `.headline-card`, `.summary-card`, `.vendor-group-header` and
`.p-card-pad`. Page content padding differs on every one of the five back-office
screens. Counting-app gaps use 3/6/10/14/18px where the tokens offer 12/16/24.

The detail header — one component — has three paddings: `pt-6 pb-8`
(`design-system.html:484`), `20px 16px 28px` (`count-session.html:58`),
`20px 16px 24px` (`count-fill-tenths.html:60`, `count-sealed-qty.html:59`). `20px`
is a token in neither system.

Scroll clearance for the fixed bottom bar is 96px in four counting files and
**110px** in `count-fill-tenths.html:45`, for an identical 88px bar.

---

## P3 — accessibility, remaining

### P3.1 `[proto]` Tap targets below the floor

Counting app, where 44px is a hard floor:

- `count-sealed-qty.html:74` `.mode-btn { min-height: 40px }` — **the ADD/SET
  switch**, which decides whether a save is additive or destructive. AGENTS.md
  gives this control its own working agreement.
- `count-scan.html:72` `.sync-pill` 32px.
- `scan-to-enroll.html:78` 22px checkbox (mitigated — the `<label>` at `:166` is
  associated and the row is 44px).

Back office, where 36px is the documented divergence (`docs/design-reference.md`
B6) — these fall below even that:

- `office-product-edit.html:158` `.icon-btn-sm` **30×30** — the *destructive*
  Remove-barcode button.
- `office-catalog.html:333` `.row-menu-btn` **32×32** — the sole entry point to
  every row action.
- `.vendor-dot`/`.person-dot` 22×22; `.avatar-tile` 34×34.

### P3.2 `[proto]` Focus-ring selector coverage differs per file

| File | Covered |
|---|---|
| `design-system.html:108-111` | `a, button, input, [role=button]` — no `select`, `[tabindex]`, `textarea` |
| `office-catalog.html:80-84` | full ✔ |
| `office-product-edit.html:60-61` | no `[tabindex]` |
| `office-counts-list.html:41`, `office-count-summary.html:41`, `office-reorder.html:41` | `a, button, input` only |
| all 5 counting files | bare `:focus-visible` — broadest ✔ |

`count-fill-tenths.html:181` puts `tabindex="0"` on the gauge; it is covered only
because that file happens to use the universal selector.

### P3.3 `[proto]` ARIA defects

- `role="slider"` with no `aria-valuetext` — announces "50", not "50 percent"
  (`count-fill-tenths.html:181`).
- Same slider has **no drag handlers** — only `click` and `ArrowUp`/`ArrowDown`
  (`:290-294`), no Home/End/PageUp/PageDown — while the annotation at `:230`
  claims a "tap/**drag** surface."
- `role="tablist"`/`role="tab"` with no `tabpanel` and no `aria-controls`
  (`office-catalog.html:433-437`), including `role="tab"` on an *add* action
  (`+ View`, `:437`); same misuse for a mode switch at
  `count-sealed-qty.html:149-151`.
- `<label>` with no `for=`, pointing at a chip group that is not a radiogroup and
  whose chips carry no `aria-checked`/`aria-pressed`
  (`scan-to-enroll.html:143, 155`).
- Required fields marked by `::after{content:" *"}` and colour only — no
  `required`, no `aria-required` (`scan-to-enroll.html:69`).
- Visible label ≠ accessible name, WCAG 2.5.3: visible "Cases", accessible "Number
  of cases" (`count-sealed-qty.html:160` vs `:163`; `:169` vs `:172`) — and the
  visible label is a `<span>`, not `<label for>`.
- Input with no label, no `aria-label`, no `id` (`office-product-edit.html:370`);
  two `<select>`s with no label at all (`:372, 375`).
- **No `aria-live` on the invariant-3 confirmation** (`count-scan.html:231-234`,
  shown by `:454-455`) — the "this incremented the existing line rather than
  adding a second row" message is the entire point of that screen, and it is
  announced to nobody. Only the sync pill has `aria-live` (`:181`).
- No `aria-live` on the reorder empty↔preview swap
  (`office-reorder.html:287-292`); its toggle has no `aria-pressed` and changes
  its label by mutating `btn.lastChild.textContent` (`:163, 291`).

### P3.4 `[proto]` Contrast — the palette is sound, the usage is not

The documented ratios (`design-system.html:340-378`) all pass: foreground 17.6:1,
muted-foreground 5.33:1, accent 5.17:1, destructive 5.41:1, status colours
4.7–5.0:1 on their tints, dark theme 5.6–18:1. **No token needs changing.**

The failures are all *usage* of `--border`, which `design-system.html:348`
explicitly flags as decorative at ~1.2:1 — and which then does structural work:
every table row separator (4 files), the table header underline, card outlines,
the dashed empty-barcodes box, the dashed `.more-link` border. WCAG 1.4.11 wants
3:1 for any boundary that carries meaning.

Worse on the dark header, where the border *is* the only edge:

- `.pill-outline` border `rgba(245,245,244,.25)` on `--header` #121317 ≈ **1.6:1**
  — `count-session.html:64`, `count-fill-tenths.html:66`,
  `count-sealed-qty.html:65`, and the token itself at `design-system.html:195`.
- `.icon-btn` border `rgba(245,245,244,.2)` ≈ **1.5:1** — on a 44px *button*
  (`count-session.html:60` and equivalents, `design-system.html:194`).
- `.gauge-grid div` border `rgba(245,245,244,.08)` ≈ **1.15:1**
  (`count-fill-tenths.html:85`) — and these gridlines are the only indication of
  where the tenth positions are on the fill slider.

Two more:

- `office-catalog.html:306` `tbody tr[data-inactive="true"] { opacity: 0.55 }`
  drops muted-foreground text to ~2.9:1.
- `.no-value` is muted-foreground **+ italic + 13px** (`office-catalog.html:331`
  and 2 more). It passes at 5.33:1 and is nonetheless the least legible text in
  the product — while carrying the most important semantic in it, the one
  §8 exists to protect: *not entered* is not *$0.00*.

### P3.5 `[proto]` Zoom blocked, motion unguarded, focus stolen

- `<meta name="viewport" content="width=1440">` in all five back-office files,
  with `body { min-width: 1280px }` — blocks zoom and reflow (WCAG 1.4.10).
- `animation: pulse` / `fadeout` and several transitions with **no
  `prefers-reduced-motion` guard** (`count-scan.html:75-76, 91, 113-114, 135`;
  `count-fill-tenths.html:83`). `docs/design-system.md` §7 says motion is
  functional only.
- `autofocus` on the enroll name input (`scan-to-enroll.html:133`) moves focus
  without user action. Worth a decision rather than a reflex fix: the 20-second
  enroll budget is a real constraint and autofocus buys time. The finding is that
  it is currently unconsidered, not that it is necessarily wrong.

### P3.6 `[proto]` Heading structure

- `count-scan.html` has **no `<h1>`** — the screen title is `<div class="t1">`
  (`:177-178`), and its only heading-level content is `<h3>` product names, so the
  document jumps from nothing to h3.
- `scan-to-enroll.html` has **no `<h1>`** — screen title is a `<span>` (`:118`).
- `count-session.html` `<h1>` (`:170`) → `<h3>` (`:222`), skipping h2.
- All back-office card section titles are `<div>`, not headings
  (`office-product-edit.html:251, 295, 321, 339, 356, 391`;
  `office-count-summary.html:110, 246, 287, 323`). The only real `<h2>` in the
  back office is inside an empty state.
- `design-system.html` puts its `<h2>`s at `:338, 360, 385` *before* its only
  `<h1>` at `:493` — a document-order inversion.

---

## What this changes about the plan

Three findings move work rather than just recording it:

1. **P1.1 is the root cause of most of P1 and P2.** Fixing eleven files
   individually would re-diverge. The table, empty state, pagination, avatar and
   null-value treatments have to be *defined once* in the design system before any
   prototype is touched.

2. **P2.7 means the prototypes should be regenerated from `app/globals.css`, not
   reconciled.** The real token file is the healthy one; the prototypes are eleven
   drifted copies of it.

3. **P0.1 blocks charting.** The series palette must be re-derived before any
   chart is specified in detail, which is why the web spec carries the palette and
   Phase 4 carries the charts.

One thing this audit did *not* find, worth stating because it was specifically
looked for: **the back office contains no row-click edit affordance**, and the
shipped app's role-gating is structurally correct in every place it was checked.
The two rules this project wrote down after real incidents are both holding.
