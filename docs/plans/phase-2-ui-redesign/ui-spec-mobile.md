# UI spec — the counting surface (mobile)

Extends `docs/design-system.md` and `docs/design-reference.md` Part A. Where
this document adds a rule those files don't have, it says so explicitly and
names the section it belongs in once merged. Nothing here contradicts
`docs/design-system.md` §10's invented-nothing list; where a fix requires a
new value, that value is a spacing/utility token addition, never a new color
or a sub-floor tap target.

**Theme: dark-locked.** The counting route's root element hardcodes
`className="dark"`. Never `prefers-color-scheme`, never a cookie, never a user
setting. This is unchanged from `docs/design-system.md` §1 — restated here
because it is the one rule a "make it responsive" instinct could accidentally
undo.

---

## 1. The loop: scan → resolve → tenths/quantity

The shipped flow in `components/count/count-leg.tsx` is the reference
implementation, not a prototype to catch up to. This section specifies its
contract so the prototypes (and any future screen built against this loop)
match it exactly, rather than the free-switch/duplicate-affordance shapes the
audit found.

```
pick-location
  → counting (scan or search)
      → known barcode / search hit → entry (tenths if location.countMode ===
        "tenths", quantity stepper otherwise — chosen ENTIRELY by location,
        never by product.unitType)
      → unknown barcode → enroll → onResolved → entry
  → entry: submit → back to counting, same location
  → "Finish section" → back to pick-location
```

**Binding, not new:** the active location is locked for the duration of a
leg and is never a dropdown next to the scan button. This is already built
and already documented in `AGENTS.md` — restated because
`prototypes/count-scan.html`'s bottom sheet predates the decision and must
not be regenerated. See §5 below for the specific fix.

**Search is always paired with scan, one control.** `docs/design-system.md`
§9's search+scan field spec is correct as written; no change.

---

## 2. The enroll form's 20-second budget — a design constraint, not a measured pass/fail

Nobody has timed this. `ROADMAP.md` Phase 2's own warning applies directly:
treat 20 seconds as a target this phase designs toward, not a number it can
claim. Phase 2.9's Run A is what measures it.

**Design rules that follow from the budget, all of them already established
by `AGENTS.md` and restated here as binding for this phase's enroll-form
work:**

- Barcode pre-filled from the scan; never re-typed.
- Every field with a bounded domain (size, category, unit type) is a preset
  list or a chip group — never free text. `lib/bottle-sizes.ts`'s
  category-aware preset lists are the existing mechanism; this phase does not
  replace them, only fixes their surrounding chrome (labels, ARIA, focus).
- **If Phase 2.9 finds the form over budget, the fix is removing a field or
  lengthening a preset list — never adding a free-text field that accepts a
  plausible wrong answer.** This is the draft-beer-keg-default lesson
  restated for this specific form: a free-text size box that takes `75` for
  `750` is a legal integer that quietly values a bottle at a tenth of its
  worth.
- `autofocus` on the first field (currently the name input,
  `scan-to-enroll.html:133`) is a genuine trade — it buys time against the
  budget and moves focus without a user action. `ui-audit.md` P3.5 flags this
  as *unconsidered*, not wrong. **Decision for this phase: keep it**, because
  the budget is the harder constraint and a screen reader user lands on a
  freshly-opened dialog-equivalent screen where the first field is the
  expected next stop anyway. Revisit only if 2.9 or an accessibility pass
  finds it actively disorienting in practice.
- Required-field marking must be real (`required` + `aria-required`, not
  `::after{content:" *"}` and color alone — closes P3.3's finding on this
  point).

---

## 3. Card and row interaction contract — resolves P0.2 / P0.3, extends P0.5's principle

**The rule, stated once:** a card is either **passive** (no chevron, does not
navigate, e.g. the "just counted" list) or **active** (has a chevron, and the
chevron — or an equivalently sized, equivalently labelled control occupying
the same visual slot — is the real, focusable `<button>` or `<Link>` that
does the navigating). **The card's `<article>` container is never itself
wrapped in an `<a>`, and never carries an `onClick`.**

