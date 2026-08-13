# Gate 1 — Product: the Phase 2 UI redesign

No databases, schemas, endpoints or file names in this document. That is Gate 2
(not run for this phase — see "Why this phase skips Gate 2/3/4" below).

Cites `ROADMAP.md` Phase 2 rather than re-deriving it. Read that section first;
this document does not repeat its history, only its consequences for the design
work.

---

## Problem

**In the counter's words** (the manager or staff member holding a phone in one
hand and a bottle in the other):

> "I can tell some rows are supposed to be tappable because they have an arrow
> on the right. Except some rows have the arrow and don't do anything, and some
> rows do something and don't have the arrow. I've stopped trusting the arrow."

> "I lost my place in the search box once — I tapped in, it lit up blue, then
> the outline just vanished and I couldn't tell if I was still typing into it
> or not."

> "When I hit SET instead of ADD I want to see what that's about to do to the
> number before I confirm it — not find out after."

**In the owner's words** (at a desk, five tabs open, trying to read the
catalog):

> "I can't tell if a manager's screen is missing the cost column because it's
> supposed to be, or because something broke. And I've seen at least four
> different words in this app for 'nothing here yet' — 'Not entered', 'Unpriced',
> a dash — which one means the number doesn't exist yet versus I'm not allowed
> to see it?"

> "The stock bar in the mockup is the best idea in it — a number, a word, a
> bar, done — but half my catalog has no par level set. If that bar just draws
> at some fake width for those rows, I will trust a number that isn't real."

**What ties them together:** `docs/plans/phase-2-ui-redesign/ui-audit.md`
catalogued 40+ specific defects across the prototypes and the shipped app.
Read individually they look like polish items. Read together they share one
shape: an **implicit or inconsistent contract** where the product needs an
**explicit and uniform** one — a chevron that sometimes means "tap here" and
sometimes means nothing, four spellings of "this number doesn't exist," a
role-gated column that is CSS-hidden in one file and genuinely absent in
another. This project's own standard for severity is *"can it produce a
number that is plausible and wrong, or an action the user did not intend"* —
and several of these defects clear that bar. Fixing them one at a time would
re-diverge, per the audit's own root-cause finding (P1.1): the primitives
these screens need — table, empty state, pagination, avatar, null-value
treatment, card interaction contract — were never defined once in
`docs/design-system.md`. This phase defines them once and applies them
everywhere, rather than patching eleven files independently.

---

## Success metric

**This phase is designed from judgement, not from evidence, and that fact
governs how its success is measured.** `ROADMAP.md`'s Phase 2 section says so
directly: the field-validation phase that used to feed this one moved to
2.9, so Phase 2 ships before any timed count, five-location walk, or
enroll-budget number exists. Two consequences follow, and both are binding on
how this document is read:

1. **Nothing in this phase may claim a speed number it cannot measure yet.**
   "The enroll form completes in under 20 seconds" is Phase 2.9's claim to
   prove, not this phase's claim to make. This phase's job is to build a
   design that gives that claim its best shot, and to write down *which*
   decisions are bets so 2.9 settles them instead of re-litigating them (see
   "Bets deferred to 2.9" below).
2. **Every decision this phase makes must be cheap to revisit.** None of it
   touches the schema, the write path, or the leg model — this is a
   presentation-layer and design-token pass. If 2.9 finds a bet wrong, the fix
   is a component or a copy change, never a migration.

**What this phase can actually claim done, checked at Phase 2 completion
(not deferred to 2.9):**

- Every screen in the counting app and the back office passes the
  accessibility floor in `docs/design-system.md` §7, checked in a real
  browser per `AGENTS.md`'s "verify in a browser, not with curl" rule — not
  merely typechecked or built. Specifically: zero `outline: none` without a
  substitute focus treatment; every icon-only control has an `aria-label`;
  contrast ratios hold in both themes (already computed in §2, re-verified
  against any new token added by this phase); zero heading-level skips.
- Zero card rows or table rows carry a click/anchor wrapping the entire row
  (P0.2, and the back office's existing table discipline extended to cards —
  see the mobile UI spec). Every chevron present on a card is a real, labelled control;
  every card without one does not navigate.
- The role-gated value contract (`docs/design-system.md` §8) holds for every
  new or touched component: an absent cost value renders nothing, never
  `$0.00`, never a reserved blank track.
- TanStack Table is adopted for at least the catalog table, with per-role
  `columns` arrays built at call time — never `columnVisibility` filtering
  (per `docs/plans/phase-2-ui-redesign/library-comparison.md`, already
  decided). A committed browser check (extending the existing
  `bun run verify:browser` harness) asserts a manager's rendered DOM contains
  no `Unit cost for` string, matching the assertion that already protects the
  hand-rolled table today.
