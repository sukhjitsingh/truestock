# UI spec — the back office (web)

Extends `docs/design-system.md` and `docs/design-reference.md` Part B.
`docs/plans/phase-2-ui-redesign/library-comparison.md`'s decisions are cited,
not re-opened: TanStack Table for tables, no library for meters/sparklines/
stat-tiles, visx deferred to Phase 4 for real charts.

**Theme: light, as rendered.** No `.dark` class on this route group. Full
daylight brightness is correct at a desk (`docs/design-system.md` §1). A
future dark toggle for the office is exactly "add/remove `.dark`" and no
component below should need to change to support it — this constrains every
spec in this document to token references, never hardcoded light-theme hex.

---

## 1. The TanStack Table contract

**Adopted for the catalog table first** (`catalog-table.tsx`, the only table
the library comparison names as the initial migration — 696 lines of
working, reviewed code with selection state and inline editing; the rest of
the tables follow this pattern once it is proven, not in parallel with it).

### Column sets are role-derived arrays, never `columnVisibility`

```ts
const columns = [
  productColumn,
  categoryColumn,
  onHandColumn,
  ...(canSeeCost ? [unitCostColumn] : []),
  ...(canManage ? [caseSizeColumn, editColumn] : []),
];
```

`columnVisibility` is available in TanStack's API and **must not be used** —
it keeps the column in the table model, so the wrongness is invisible until
someone reads the DOM. This is the exact defect P0.5 found in
`office-counts-list.html` (a `<th>` CSS-hidden, a `<td>` branch-omitted, two
different strategies in one file, and an annotation claiming the CSS-hidden
one wasn't used). The fix, stated once: **build the array conditionally, at
call time, per role.** `components/office/catalog-table.tsx` already gets
this right for its hand-rolled table (a committed check asserts a manager's
DOM contains no `Unit cost for` string); the TanStack migration must preserve
that same browser-level assertion against the new implementation, not merely
against the server payload.

### Sorting

Real `<button>` elements inside each sortable `<th>`, never a `<span
aria-hidden="true">⇅</span>` with `cursor: pointer` and no handler
(P1.2 — currently decorative on every prototype table and absent from every
shipped table). Each sortable header carries `aria-sort` (`"ascending"` /
`"descending"` / `"none"`), updated live. Every numeric and text column that
plausibly benefits from sorting gets it — not the inconsistent subset the
prototypes shipped (catalog sorts five of seven columns; counts-list three of
six).

### Pagination

Required — not optional polish. `/office/catalog` reads with a hard
`limit: 100` against a catalog that already holds 101 products, 99 active
(`STATE.md`); the dashboard aggregate-read fix (open-item #14, closed in
Phase 1.5) addressed the *count* tile, not the *table's* row cap. TanStack
Table's pagination row model handles this once the table is migrated;
until then, the hard limit stays a known gap this migration exists to close,
not a pre-existing condition to work around in the new table too.

### Filters

Per-column filters where the prototypes already imply a mental model
(category, vendor, active status) — but **one mental model, not two.** The
audit (P2.11) found facet-named filter pills in the catalog prototype
(`Category: Spirits`) and value-named pills in the counts-list prototype
(`Full counts`, `Spot counts`) — pick facet-named (`Category: Spirits`,
`Status: Active`) as the binding convention, since it scales to filters this
phase doesn't yet enumerate without inventing new copy patterns per screen.
Applied filter = filled solid (`bg-primary text-primary-foreground`);
unapplied = outline (`border-input`, no fill) — this is the reference's own
active-filter affordance (`docs/design-reference.md` Part B) and needs no
new token.

### Structural requirements on every table

- `scope="col"` on every `<th>`.
- An accessible table name — `<caption className="sr-only">` naming what the
  table is ("Catalog, 99 active products") — not silence, which is what all
  11 prototype files ship today (P1.4: zero `scope=`, zero `<caption>`, zero
  `aria-label` across the corpus).
- A real empty state in `<tbody>` when there are no rows — not an absent
  `<tbody>`, and see §9 below for what the empty state says.
- Hover: `hover:bg-muted` on `<tr>` — reuses the existing `--muted` token,
  no new color needed.
- Zebra, if used, alternates `bg-card` / `bg-muted` — same reuse, no new
  token.
- Right-aligned tabular numerics via a `.num` utility that sets
  `text-align: right` **only** — `font-variant-numeric: tabular-nums` is
  already global on `body` (`app/globals.css`) and must not be re-declared
  per-component; `.num`'s job is alignment, not tabular figures, and the
  audit (P1.6) is right to flag that treating it as guaranteeing tabular
  figures is a false assumption someone will eventually rely on. Apply `.num`
  to every genuinely numeric column (Stock, Unit cost, Size, Case,
  Started/Closed dates, Total value) and never to an actions column
  (`office-counts-list.html:253` did exactly this, conflating numeric
  alignment with an action cell — don't repeat it).
- Truncated cells (`.truncate`, product/vendor names) carry a `title`
  attribute with the untruncated value (P1.7 — currently absent everywhere
  truncation is applied). Cells that should not truncate at all (the
  count-summary product column, which currently has no truncation and breaks
  its fixed row height) get `max-width` + `.truncate` applied instead, not
  left to wrap.
- Row height: one token, applied everywhere — propose `--spacing-row-office:
  3.5625rem` (57px, matching the reference and the one shipped catalog table)
  in `app/globals.css`, ending the three-heights-three-paddings drift (P1.8:
  57px/48px/52px across prototypes). Cell padding is never zero vertical —
  use `py-2` (8px) minimum inside the row so two-line cells (the stock cell,
  the product-name-plus-SKU cell) get real clearance instead of the ~4px the
  audit measured.

### Row-level Edit button

Every table with an editable row gets an explicit `<button>` labelled `Edit`
(or with an icon + `aria-label="Edit {row name}"`), sized to at least the
back office's 36px floor (§10 below) — never the first item inside a hidden
overflow popover (`office-catalog.html`'s current shape: two interactions
and a hidden menu for the primary row action) and never a bare text link with
no button semantics. This is `AGENTS.md`'s rule, already correctly applied to
`locations-table.tsx` and `vendors-list.tsx` after the 2026-08-12 fix — this
phase extends the same pattern to the catalog table's migration and to any
table this phase touches. **The edit form's heading names its subject** —
`Edit Speed Rail`, never `Edit location` — restated because it is the exact
defect that nearly renamed the wrong location.

### Row overflow menus (where they remain, for non-Edit actions)

If a `⋯` overflow menu ships for secondary row actions (reorder-from-here,
audit stock, stock history — not Edit, which always gets its own button),
it must: track real open/closed state in `aria-expanded` (not hardcode
`"false"`, per P0.8); support Escape and arrow-key navigation inside
`role="menu"`; move focus in on open and restore it to the trigger on close;
and render inside a container whose `overflow` does not clip it —
`office-catalog.html`'s `.table-card { overflow: hidden }` clipping the menu
on the last rows of every page is the concrete failure this rule prevents.

---

## 2. The Part B shell — consistent across all five screens

`ui-audit.md` P2.3: the catalog prototype has global search, notifications,
messages, and avatar in its top bar; the other four (counts-list,
count-summary, reorder, product-edit) have only breadcrumb + avatar. **Every
office screen renders the same shell**, built once as a layout component, not
assembled per screen:

- **Top bar** — workspace name + breadcrumb, global search (or omitted
  everywhere at once if it isn't wired yet — never present on one screen and
  silently absent on four), notification/message icons only if they are
  functional (no decorative unread dot on a control with no notifications
  system behind it), and the account control (see §5).
- **Page header** — page title (`text-header-title`-equivalent for web
  density — see §11 on the invented-size cleanup this implies), an optional
  overflow `⋯`, and the primary action button, right-aligned.
- **View tabs**, where a screen has more than one view of the same data —
  active tab gets an underline + bold weight, never a color change (mirrors
  the counting app's tab-bar rule: selection is weight/underline, color stays
  reserved for status/brand).
- **Filter bar** — search input + per-column filter pills, per §1 above.

This is a shared layout, not five independent copies — the mechanism that
prevents the `--header` token being present in 2 of 5 prototype files and
absent from 3 (P2.8), and prevents the shell losing controls screen to
screen.

---

## 3. The stock cell

`docs/design-reference.md` Part B calls this the best idea in the reference
shot, and it stays exactly as specified there:

```
20 unit · Low
▰▱▱▱▱▱▱▱▱▱          ← 2px bar, width = on-hand ÷ par, color = status
```

**B1's rule, stated hard and binding:** `ProductPar.location_id` is nullable
and the MVP writes NULL rows only — most products currently have no par.
**No par means no bar and no status word.** Render the unit count alone
(`20 unit`) with nothing else in the cell. Never infer a denominator to make
the bar drawable, and never draw the bar at zero width as a stand-in for "no
data" — a bar at zero width and a bar for a genuinely empty product are
visually identical and mean opposite things.

Bar color is a status token (`--success`/`--warning`/`--negative`) — this is
the one place in the back office a status color legitimately drives width as
well as hue, and it must not be reused for anything else in the same table
(vendor/person identity explicitly excluded — see §7).

---

## 4. "As of count #N" — never "Current"

**B2's rule, binding:** on-hand is derived from the last *closed* count.
`reorderList()` already computes this and returns `asOfCountId`, `null` when
nothing has ever closed. Every screen that shows a derived on-hand or
valuation number carries an explicit `as of count #N · {date}` line next to
it — `text-caption text-muted-foreground`, no new token. **Never label
anything "Current."** When `asOfCountId` is `null`, the number does not
render at all — see §9's empty-state rule, which this is a specific instance
of.

---

## 5. Account control — real button, not a decorative div

`office-*.html`'s `.avatar-tile` (`<div class="avatar-tile"
aria-hidden="true">JM</div>`, 34×34px) is three defects in one component:
not focusable, not a `<button>`, and `aria-hidden="true"` removes the only
user-identity element on the screen from the accessibility tree — worse than
merely undersized. **Binding fix:** a real `<button>`, `aria-label="Account
menu"` (or "Signed in as {name}"), opening a menu with the signed-in user's
name, email, role, and sign-out — the same information `/count/account`
already surfaces on the mobile surface, so this is parity, not a new
information architecture decision. Sized to at least `size-tap-min` (44px) —
not the surrounding table's 32–36px allowance (B6), because this is a
persistent identity/navigation control, not a dense data-row control, and it
is the *only* place in the back office a user signs out.

**No color-coded identity.** §7 below removes per-user/per-vendor hue coding
entirely rather than trying to find it a safe palette; the account button's
initials render in `bg-muted text-foreground`, one neutral treatment, same as
every other identity tile in the product.

---

## 6. Null-value vocabulary — binding, per context

The audit found seven strings doing this job (`ui-audit.md` P2.11) and a
styling choice (`.no-value`: muted + italic + 13px) that makes the single
most important semantic in the product — *this number does not exist,
distinct from this number is zero* — the least legible text on screen
(P3.4). Both are fixed together, because the vocabulary fix is worthless if
the text stays illegible.

**There are two structurally different kinds of "no value here," and
collapsing them to one word would be wrong — the vocabulary is one word
*per* context, not one word overall:**

1. **Structurally not applicable.** A value that does not exist *for this
   row's type*, by design — `case_size` on a spirit (`AGENTS.md`: "a NULL
   case size on liquor never excludes a line... that is correct rather than
   missing data"). Render as **`—`** (em dash), `text-muted-foreground`, at
   whatever size the column's other cells use (never smaller). No italics.
   This is the one case where a plain dash is correct, because there is
   nothing to act on — the field will never be filled for this row.

2. **Applicable but not yet entered.** A value that *should* exist for this
   row eventually but hasn't been captured — an uncosted product's unit
   cost, a product with no par set, no vendor assigned, a wine with no
   producer named, a bottled beer missing its case size. Render as
   **`Not entered`**, `text-muted-foreground`, sized at `text-row-subtitle`
   (15px) or `text-body` (16px) — **never `text-caption` (13px), never
   italic.** This is the fix to P3.4: the string is information a manager
   or owner acts on (it is exactly what drives the "needs attention" view),
   so it must read at the same weight as the data around it, not recede
   below it. Replaces `Not set`, `Not valued yet`, `No par set`, `Unpriced`,
   and the sentence-length `No cost on file — excluded from valuation` —
   that reasoning belongs in a tooltip or the "needs attention" pill's own
   label (`REASON_LABEL`'s existing `"Needs cost"` / `"Needs par"` etc. in
   `catalog-table.tsx` is correct and unaffected — those are action pills,
   not inline cell values, and stay as they are).

3. **Role-gated (viewer not permitted to see it).** Unchanged from
   `docs/design-system.md` §8: the `Money` component renders nothing. No
   word, no dash, no styled box — an em dash here would leak "there is a
   number you can't see," which §8 already correctly refuses to do. This
   phase's job is applying that same contract to every *new* component this
   spec introduces (meter, stat tile), not changing the existing one.

4. **No count has ever closed** (the `asOfCountId === null` case from §4). Not
   a cell value at all — a full sentence in the empty-state pattern (§9):
   *"No count has closed yet — on-hand unknown."*

**`docs/design-system.md` §8 addition proposed:** a fourth numbered point
alongside the existing three, naming this distinction (not-applicable vs.
not-yet-entered vs. role-gated) as the general rule any future absent-value
component must classify itself against before choosing a treatment.

---

## 7. Vendor/person identity — no color coding

`ui-audit.md` P2.5 and `library-comparison.md`'s blocking-prerequisite
section describe the same defect from two angles: the prototypes spend the
four reserved status hexes (`--success`, `--warning`, `--negative`, plus
brand `--accent`) on vendor and person identity dots, in a file that
annotates the very rule it breaks (`office-catalog.html:705`: *"green/amber/
red are reserved for stock/count status"*).

**Binding fix, and it is a simplification rather than a new palette:**
vendor and person identity tiles do not get per-identity hue coding at all.
One neutral treatment — `bg-muted text-foreground`, initials, 22–28px inline
or 34px+ as an avatar — for every vendor and every person, everywhere.
`docs/design-system.md` §10 already forbids new colors outside the token set;
finding four-plus mutually-distinguishable, WCAG-safe, non-status,
non-brand hues for an open-ended number of vendors was never going to satisfy
that rule cheaply, and identity color-coding was not a stated requirement —
it was inherited from the Part B reference shot along with the orange accent
divergence B3 already rejected for the same collision reason. Removing it
resolves P2.5 without inventing anything.

---

## 8. Chart palette — blocking prerequisite, values owed

**No chart may be drawn — not even a stock-cell-adjacent sparkline that uses
a chart token — until this is resolved.** `app/globals.css` currently defines
`--chart-2` through `--chart-4` as byte-identical to `--success`, `--warning`,
and `--negative` in both themes (`library-comparison.md`'s table). Drawing
any categorical series in the current tokens puts a green wedge and a red
wedge on a bar-inventory dashboard where green already means *in stock* and
red already means *86'd* — the project's signature failure mode: it renders
fine, looks right, and means something other than what it says.

**The requirement**, not a proposed set of hex values — **none are invented
in this document, and that is a deliberate scope boundary, not an
oversight:**

- Five or more hues, mutually distinguishable from each other.
- Distinguishable in both `:root` (light) and `.dark`.
- Distinguishable under the common colour-vision deficiencies (protanopia,
  deuteranopia, tritanopia) — checked with a simulator, not eyeballed.
- Do not reuse, and do not read as adjacent to, the green/amber/red status
  hues (`--success`, `--warning`, `--negative`) in either theme.
- Contrast computed against **both** `--background` and `--card` in **both**
  themes, using the same WCAG relative-luminance method already applied to
  every value in `docs/design-system.md` §2's token tables — not eyeballed,
  per this project's own standard for every other color in the system.
- `--chart-1` may keep the existing brand blue (`#2563EB` light /
  `#60A5FA` dark) — it does not collide with status and is already computed.
  `--chart-2` through `--chart-5` need genuinely new values.
- Color is reinforcement, never the only channel — direct labels or a pattern
  fill differentiate series first; color confirms.

**This phase's deliverable on this item is the requirement and the
method above, not the five hex values.** Computing them is a follow-up pass
(a contrast-checking tool run against candidate hues) that should land before
Phase 4 starts building charts against these tokens — Phase 4 is the actual
consumer, and `library-comparison.md` already reserves visx for that phase
specifically because the catalog has no data worth charting yet (9 of 99
products costed, 0 par rows). Marking the values owed here rather than
inventing plausible-looking ones is the same discipline this project applies
everywhere else: a color that looks right and hasn't been checked is exactly
the failure class this project exists to avoid.

---

## 9. The meter / sparkline / stat-tile primitives

Per `library-comparison.md`: dependency-free `<div>` and inline `<svg>`
against the existing tokens, no charting library for these.

- **Meter** (the stock-cell bar, and any future par-vs-on-hand meter): a
  `<div>` track (`bg-muted`, `h-0.5` / 2px, `rounded-full`) with a filled
  inner `<div>` whose `width` is a computed percentage and whose background
  is a status token. Follows §3's no-par-no-bar rule unconditionally —
  this primitive has no "draw at 0%" fallback; the caller does not render it
  at all when the denominator is absent.
- **Sparkline**: a single inline `<svg>` `<path>`, `stroke="currentColor"`
  (so it inherits `text-muted-foreground` or a chart token through the
  cascade and re-themes for free under `.dark` with no JS — the same
  CSS-variable-native property that made visx the Phase 4 choice). No fill,
  no axes, no interactivity in this phase — those are Phase 4 chart
  territory, not this primitive's job.
- **Stat tile**: a card (`rounded-lg border border-border bg-card p-card-pad`
  — the existing card token set, no new spec) with a label
  (`text-label uppercase text-muted-foreground`) and a value
  (`text-numeral-md` or `text-numeral-lg` depending on whether it's a
  secondary or primary dashboard number). Follows §6's null-value rule when
  the underlying figure is absent for any of the three reasons enumerated
  there.

None of these three take a chart-palette token by default — a stat tile or
meter's color comes from a status token (§3) or `--foreground`/
`--muted-foreground`, never `--chart-*`. Only a genuine multi-series chart
(Phase 4) needs the palette in §8.

---

## 10. Density and tap targets (B6, restated — not relaxed by this document)

Part A's 56/44px rules are a phone rule and do not apply here. The back
office's own floor, already documented as divergence B6: **57px rows and
32–36px controls are appropriate; do not inflate the table to phone sizing.**
What B6 does *not* excuse, and what the audit found genuinely below even that
lower floor:

- `office-product-edit.html`'s destructive Remove-barcode button at 30×30px —
  raise to 36px minimum. A destructive action gets at least the same floor as
  a neutral one; nothing about being destructive justifies a smaller target.
- `office-catalog.html`'s row-menu `⋯` button at 32×32px, the sole entry
  point to every non-Edit row action — raise to 36px.
- Vendor/person identity dots at 22×22px and the avatar tile at 34×34px — the
  avatar/account control is addressed in §5 (44px, because it is identity +
  navigation, not a dense data control); inline identity dots inside table
  cells may stay visually small (they are not independently interactive) per
  the same small-visual-element allowance `docs/design-system.md` §6 already
  grants the counting app's stepper circle.

Keep focus rings and full keyboard navigation everywhere — the one thing the
reference shot omits entirely and this project does not get to skip (§7 of
`docs/design-system.md`, unconditional in both themes).

---

## 11. Cleanup items that are corrections, not new rules

Each of these already has a defined correct value somewhere in
`docs/design-system.md` or `app/globals.css`; the fix is applying the
existing token, not choosing a new one.

- **Letter-spacing (P2.6):** the token is `0.06em`
  (`--text-label--letter-spacing`). The back office's `.04em` usage across
  `.attn-pill`, `.status-pill`, `.field label`, and others is wrong, not an
  intentional divergence — apply `0.06em` (or the `text-label`/
  `text-screen-title` classes, which already carry it) uniformly.
- **Invented type sizes (P2.10):** 14px and 12px do not exist in the type
  scale. Every `td`, `.crumbs`, `.view-tab`, chip, and label currently set at
  one of those sizes rounds to the nearest defined step —
  `text-caption` (13px) for the smaller cluster, `text-row-subtitle` (15px)
  for the larger — never a new arbitrary size. Weight drift (14px @ 700
  where the token is 400, or 24px/18px @ 700 where the token is 600) is
  corrected to the token's own weight; a heavier look, if genuinely wanted,
  is a design-system.md change, not a per-component override.
- **`.tabular` (P2.4):** a no-op class, defined nowhere, that happens to work
  today only because `body { font-variant-numeric: tabular-nums }` is
  global. Drop it everywhere it appears; it is not a Tailwind utility and
  will silently do nothing once carried into the real app.
- **`--header` present in only 2 of 5 prototype files (P2.8):** resolved
  structurally by §2's shared shell — a layout component either has the
  token available or it doesn't; there is no longer a per-file copy to drop.
- **The reorder screen's four duplicated headers (P1.9):** `office-reorder`'s
  four independently-sized per-vendor tables cannot align columns against
  each other. Restructure as one table (or one TanStack instance) with
  vendor-name subheader rows, so "Product / On hand / Par / Reorder point /
  Suggested order" is a single column definition shared by every group —
  the whole point of the screen is reading down a column of quantities, and
  that requires the columns to actually line up.
- **Detail header padding (P2.13):** `docs/design-system.md` §9's own spec
  (`px-bar-pad pb-8 pt-6`) is the single value; the three drifted paddings
  found in prototypes (`pt-6 pb-8`, `20px 16px 28px`, `20px 16px 24px`) all
  collapse to it.
- **`.no-value` styling** is subsumed by §6 above — do not keep the italic
  13px treatment for any context; classify the value under §6's three
  categories and use that treatment instead.

---

## 12. Zoom, reflow, and the fixed-1440 viewport (P3.5)

`office-*.html`'s `<meta name="viewport" content="width=1440">` plus
`body { min-width: 1280px }` blocks pinch-zoom and reflow — a WCAG 1.4.10
failure, and one that also happens to be simply wrong for a screen that gets
opened on a phone anyway (`ROADMAP.md` Phase 2 notes the office nav already
needed an overflow fix and the catalog table's bulk bar had to be made
sticky for exactly this reason). **Binding: the office route uses the
standard responsive viewport** (`width=device-width, initial-scale=1` — the
Next.js App Router default, which the prototypes must not override when
regenerated). Below a density breakpoint, the table gains horizontal scroll
rather than the page blocking zoom to preserve a fixed 1440px layout.

---

## 13. Component names this spec adds to `docs/design-system.md` §9

`ui-audit.md` P1.1 names this the single largest root cause: the design
system defines nine components and every screen independently reinvented
everything it needed beyond that, with different values each time. This
document specifies the following well enough to build from; each becomes a
real §9 entry (with the literal class-string convention §9 already uses)
when merged into `docs/design-system.md`, rather than staying scattered
across this file:

**Web:** table (§1), pagination (§1), sort control (§1), empty state (§9 of
this doc's own numbering, below), avatar/account menu (§5), filter pill
(§1), view tab (§2), chip (`REASON_LABEL`-style action pills — already
exists in `catalog-table.tsx`, just undocumented at the system level),
null-value (§6), meter/sparkline/stat-tile (§9).

**Shared (both surfaces, proposed in the mobile UI spec too):** sheet, popover, tooltip,
toast, hover, zebra.

**Popover, specifically** — the one place this document diverges from the
raw Part B shot rather than adopting it: the reference's row-overflow popover
carries a soft shadow. `docs/design-system.md` §5's no-shadow policy applies
here too — depth comes from the `--popover`/`--popover-foreground` tokens
(already defined in `app/globals.css`) plus a `border-border` hairline, not a
shadow. This is the same reasoning already applied to cards and sheets; a
popover gets no special exemption for having come from a shot that shadows
it.

### Empty state

One pattern, reused everywhere a table or a derived figure has nothing to
show: centered content, `section-gap` (24px) vertical padding — not the 64px
`office-reorder.html` currently uses, which is disproportionate to every
other spacing value in the system — a short sentence stating *why* (not just
"no results"), and a primary action where one exists ("Add a location," "Set
a par level"). The `asOfCountId === null` case from §4 and the `case_size`
empty-barcodes state from `office-product-edit.html` (designed, never wired —
P1.10) both use this same pattern rather than a bespoke per-screen box.

---

## Summary of `app/globals.css` additions from this document

```css
/* row height, ending the 57px/48px/52px drift */
--spacing-row-office: 3.5625rem; /* 57px */

/* chart series — VALUES OWED, see §8. Do not fill these in without
   computing contrast per the method in §8; --chart-1 is unchanged. */
--chart-2: /* owed */
--chart-3: /* owed */
--chart-4: /* owed */
--chart-5: /* owed */
```

No new color tokens are added for hover, zebra, chip, or identity — all
reuse `--muted`, `--card`, `--muted-foreground`, and `--foreground`, which
already exist, per §5's and §7's simplifications.

## Summary of `docs/design-system.md` additions proposed by this document

- §8: a fourth point distinguishing not-applicable / not-yet-entered /
  role-gated null values (§6 above).
- §9: table, pagination, sort control, empty state, avatar/account menu,
  filter pill, view tab, chip, null-value, meter, sparkline, stat tile,
  sheet, popover, tooltip, toast, hover, zebra — the full component list
  from §13, each with a literal class-string spec once merged.
- A new palette-derivation appendix (or an extension of §2's table) for the
  chart series, populated only once §8's contrast computation is actually
  run — not before.

## Left owed

**The five chart-series hex values (`--chart-2` through `--chart-5`), in
both themes.** §8 states the requirement and the method; computing them
against that method is explicitly out of scope for this document, because
doing it without running the computation would mean inventing plausible-
looking numbers — the exact failure this project's own history says to avoid.
No chart may be built against a placeholder value in the meantime.

## Not resolved by this document — findings that need a decision this spec
can't make alone

- **P2.11's remaining vocabulary drift** (size formatting — `750ml` vs.
  `750 ML` vs. `750 ml`; count-id digit counts; count-type strings like
  `Spot`/`Full`/`FULL COUNT`; location naming — `Storeroom` vs. `Storage`).
  These are data-formatting and copy conventions, not component contracts,
  and belong in a shared formatting-utility pass (`lib/utils.ts`-level, e.g.
  a single `formatSize()` the way `formatMoney()` already exists) rather than
  a design-system rule. Flagged here so it isn't lost; out of scope for this
  document because it is implementation, not spec.
- **The `office-product-edit.html` barcode table's missing per-row controls**
  (no way to set which barcode is primary — `Primary` is static text) is a
  behavior gap, not a styling one; it needs a Gate-2-style architecture note
  (a new server action) once this phase reaches that screen, which is
  outside a pure UI-spec document's authority.