This is `AGENTS.md`'s row-click ban — written for the back office's
`<tr onclick>` prohibition — extended explicitly to cards, because the
prototypes found the identical defect in card form: `count-scan.html`
wrapped whole `<article class="card-row">` elements in `<a href=...>`, which
nests an `<h3>` inside a link (the heading text becomes link text) and
concatenates the row's entire visible content — title, subtitle, status pill,
quantity, value — into one unreadable accessible name.

**Concretely:**

- The chevron, when present, is a real control: `min-w-tap-min`,
  `aria-label="View {product name}"` (or equivalent — name the destination,
  not the icon), and it is what carries the `href`/`onClick`. The rest of the
  card's text is presentational, not nested inside the interactive element.
- A card with no chevron renders no navigation affordance of any kind. No
  `cursor: pointer`, no hover treatment implying tap-ability.
- Every screen that renders this card type uses the same rule. `P0.3`'s root
  cause — the canonical card row in `docs/design-system.md` §9 shows a
  chevron with no interaction contract documented — is fixed by this section
  becoming that documentation; §9's card-row spec should be updated to
  reference it once merged.
- **Cross-reference to the back office (P0.5):** the identical principle —
  explicit contract over implicit hiding — is what the web UI spec
  applies to table columns: a role-gated column is absent from the column
  array, never CSS-hidden with a matching annotation that claims otherwise.
  Same failure mode, two different surfaces; each surface's spec fixes it
  where it lives.

**Where this shows up today:** the counting app currently has one navigable
card context (search results in `CountLeg`, rendered as whole `<button>`
elements — already compliant, since the entire clickable area *is* the
button, not an `<article>` nested inside an `<a>`) and one passive context
("just counted," `CountLineCard`, no chevron, correct as built). Any new card
context this phase or a future one adds must pick one of these two shapes
explicitly and say which in its own component comment.

---

## 4. Focus is never removed without a substitute (P0.4)

`docs/design-system.md` §7 already states the floor: a global
`:focus-visible` outline, `2px solid var(--color-ring)`, `2px` offset,
applied in `app/globals.css`. This section adds one binding sentence that was
implicit before and is made explicit now, because the prototypes proved it
needed to be:

**No component may set `outline: none` (or otherwise suppress the visible
focus indicator) without providing a substitute that is at least as visible
— never zero substitutes.** `scan-to-enroll.html:68`'s
`border-color: var(--ring)` + inset ring is an acceptable substitute pattern.
`count-scan.html:123`'s bare `outline: none` on the search-and-scan field —
the single most-used input in the product — is not, and is the audit's worked
example of exactly what this rule forbids.

This applies identically on the web surface; stated here because the search
field was the concrete failure found.

---

## 5. The closed location-switcher sheet must not exist, and no sheet ships half-built (P0.9)

`prototypes/count-scan.html`'s bottom sheet is the wrong pattern twice over:
it re-introduces a free location switch next to the scan button (the thing
`AGENTS.md`'s locked-location rule exists to prevent — a wrong active
location fails *silently*, and the whole count total stays correct while
only the distribution goes wrong), and its closed state stays in the tab
order with no `inert`, no `aria-hidden`, and no focus trap — six invisible
location buttons a keyboard or switch-access user can still reach.

**Binding for this phase:** do not build a location-switcher sheet, full
stop. The shipped `LocationPicker` (a full-screen state, not a sheet) plus
the `StrayPicker` escape hatch already satisfy the requirement — *pick a
location once per leg, with a deliberately heavier separate action for a
stray bottle* — and neither has this failure mode, because neither is a
dismissible overlay sitting next to the primary scan control.

**If any sheet/modal component is introduced later** (an overflow-actions
sheet, a confirmation sheet — none exist in the shipped app today), it must,
when closed:

- Not be reachable by Tab (`inert` on the container, or `display: none` — not
  `transform: translateY(100%)` alone).
- Trap focus while open, restore focus to the trigger on close.
- Close on Escape, not click-only.

This is a proposed addition to `docs/design-system.md` §9 as a new "Sheet"
component spec — currently undefined (see the component-naming list in
the web UI spec, which applies to both surfaces).

---

## 6. Sync indicator — pending writes, always visible