- The chart series palette is re-derived per the method in the web UI spec, or — if
  the contrast computation is not done in this phase — explicitly marked
  owed, with **no chart drawn against the old palette** in the meantime
  (`--chart-2..4` currently equal the status tokens; see
  `library-comparison.md`'s blocking-prerequisite section).
- One capitalization convention and one null-value vocabulary apply
  uniformly across both surfaces (the two UI specs state which).
- `prototypes/*.html` are regenerated from `app/globals.css` rather than
  hand-reconciled file by file (per the audit's P2.7 finding — the token
  file is the healthy version, the prototypes are eleven drifted copies of
  it).

**Bets deferred to 2.9** — decisions this phase makes about *where count time
goes*, written down so 2.9 can confirm or falsify them rather than the next
person re-arguing them from scratch. Each one gets an entry in
`docs/phone-count-test.md` before this phase closes:

- The enroll form's field set and preset-list-over-free-text choices are a
  bet that the 20-second budget is achievable with the current field count.
  If 2.9's Run A comes in over budget, the fix is cutting fields or widening
  a preset list — never adding a free-text field that accepts a plausible
  wrong answer (`AGENTS.md`, the draft-beer-default lesson).
- The SET/ADD consequence line (stating the result on the button rather than
  behind a modal) is a bet that a *visible* consequence is enough friction to
  catch a mistake without adding a tap. If 2.9 finds mis-taps on this
  control, the fix is copy or emphasis, not a confirmation dialog — a modal
  on a control used 150 times a count gets clicked through blind inside a
  week (`AGENTS.md`).
- The pending-writes sync indicator's visibility (a persistent pill rather
  than a toast) is a bet that a counter needs to see sync state at a glance
  without it stealing attention from the count itself.
- Card layout density (one card per scanned product, `card-gap` between them)
  is a bet that browsing "just counted" as cards rather than a denser list is
  worth the vertical space it costs on a five-location walk.

None of these bets touch the leg model, which is the one thing this phase
must leave alone entirely — see Non-goals.

---

## The two surfaces, and why they pull in opposite directions

Both surfaces share one token set (`app/globals.css`) and one component
philosophy (hairline borders, no shadows, role-gated values). They do not
share density, touch-target size, or theme, because they solve different
problems for different people:

| | Counting app (mobile) | Back office (web) |
|---|---|---|
| **User** | Manager or staff, one hand on a phone, the other on a bottle | Owner or manager, seated at a desk |
| **Environment** | A dim bar at close of business | Full daylight or office lighting |
| **Governing constraint** | Speed and one-handed reach — CLAUDE.md's "dim-bar UI" | Density and readability — reading down a column of 97+ rows |
| **Theme** | Dark, hardcoded (`.dark`, never `prefers-color-scheme`) | Light, as rendered (`docs/design-system.md` §1) |
| **Touch target floor** | 44px absolute, 56px on the primary count loop | 44px is not the rule here — B6 sets 32–36px as acceptable for dense mouse/keyboard controls, never inflated to phone sizing |
| **Primary input** | Barcode scan, tenths tap, quantity stepper | Keyboard, mouse, sort, filter, bulk edit |
| **Numbers shown** | One number at a time, large (`text-numeral-lg`, 48px) | Many numbers at once, right-aligned, tabular, dense |
| **What "done" looks like** | The scan-count-next loop never makes the counter think about the UI | A five-minute session answers "what needs attention" without a support call |