Already built (`SyncIndicator` in `components/count/count-leg.tsx`) and
correct as built: `aria-live="polite"`, warning tint + `CloudOff` icon while
`pending > 0`, success tint + checkmark otherwise, visible at all times per
spec §11 rather than only appearing on a failure. This phase's job is to
**document it as a named component spec** (currently absent from
`docs/design-system.md` §9 — propose adding it there) so future screens reach
for the existing pattern instead of reinventing a sync pill, which is exactly
what `count-scan.html:72`'s 32px `.sync-pill` did (also flagged under P3.1 for
its undersized tap target — n/a here since the sync indicator is a status
display, not a tap target, and should stay non-interactive).

---

## 7. The SET/ADD consequence line — no modal

Already specified in `AGENTS.md`'s working agreements and already the
intended behavior of `QuantityEntry`: the submit button states the
consequence live as the counter types, in the same box that took the number —
`SET TO 3 EA / was 12 ea · −9` or `ADD 3 EA / 12 → 15` — never a confirmation
dialog. Restated here as binding for this phase's pass over that component,
with the reasoning preserved because it explains why a modal is explicitly
the wrong fix even though it looks like the safer one: a confirmation dialog
on a control used ~150 times a count gets clicked through blind inside a
week, which is worse than no guard because it *feels* like one. The ledger
records the delta either way — this is about the human noticing at the time.

**Typography for the consequence line:** top line `text-label uppercase`
(the action — `SET TO` / `ADD`), value in `text-numeral-sm tabular-nums`; the
before/after or delta renders in the same line at reduced emphasis
(`text-caption`, `text-primary-foreground/70`-equivalent on the button's own
foreground color — not a new token, an opacity modifier on the existing
`--primary-foreground`).

---

## 8. Mode toggle (ADD/SET switch) tap target — 40px → 56px floor (P3.1)

`count-sealed-qty.html:74`'s `.mode-btn { min-height: 40px }` is below even
the 44px absolute floor, and this control decides whether a save is additive
or destructive — it belongs on the primary count loop, so it gets
`min-h-tap-primary` (56px), not merely `min-h-tap-min`. Same treatment for
any other mode/segmented control that gates a write's semantics (none other
currently exist on this surface).

---

## 9. `aria-live` on the invariant-3 confirmation (P3.3)

When a scan increments an existing line rather than creating a new one — the
behavior invariant 3 exists to guarantee — the UI already says so: the
`note` field set in `count-leg.tsx`'s `applyIncrement`
(`"Already on this count — updated, not duplicated"`) is passed through as
`highlight` to `CountLineCard`. **This message must render inside an
`aria-live="polite"` region.** It is currently the entire point of the
screen — the one place a counter finds out their second scan didn't create a
duplicate row — and if it is not wired to an ARIA live region today, that is
the specific gap this phase closes: verify `CountLineCard`'s highlight
rendering against this requirement and add the live region if absent. This
mirrors the sync indicator's existing `aria-live="polite"`, which is the
correct precedent to copy rather than a pattern to invent fresh.

---

## 10. 56px primary targets, 44px floor — restated, not changed

`docs/design-system.md` §6 is correct as written:

- `tap-min` (44px) is the absolute floor everywhere.
- `tap-primary` (56px) is the floor for the tenths stepper, the scan trigger,
  the bottom action bar, and (per §8 above) the ADD/SET mode toggle. Treat as
  a minimum the tenths grid in particular should exceed, not a target to sit
  exactly on.
- A visually small element (the 32px stepper circle) may stay visually small
  only if it is not itself interactive; if it becomes tappable, the *hit
  area* grows to `tap-min` via padding, the visible circle does not.

No prototype in the counting app currently violates the 56px floor except the
two items named above (§8's mode toggle, and the 32px sync pill covered in
§6, which is exempt because it is not interactive). This section exists to
confirm the floor rather than to change it.

---

## 11. Safe-area insets

Built and typechecked in `components/count/count-leg.tsx` (bottom action bar:
`paddingBottom: max(var(--spacing-bar-pad), env(safe-area-inset-bottom))`)
and `components/count/barcode-scanner.tsx` (header respects
`safe-area-inset-top`), but per `STATE.md`, **never exercised on a real
notch/home-indicator device.** This phase's job is to make the pattern a
named token instead of an inline `style=` attribute repeated per component —
closing the specific drift the audit found (P2.13: scroll clearance for the
fixed bottom bar is 96px in four counting files and 110px in one, for an
identical 88px bar).

**Proposed `app/globals.css` addition**, `@theme inline` block:

```css
--spacing-safe-top: max(0px, env(safe-area-inset-top));
--spacing-safe-bottom: max(var(--spacing-bar-pad), env(safe-area-inset-bottom));
```

Every fixed top or bottom chrome element (the bottom action bar, the barcode
scanner's header/footer, and any future fixed element on this surface) uses
`pt-safe-top` / `pb-safe-bottom` instead of a hand-computed inline style. This
does not change the computed value on the one place it is already correct
(`count-leg.tsx`'s bottom bar); it gives every other place the same value by
construction instead of by careful copying.

---

## 12. Capitalization — binding convention (P2.12)

**Binding: sentence case in source; `text-transform: uppercase` in the CSS
class does the visual work.** This is not a new decision — it is what
`docs/design-system.md` §4 and §9 already do in every one of their own code
examples (`"In stock"`, `"Search products"`, `"Close count"`) via the
`text-label` / `text-screen-title` classes, which carry `uppercase` alongside
`letter-spacing: 0.06em`. The counting app's prototypes are the outlier —
`count-scan.html`'s literal `JUST COUNTED` in source, on top of the same CSS,
is banned by this rule, not merely inconsistent with it.

**Why sentence-case-in-source wins over literal caps, stated so it isn't
re-litigated:** copy that needs changing (a label, a button, a screen title)
changes in exactly one place — the string — rather than needing a second
check of whether the string itself is already shouting. And a screen reader
reads `JUST COUNTED` as a shouted acronym-like string; `text-transform:
uppercase` is presentation-only and does not affect how assistive tech
announces the text, which is a live accessibility difference, not a style
preference.

**Concretely:** every string that renders through `text-label` or
`text-screen-title` is written in normal sentence case in JSX/HTML —
`"Just counted"`, not `"JUST COUNTED"`. `count-session.html:187, 208, 214`'s
sentence-case usage of the same `.text-label` component was already doing
this correctly; that is the pattern to keep, not the outlier to fix.

**Proposed `docs/design-system.md` §4 addition:** one sentence — "Always
write label copy in sentence case in source; the `uppercase` utility
alongside `text-label`/`text-screen-title` handles the visual capitalization.
Never hardcode literal caps in JSX or HTML."

---

## 13. User identity on the counting surface (P2.1)

**No action needed on the shipped app.** `components/count/tab-bar.tsx`
already renders the 4-tab bottom bar (matching `docs/design-system.md` §9's
spec exactly) and `/count/account` already exists with name, email, role, and
sign-out. The prototypes are *behind* the shipped app here, not ahead of it —
`count-scan.html:345` documents dropping the tab bar, and the only "who am I"
signal any prototype shows is the prototype-only role `<select>`, which
`docs/design-system.md` already bans from shipping.

This phase's regeneration of the prototypes from `app/globals.css` (per
Gate 1's scope) restores the tab bar and drops the role selector, bringing
the mockups back in line with what is already built rather than treating
this as a gap to design.

---

## Summary of `app/globals.css` additions from this document

```css
--spacing-safe-top: max(0px, env(safe-area-inset-top));
--spacing-safe-bottom: max(var(--spacing-bar-pad), env(safe-area-inset-bottom));
```

No new colors, no new radii, no sub-floor tap targets — none needed for this
surface's fixes.

## Summary of `docs/design-system.md` additions proposed by this document

- §4: one sentence binding sentence-case-in-source (§12 above).
- §9: a "Sheet" component spec (§5 above) — currently undefined.
- §9: a "Sync indicator" component spec, documenting the existing, correct
  `SyncIndicator` implementation (§6 above) — currently undefined.
- §9: the card-row spec gets the interaction contract from §3 above attached
  to it (chevron ⟺ navigable).

## Left owed — nothing on this surface

Every rule in this document resolves to a concrete class, token, or existing
component to point at. Nothing here required inventing a value this phase
couldn't compute; the one owed value in the whole redesign (the chart
palette) belongs to the web surface and is marked there.