Building one responsive layout that serves both would compromise both — the
same conclusion `AGENTS.md` already reaches ("Two layouts, one codebase...
Do not make either compromise for the other"). This phase treats that as
settled, not as a question to re-open.

---

## Roles

Restated from `AGENTS.md` because this phase's screens are gated on it in
both surfaces:

- **`owner`** — everything, including cost and margin.
- **`manager`** — counts, receiving, reorder, par levels (par is a quantity,
  reordering is a manager's job per spec §4). **No cost visibility.**
- **`staff`** — count only. No cost, no back-office management screens beyond
  what counting itself needs.

Cost and value are role-gated at the server (`unitCostAtCount`,
`extendedValue`, `totalValue` are **omitted**, not zeroed, for non-owner
callers — `AGENTS.md` invariant 8). Every screen this phase touches must keep
that contract: a value that is absent because of role is invisible, not
present-and-hidden. `docs/design-system.md` §8 already specifies the
component-level rule; this phase applies it to every new surface (the
TanStack columns, the meter primitives, the chart tokens) rather than only
the places it already exists.

---

## Scope

**In:**

- Card and row interaction contracts on both surfaces (chevron ⟺ navigable;
  explicit Edit buttons; no whole-row/whole-card click wrapping).
- Accessibility floor closure: focus visibility, ARIA correctness, heading
  structure, contrast on functional borders, zoom/reflow, motion guards.
- One capitalization convention, applied uniformly.
- One null-value vocabulary, per context, applied uniformly.
- TanStack Table adoption for the catalog table (the one the library
  comparison names as the first migration), with sorting, pagination, and
  per-role column sets.
- The stock-cell, meter, sparkline, and stat-tile primitives as
  dependency-free markup, per `library-comparison.md`.
- The chart series palette re-derivation (or an explicit "values owed" marker
  if the computation doesn't land in this phase — see the web UI spec).
- Naming and lightly specifying every component the design system doesn't
  yet define but every back-office screen needs (table, pagination, sort
  control, empty state, avatar/user menu, filter pill, view tab, banner,
  sheet, popover, tooltip, toast, hover, zebra, chip, null-value).
- Regenerating `prototypes/*.html` from `app/globals.css` rather than
  reconciling eleven drifted copies.
- The mobile-specific items enumerated in the mobile UI spec (SET/ADD consequence line,
  sync indicator, safe-area insets, enroll-budget field discipline).

**Out — explicitly, so it is not discovered later:**

- **The leg model.** Pick-a-location → count it → *Finish section* → move on,
  with the stray-bottle escape hatch, stays exactly as built.
  `STATE.md` and `ROADMAP.md` both say leave it alone: no pass has covered
  all five locations, and Phase 2.9 is the first thing that will genuinely
  test it. Changing an untested flow on judgement alone risks replacing a
  design that works with one that merely reads better.
- **Any chart.** `library-comparison.md` names visx for Phase 4, against a
  catalog that by then has costs, pars and vendors in it. A chart built now
  against 9-of-99-costed data with 0 par rows would render empty and prove
  nothing — and it would also need the palette this phase can only specify,
  not necessarily finish computing.
- **Anything scheduled for Phase 4 or Phase 5** — count history/trend, the
  depletion heatmap, reorder intelligence, export, Toast PMIX import,
  variance reporting. Phase 4 is deliberately after go-live for a reason
  (`ROADMAP.md`: "reports built against 8 count lines are guesses").
- **Anything resembling the prototypes' "Preview as Owner / Manager"
  toggle.** `docs/design-system.md` already states this as a binding rule —
  restated here because it is exactly the kind of thing a redesign pass is
  tempted to carry forward as a convenience. Nothing client-side may switch
  role. A role comes from the session, re-read from the database on every
  server action.
- **AI fill estimation, bottle photos, invoice OCR, file storage.** Still
  outside the MVP boundary per `AGENTS.md` — this phase is presentation and
  tokens, not a new capability.
- **Any schema change, migration, or business-logic change.** If a screen
  needs data the domain layer doesn't already expose (e.g. `asOfCountId` for
  the "as of count #N" labelling — already returned by `reorderList()`), this
  phase reads what exists. It does not add a column to get a nicer label.
- **Field validation and the owner's data entry** — Phase 2.9's job, not this
  one's. This phase designs against a catalog that is still mostly uncosted
  and has zero par rows; screens must degrade honestly against that (the
  null-value vocabulary and the no-par-no-bar rule exist specifically for
  this reality), not pretend it away with fixture-shaped placeholder data.

---

## Why this phase skips Gate 2 (Architecture) / Gate 3 (Program Design) / Gate 4 (Slices) of the standard workflow

`docs/plans/README.md`'s 4-gate process assumes new endpoints, tables, or
business logic — this phase has none. It is markup, tokens, and component
contracts against data shapes (`ProductSummary`, `CountLineDetail`,
`reorderList()`'s `asOfCountId`, `canSeeCost`) that already exist and are
already tested below the UI. The two documents that follow —
`ui-spec-mobile.md` and `ui-spec-web.md` — carry the
architecture-equivalent decisions (data shapes consumed, component contracts,
token additions) at the level of detail this kind of change needs, without
inventing route/schema ceremony this phase doesn't have. When implementation
starts, each concrete component change is still small enough to review in one
sitting — the discipline `docs/plans/README.md` cares about — it is just
tracked as a checklist inside the UI specs rather than as Gate 4 slices.

---

## Screens

No new `mockups/` directory. `prototypes/*.html` (all 11 files) and
`prototypes/design-system.html` already function as living mockups with no
build step — per the audit's P2.7 finding, they are regenerated from
`app/globals.css` as part of this phase's scope rather than replaced with a
new set. The two UI-spec documents that follow enumerate, screen by screen,
what changes on each existing prototype and on the shipped app's equivalent
component.

| Surface | Screens covered |
|---|---|
| Mobile | Location pick, scan/search, scan-to-enroll, tenths entry, quantity entry, the counting leg's "just counted" list, the sync indicator, the bottom tab bar |
| Web | Catalog, counts list, count summary, reorder, product edit — the five screens `ui-audit.md` P2.3 checked for shell consistency — plus locations, vendors, and users, which already shipped fixes on 2026-08-12 and are folded into the same component contracts going forward |
