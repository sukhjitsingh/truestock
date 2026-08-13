# Truestock design system

Binding rules for every screen built after this document. If you need a color, size, or
component pattern that isn't here, that is a signal to extend this file and
`app/globals.css` together — not to reach for an arbitrary Tailwind value. Nothing here is
a suggestion; the frontend and back-office agents should treat this as literal spec.

Source input: `docs/design-reference.md` (the Dribbble reference, with its own
"Where we deliberately diverge" section — already resolved into the rules below).
Governing constraints: `CLAUDE.md` — dim-bar UI, one-handed reach, role-gated cost data.

Live proof of every rule below: `prototypes/design-system.html` — open it directly in a
browser (no build step, no network) and toggle the theme switch top-right.

---

## 1. Theming mechanism

Two themes, one token set, one component tree — never fork a component per theme.

- `:root` holds the **light** theme values. This is a shadcn convention (its tooling and
  `dark:` variant assume `:root` = light), not a statement that light is the app's
  default experience.
- `.dark` (a real class, applied with `@custom-variant dark (&:where(.dark, .dark *));`
  in `app/globals.css`) overrides those same variable names with the **dark** values.
- **The counting route hardcodes `className="dark"`** on its root layout element —
  never conditional on `prefers-color-scheme`, a cookie, or a user setting. That is what
  "dark is the default, not an option" means in code: the primary experience is always
  dark regardless of the phone's OS theme.
- **The back-office route renders with no `.dark` class** and gets light — it's used at
  a desk, full daylight brightness is correct there.
- If a future back-office dark toggle is wanted, it is exactly "add/remove `.dark`" —
  no component should ever need to change to support it.

---

## 2. Palette

All ratios computed with the WCAG relative-luminance formula, not eyeballed. "Body text"
target is 4.5:1; "large text / UI borders" target is 3:1. Where the reference shot's own
value failed, the corrected value and its reason are noted — the reference is a visual
direction, not an accessibility audit.

### Light theme (back office)

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `--background` | `#F7F7F5` | Page background | — |
| `--foreground` | `#111111` | Primary text | 17.60:1 on background |
| `--card` | `#FFFFFF` | Card / input surface | — |
| `--card-foreground` | `#111111` | Text on card | 18.88:1 on card |
| `--muted` | `#EFEFEC` | Recessed surface | — |
| `--muted-foreground` | `#6B6B6B` | Secondary text | 5.33:1 on white |
| `--primary` | `#0A0A0A` | Primary button / inverted surface | — |
| `--primary-foreground` | `#FFFFFF` | Text on primary | 19.68:1 |
| `--secondary` | `#EFEFEC` | Secondary button fill | — |
| `--accent` | `#2563EB` | **Brand blue** (Tailwind blue-600) | — |
| `--accent-foreground` | `#FFFFFF` | Text on accent fill | 5.17:1 |
| `--destructive` | `#C4304F` | Destructive action fill | — |
| `--destructive-foreground` | `#FFFFFF` | Text on destructive | 5.41:1 |
| `--border` | `#E4E4E1` | Decorative hairline (cards, dividers) | ~1.2:1 — see §5 |
| `--input` | `#8C8C8C` | Functional border (inputs, outline buttons) | 3.37:1 on white |
| `--ring` | `#2563EB` | Focus ring | same as accent |
| `--header` | `#0A0A0A` | Detail-header block | — |
| `--header-foreground` | `#FFFFFF` | Text on header | 19.68:1 |
| `--success` / `--success-bg` | `#1F7A3D` / `#E4F5E6` | Status pill: in stock | 4.73:1 |
| `--warning` / `--warning-bg` | `#92600A` / `#FDF0DC` | Status pill: low / in progress | 4.78:1 |
| `--negative` / `--negative-bg` | `#B8305A` / `#FDE8EC` | Status pill: out of stock | 4.97:1 |

**Adjusted from the reference shot** (all three failed AA as measured):
`--muted-foreground` (was `#8A8A8A`, 3.45:1 → now 5.33:1), `--success` (was `#4A9B5C`,
3.01:1 → now 4.73:1), `--negative` (was `#D2426B`, 3.79:1 → now 4.97:1), `--warning`
(was `#E09A3C`, 2.11:1 → now 4.78:1). Same hue family in every case, just darkened
enough to clear body-text contrast on its own tint.

### Dark theme (counting app, default)

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `--background` | `#0B0B0C` | Page background | — |
| `--foreground` | `#F5F5F4` | Primary text | 18.03:1 on background |
| `--card` | `#17181A` | Card / input surface | — |
| `--card-foreground` | `#F5F5F4` | Text on card | 16.28:1 on card |
| `--muted` | `#131315` | Recessed surface | — |
| `--muted-foreground` | `#A8A8A5` | Secondary text | 8.25:1 on background, 7.45:1 on card |
| `--primary` | `#F5F5F4` | Primary button (bright, not black — see below) | — |
| `--primary-foreground` | `#0A0A0A` | Text on primary | 18.03:1 |
| `--secondary` | `#1E1E21` | Secondary button fill | — |
| `--accent` | `#60A5FA` | **Brand blue** (Tailwind blue-400) | — |
| `--accent-foreground` | `#0A0A0A` | Text/icon on accent fill | 8.26:1 |
| `--destructive` | `#D33039` | Destructive action fill | — |
| `--destructive-foreground` | `#FFFFFF` | Text on destructive | 4.94:1 |
| `--border` | `#232326` | Decorative hairline | — |
| `--input` | `#6B6B6B` | Functional border | 3.33:1 on card, 3.69:1 on background |
| `--ring` | `#60A5FA` | Focus ring | same as accent |
| `--header` | `#121317` | Detail-header block (NOT inverted to white, see below) | — |
| `--header-foreground` | `#F5F5F4` | Text on header | 17.02:1 |
| `--success` / `--success-bg` | `#6FCF8E` / `#14301F` | Status pill: in stock | 7.46:1 |
| `--warning` / `--warning-bg` | `#F0B429` / `#3A2A10` | Status pill: low / in progress | 7.42:1 |
| `--negative` / `--negative-bg` | `#F0718A` / `#3A1620` | Status pill: out of stock | 5.65:1 |

**Why `--primary` is bright, not the black-fill button from the reference:** the
reference's primary buttons work because they invert a light page to black. Our dark
theme's page is already near-black, so the equivalent inversion is a *bright* fill —
`--primary` is a near-white surface with near-black text. This preserves the "primary
action is the highest-contrast thing on screen" property the reference was going for.

**Why `--header` is `#121317`, not white:** literally inverting the header block to
white in the dark theme (mirroring the light-theme header) would put a full-brightness
rectangle at the top of a phone screen held close to the face in a dim bar — the exact
glare problem CLAUDE.md's "dim-bar UI" rule exists to prevent. Instead the header is a
deep, slightly cooler-than-background surface; identity comes from the `--accent` rule/
icon and the bright `--header-foreground` text, not from raw brightness. The light theme
keeps the literal reference treatment because a desk in daylight has no glare problem.

### Chart palette (owed) — blocking prerequisite for any chart, in either theme

`--chart-1` is real (brand blue, `#2563EB` light / `#60A5FA` dark) — already computed,
already collision-free with status. **`--chart-2` through `--chart-5` are deliberately
left with an empty value in `app/globals.css`** (`--chart-2: /* owed */ ;`, same pattern
in `.dark`), not a placeholder hex. They previously held byte-identical copies of
`--success`/`--warning`/`--negative`, which is the defect this owes fixes: a categorical
series in those hues would put a green wedge and a red wedge on a stock-inventory
dashboard, where green and red already mean "in stock" and "86'd" — this project's
signature failure mode, a value that renders fine, looks right, and means something
other than what it says.

**No chart, sparkline series, or any other component may consume `--chart-2` through
`--chart-5` until a value is computed for each, in both themes, against every rule
below** — this is a requirement and a method, not a proposed set of hexes; picking
plausible-looking values without running the computation is exactly the failure this
section exists to prevent:

- Five or more hues total (including `--chart-1`), mutually distinguishable from each
  other.
- Distinguishable in both `:root` (light) and `.dark` — computed independently per
  theme; a hue that clears the bar in light does not automatically clear it in dark.
- Distinguishable under protanopia, deuteranopia, and tritanopia — checked with a
  simulator, not eyeballed.
- Does not reuse, and does not read as adjacent to, `--success` / `--warning` /
  `--negative` in either theme.
- Contrast computed against **both** `--background` and `--card`, in **both** themes,
  using the same WCAG relative-luminance method as every other color in §2 — not
  eyeballed.
- Color reinforces, never carries alone — a direct label or pattern fill differentiates
  series first; color confirms.

None of the primitives in §9 (meter, sparkline, stat tile) consume a `--chart-*` token
by default — their color comes from a status token or `--foreground`/
`--muted-foreground`. Only a genuine multi-series chart needs this palette, and no
chart is built this phase (Phase 4, per `library-comparison.md`).

---

## 3. Brand vs status — the binding rule

**Brand is blue (`--accent`, `#2563EB` light / `#60A5FA` dark). Green, amber, and red are
reserved exclusively for stock and count-session status.** This is the resolution to
divergence #6 in `docs/design-reference.md`.

- **Brand blue** appears on: primary/active tab icon + label, focus rings, links,
  the search-and-scan field's scan icon, selected/active states in nav and forms, and
  any small brand accent (a rule, an icon, a highlighted row). It is never used to mean
  "good" or "available."
- **Green (`--success`)** means only: in stock / available / count step completed.
- **Amber (`--warning`)** means only: low stock / count in progress / needs attention.
- **Red (`--negative`)** means only: out of stock / 86'd / count step blocked.
  (`--destructive` is a related but distinct red used only for destructive *actions* —
  delete, remove, discard — never for a status pill. Don't cross the two.)
- A screen must never use green/amber/red for decoration, and must never use blue to
  express stock status. If a component needs both a status and a "this is selected/
  active" affordance at once (e.g. an active tab that happens to represent a low-stock
  view), the selection state is a weight/underline/icon-fill change, not a color change —
  color stays reserved for status.

---

## 4. Type scale

Defined as Tailwind v4 `--text-*` theme keys in `app/globals.css`, each with its correct
line-height/weight/letter-spacing riding along automatically — apply the class, don't
hand-tune leading or tracking next to it.

| Class | Size | Weight | Use |
|---|---|---|---|
| `text-numeral-lg` | 48px | 700 | **The number.** Fill level / quantity being entered on the counting screen. |
| `text-header-title` | 28px | 600 | Entity title in the detail-header block (product name, count session name). |
| `text-numeral-md` | 24px | 600 | Row-level quantity or value. |
| `text-row-title` | 18px | 600 | Card row title. |
| `text-numeral-sm` | 17px | 600 | Inline counters — stepper value, pill count, bar total. |
| `text-row-subtitle` | 15px | 400 | Card row subtitle / SKU, muted-foreground color. |
| `text-body` | 16px | 400 | Default body/paragraph text. |
| `text-screen-title` | 13px | 600, tracked 0.06em | Centered uppercase screen title. |
| `text-caption` | 13px | 400 | Timestamps, helper text. |
| `text-label` | 11px | 600, tracked 0.06em | Field labels, status pill text, tab bar labels — always `uppercase` alongside this class. |

All numerals render with `tabular-nums` by default (set globally on `body` in
`globals.css`) — never opt in per component, columns must line up everywhere quantities
or money appear.

**Capitalization — binding convention.** Always write label copy in sentence case in
source; the `uppercase` utility that already rides along with `text-label` and
`text-screen-title` handles the visual capitalization. **Never hardcode literal caps in
JSX or HTML** (`"Just counted"`, not `"JUST COUNTED"`). Two reasons this is binding, not
a style preference: copy that needs changing later changes in exactly one place — the
string — rather than needing a second check of whether the string itself is already
shouting; and a screen reader announces `JUST COUNTED` as a shouted, acronym-like
string, while `text-transform: uppercase` is presentation-only and does not change how
assistive tech announces the text underneath it. This applies everywhere `text-label`
or `text-screen-title` is used, on both surfaces.

---

## 5. Spacing, radius, elevation

### Spacing
Named on top of Tailwind's default 4px scale, usable on any spacing utility
(`gap-*`, `p-*`, `min-h-*`, `size-*`):

| Token | Value | Use |
|---|---|---|
| `card-gap` | 12px | Vertical gap between stacked cards (cards are separate, never a joined list) |
| `card-pad` | 16px | Card internal padding |
| `bar-pad` | 16px | Bottom action bar / header horizontal padding |
| `section-gap` | 24px | Gap between page sections |
| `tap-min` | 44px | **Absolute floor** for any tappable target |
| `tap-primary` | 56px | Floor for anything on the primary count loop (tenths buttons, scan trigger, close-count) |
| `action-bar` | 96px | Bottom clearance a scrolling region reserves for the fixed action bar (`pb-action-bar`) |

`action-bar` is 56px button + 2×16px bar padding + 8px breathing room. It exists as a
token rather than a per-screen `pb-*` guess because the failure is silent and screen-local:
eyeball it on four screens and the fifth has its last row half-covered by the bar, which
on the count-session screen is the row someone just scanned.

### Radius
`--radius: 1rem` (16px) is the base; the rest follow shadcn's calc convention so a later
`shadcn init` merges cleanly:

| Class | Value | Use |
|---|---|---|
| `rounded-sm` | 12px | Small controls |
| `rounded-md` | 14px | Buttons, inputs, search field |
| `rounded-lg` | 16px | Cards |
| `rounded-xl` | 20px | Detail-header block, sheets/modals |
| `rounded-full` | pill | Status pills, avatars/monogram tiles, tab active indicator |

### Elevation policy: hairline borders, no shadows
The reference carries every edge with a 1px border and flat fill — no drop shadows
anywhere, and that policy is adopted as-is. Reasons: shadows read as "float," which
implies draggable/movable; this is a data-entry tool where nothing floats. Shadows are
also markedly harder to see at low brightness in a dark bar than a border is. Two
exceptions, both functional rather than decorative:
1. **Focus rings** — a 2px outline in `--ring`, required on every interactive element
   (see §7). This is an accessibility affordance, not elevation.
2. Nothing else. Do not add `shadow-*` utilities for cards, sheets, or modals. Depth is
   communicated by background-color steps (`background` → `card` → `muted`) and the
   12px card gap, not by shadow.

---

## 6. Tap targets

- **44px (`tap-min`) is the absolute floor** for anything tappable anywhere in the app —
  tab bar items, chevrons, pill buttons, icon buttons. Encoded as `min-h-tap-min` /
  `min-w-tap-min` / `size-tap-min`, not as a rule you have to remember to apply by hand.
- **56px (`tap-primary`)** is the floor for the primary count loop specifically: the
  tenths stepper buttons, the scan trigger, the bottom action bar buttons. These should
  usually exceed the floor, not just meet it — this is the one-handed, wet-hand, holding-
  a-bottle interaction, it gets the most generous target in the app.
  - The visual counting-screen agent should treat `tap-primary` as a minimum, not a
    target — the tenths grid in particular can and should run larger.
- **Small visual elements may stay small** (e.g. the 32px stepper circle from the
  reference) **only if they are not themselves interactive.** If a stepper or timeline
  node becomes tappable (jump to step), expand the *hit area* with padding to reach
  `tap-min` — the 44px target is invisible; the circle can stay visually small. Never
  ship a visually-and-functionally-32px tap target.

### Back-office density (web only) — a different floor, not a relaxed one

The 44/56px rules above are a **phone** rule (one-handed, wet-hand, holding-a-bottle)
and do not apply to the back office, which is used at a desk. The back office has its
own, lower floor — restated here so it isn't confused with "no floor":

- **36px** is the minimum for any back-office interactive control that lives inside a
  dense data surface — a table row's Edit button, a row-overflow `⋯` trigger, a
  destructive icon button (Remove barcode, etc.). Being destructive does not justify
  going smaller than a neutral control at the same spot.
- **44px (`size-tap-min`)** is still the floor for anything that is identity or primary
  navigation rather than a dense row control — the account/avatar menu button (§9) is
  the concrete example: it is the only place in the back office a user signs out, so it
  gets the same floor as the counting surface's tab bar, not the table's 36px.
- **57px (`--spacing-row-office`, `app/globals.css`)** is the one table-row-height
  token, used everywhere a back-office table renders a row — see §9's Table spec. Cell
  padding inside it is never zero vertical; pair with `py-2` (8px) minimum so two-line
  cells (the stock cell, the product-name-plus-SKU cell) get real clearance.
- Full keyboard navigation and visible focus rings apply identically to the back
  office — §7 below is unconditional in both themes and on both surfaces, and the
  reference shot's total absence of visible focus states is not adopted.
- The office route uses the standard responsive viewport
  (`width=device-width, initial-scale=1`, the Next.js App Router default) — never a
  fixed-width `<meta viewport>` or a `min-width` on `body` that blocks pinch-zoom.
  Below a density breakpoint, a table gains horizontal scroll inside its own container
  rather than the page blocking zoom to preserve a fixed desktop layout.

---

## 7. Accessibility floor

- Body text ≥ 4.5:1, large text (18px+/14px+bold) and UI component borders ≥ 3:1 — in
  **both** themes. Every ratio in §2's tables was checked against this; anything that
  failed as measured from the reference was corrected and is called out.
- **Every interactive element has a visible focus state.** `app/globals.css` sets a
  global `:focus-visible` outline (`2px solid var(--color-ring)`, 2px offset) as a floor
  under whatever shadcn's own component focus rings add later — don't remove it.
  **No component may set `outline: none` (or otherwise suppress the visible focus
  indicator) without providing a substitute that is at least as visible — never zero
  substitutes.** A `border-color` change plus an inset ring is an acceptable substitute
  pattern; a bare `outline: none` on a form field with nothing replacing it is not,
  regardless of how minor the field looks.
- **Every interactive element has an accessible label.** Icon-only buttons (scan trigger,
  close/X, overflow menu, chevron-as-button) need `aria-label`; decorative icons that sit
  next to visible text need `aria-hidden="true"` so screen readers don't double-announce.
- Motion is functional only — a scan confirmation, a value change, a saved-state pulse.
  Never a decorative transition. If you can't say what state change a motion is
  confirming, don't add it.
- **A screen never blocks pinch-zoom or reflow.** No fixed-width `<meta viewport>`, no
  `min-width` on `body` — see §6's back-office density note for the concrete rule this
  replaces.

---

## 8. The role-gated value rule

Cost and value are role-gated (`CLAUDE.md` invariant 8; `docs/design-reference.md`
divergence #5). The server **omits** `unitCostAtCount`, `extendedValue`, `totalValue` etc.
entirely for `staff` — they arrive as `undefined`, not `0`. The UI contract:

1. **A money value component renders nothing when its prop is `undefined` — not `$0.00`,
   not `—`, not an empty styled box.** `$0.00` reads as "this bottle is worthless," which
   is a wrong number, not a hidden one — exactly the failure mode CLAUDE.md calls out as
   worst-case. An em-dash or blank container still tells the viewer "there's a number
   here you can't see," which is its own small leak.

   ```tsx
   function Money({ cents }: { cents?: number }) {
     if (cents === undefined) return null;
     return <span className="text-numeral-sm tabular-nums">{formatCents(cents)}</span>;
   }
   ```

2. **The row's layout itself branches on presence — it does not reserve a blank track for
   absent data.** A card row's qty/value line is a two-column grid only when a value
   exists; with no value it collapses to one column, left-aligned, full width:

   ```tsx
   <div className={value !== undefined
     ? "grid grid-cols-[1fr_auto] items-baseline gap-2"
     : "grid grid-cols-1"}>
     <span className="text-numeral-sm text-card-foreground">{qty} pcs</span>
     <Money cents={value} />
   </div>
   ```

   A staff member's row and an owner's row are legitimately *different layouts* for the
   same product, not the same layout with a hidden cell. Never use `opacity-0`,
   `invisible`, or a fixed-width empty `<span>` to "reserve space" for a value the viewer
   isn't permitted to see — that reserved space is itself the leak.

3. **The same branch applies to summary components** — the bottom action bar's primary
   button is two lines (`CLOSE COUNT` / `$5,820.00`) only when the viewer can see cost;
   otherwise it is a single centered line (`CLOSE COUNT`), never a two-line button with a
   blank second line.

4. **Never hide cost with CSS** (`hidden`, `sr-only`, `opacity-0` on a populated value).
   If the value is in the DOM at all for a `staff` request, that's a server bug, not a
   styling one — the component contract above only works because the prop is genuinely
   absent.
5. **"No value" is not one case — classify which of these four it is before choosing a
   treatment.** Role-gating (points 1–4 above) is one of four structurally different
   reasons a value can be missing, and collapsing them to one word or one style would be
   wrong. Any future absent-value component classifies itself against this list; see
   §9's Null-value spec for the exact rendering per case.
   1. **Structurally not applicable** — the field does not exist for this row's *type*,
      by design (`case_size` on a spirit). Renders as `—` (em dash).
   2. **Applicable but not yet entered** — the field should exist for this row
      eventually but hasn't been captured yet (an uncosted product's unit cost, a
      product with no par). Renders as `Not entered`.
   3. **Role-gated** — the viewer is not permitted to see it (this section, points
      1–4). Renders as nothing — no word, no dash, no styled box.
   4. **No basis exists yet to derive it** — e.g. on-hand/valuation when no count has
      ever closed. Not a cell value at all; a full sentence in the Empty state pattern
      (§9), e.g. "No count has closed yet — on-hand unknown."

---

## 9. Component specs

Every spec below is the literal Tailwind class string to use. Deviating requires
extending this document, not inventing inline.

### Card row
```html
<article class="flex items-start gap-3 rounded-lg border border-border bg-card p-card-pad">
  <div class="flex size-16 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
    <!-- category glyph or monogram — 64px footprint, replaces product photography
         per divergence #4 (no file storage / no photos in MVP) -->
  </div>
  <div class="min-w-0 flex-1">
    <div class="flex items-start justify-between gap-2">
      <h3 class="truncate text-row-title text-card-foreground">Product name</h3>
      <svg class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true"><!-- chevron --></svg>
    </div>
    <p class="truncate text-row-subtitle text-muted-foreground">SKU-1234</p>
    <span class="mt-2 inline-flex w-fit items-center rounded-full bg-success-bg px-3 py-1 text-label uppercase text-success">In stock</span>
    <!-- qty / value line — see §8 for the value-present vs value-absent class branch -->
    <div class="mt-2 grid grid-cols-[1fr_auto] items-baseline gap-2">
      <span class="text-numeral-sm text-card-foreground">2 pcs</span>
      <span class="text-numeral-sm tabular-nums text-card-foreground">$600.00</span>
    </div>
  </div>
</article>
```
Cards stack with `gap-card-gap` (12px) between them — never a joined/divided list.

**Interaction contract — binding, exact both ways.** A card is either **passive** (no
chevron, does not navigate) or **active** (has a chevron, and the chevron — or an
equivalently sized, equivalently labelled control occupying the same visual slot — is
the real, focusable `<button>` or `<Link>` that does the navigating). **The card's
`<article>` container is never itself wrapped in an `<a>`, and never carries an
`onClick`** — that nests the heading inside a link (the heading text becomes the link's
accessible name) and concatenates the row's entire visible content into one unreadable
accessible name. Concretely:
- The chevron, when present, carries its own `min-w-tap-min` hit area and
  `aria-label="View {product name}"` (name the destination, not the icon) — it is what
  carries the `href`/`onClick`. The rest of the card's text stays presentational.
- A card with no chevron renders no navigation affordance of any kind — no
  `cursor: pointer`, no hover treatment implying tap-ability.
- This is the same principle as the back office's row-click ban (a table `<tr>` never
  carries the edit affordance — see the Table spec below): an explicit control over an
  implicit, whole-container one.

### Detail header (black/inverted block)
```html
<header class="rounded-b-xl bg-header px-bar-pad pb-8 pt-6 text-header-foreground">
  <div class="flex items-center justify-between">
    <button aria-label="Close" class="flex size-11 items-center justify-center rounded-full border border-header-foreground/20">
      <svg class="size-5" aria-hidden="true"><!-- x --></svg>
    </button>
    <button aria-label="More actions" class="flex size-11 items-center justify-center rounded-full border border-header-foreground/20">
      <svg class="size-5" aria-hidden="true"><!-- overflow dots --></svg>
    </button>
  </div>
  <h1 class="mt-4 text-header-title">Count #1246799</h1>
  <div class="mt-3 flex flex-wrap items-center gap-2">
    <span class="rounded-full border border-header-foreground/25 px-3 py-1 text-label uppercase">TAP-3</span>
    <span class="rounded-full bg-warning-bg px-3 py-1 text-label uppercase text-warning">In progress</span>
  </div>
  <div class="mt-4 flex items-center gap-2 text-caption text-header-foreground/70">
    <svg class="size-4" aria-hidden="true"><!-- calendar --></svg>
    July 25, 2026
  </div>
</header>
```

### Bottom action bar
```html
<div class="fixed inset-x-0 bottom-0 z-40 flex gap-3 border-t border-border bg-background p-bar-pad">
  <button class="min-h-tap-primary flex-1 rounded-md border border-input bg-transparent text-label uppercase text-foreground">
    Cancel
  </button>
  <!-- value present (owner/manager) -->
  <button class="flex min-h-tap-primary flex-1 flex-col items-center justify-center gap-0.5 rounded-md bg-primary text-primary-foreground">
    <span class="text-label uppercase">Close count</span>
    <span class="text-numeral-sm tabular-nums">$5,820.00</span>
  </button>
  <!-- value absent (staff) — single line, never a blank second line -->
  <button class="flex min-h-tap-primary flex-1 items-center justify-center rounded-md bg-primary text-primary-foreground">
    <span class="text-label uppercase">Close count</span>
  </button>
</div>
```
Both buttons equal width, `rounded-md` (14px), `min-h-tap-primary` (56px floor).

### Search + scan field
```html
<div class="flex h-tap-min items-center gap-2 rounded-md border border-input bg-card px-4">
  <svg class="size-5 shrink-0 text-muted-foreground" aria-hidden="true"><!-- search --></svg>
  <input
    type="search"
    placeholder="Search products"
    class="min-w-0 flex-1 bg-transparent text-body text-foreground placeholder:text-muted-foreground focus:outline-none"
  />
  <button aria-label="Scan barcode" class="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-md text-accent">
    <svg class="size-5" aria-hidden="true"><!-- barcode/scan frame --></svg>
  </button>
</div>
```
Scan is always paired with search in one control, per `CLAUDE.md` — never a scan-only
entry point, damaged labels and house infusions need the picker.

### Status pill
```html
<span class="inline-flex items-center rounded-full bg-success-bg px-3 py-1 text-label uppercase text-success">In stock</span>
<span class="inline-flex items-center rounded-full bg-warning-bg px-3 py-1 text-label uppercase text-warning">Low</span>
<span class="inline-flex items-center rounded-full bg-negative-bg px-3 py-1 text-label uppercase text-negative">Out</span>
```

### Stepper
Progress indicator only — not a navigation control, per divergence #2 (scan-to-enroll is
one screen, the 5-step wizard from the reference is discarded). Use this spec only for
genuinely multi-step back-office flows.
```html
<ol class="flex items-center">
  <li class="flex items-center gap-2">
    <span class="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground text-numeral-sm">
      <svg class="size-4" aria-hidden="true"><!-- check --></svg>
    </span>
    <span class="text-label uppercase text-foreground">Details</span>
  </li>
  <li class="mx-2 h-px w-8 bg-border" aria-hidden="true"></li>
  <li class="flex items-center gap-2">
    <span class="flex size-8 items-center justify-center rounded-full border-2 border-foreground text-numeral-sm text-foreground">2</span>
    <span class="text-label uppercase text-foreground">Pricing</span>
  </li>
  <li class="mx-2 h-px w-8 bg-border" aria-hidden="true"></li>
  <li class="flex items-center gap-2">
    <span class="flex size-8 items-center justify-center rounded-full border-2 border-input text-numeral-sm text-muted-foreground">3</span>
    <span class="text-label uppercase text-muted-foreground">Review</span>
  </li>
</ol>
```
If a step circle becomes tappable, wrap it in a `min-h-tap-min min-w-tap-min` hit area —
the visible circle stays 32px, the tap target does not.

### Status timeline
Maps count-session state `draft → in_progress → submitted → reviewed → closed`.
```html
<ol class="flex flex-col">
  <li class="flex gap-3">
    <div class="flex flex-col items-center">
      <span class="size-3 rounded-full bg-success"></span>
      <span class="w-px flex-1 bg-border"></span>
    </div>
    <div class="pb-6">
      <p class="text-row-subtitle font-semibold text-foreground">Draft created</p>
      <p class="text-caption text-muted-foreground">Jul 18, 2026</p>
    </div>
  </li>
  <li class="flex gap-3">
    <div class="flex flex-col items-center">
      <span class="size-3 rounded-full border-2 border-accent bg-background"></span>
      <span class="w-px flex-1 bg-border"></span>
    </div>
    <div class="pb-6">
      <p class="text-row-subtitle font-semibold text-foreground">In progress</p>
      <p class="text-caption text-muted-foreground">Started Jul 25, 2026</p>
    </div>
  </li>
  <li class="flex gap-3">
    <div class="flex flex-col items-center">
      <span class="size-3 rounded-full border-2 border-input bg-background"></span>
    </div>
    <div>
      <p class="text-row-subtitle text-muted-foreground">Closed</p>
    </div>
  </li>
</ol>
```
Done = filled `success`; current = `accent`-ringed (brand, not status — it means "this is
where you are," not "this is good"); upcoming = `input`-ringed, muted text.

### Bottom tab bar
```html
<nav class="grid grid-cols-4 border-t border-border bg-background" aria-label="Primary">
  <a href="#" aria-current="page" class="flex min-h-tap-min flex-col items-center justify-center gap-1 text-foreground">
    <svg class="size-6" aria-hidden="true"><!-- filled icon --></svg>
    <span class="text-label font-semibold">Count</span>
  </a>
  <a href="#" class="flex min-h-tap-min flex-col items-center justify-center gap-1 text-muted-foreground">
    <svg class="size-6" aria-hidden="true"><!-- line icon --></svg>
    <span class="text-label">Catalog</span>
  </a>
  <a href="#" class="flex min-h-tap-min flex-col items-center justify-center gap-1 text-muted-foreground">
    <svg class="size-6" aria-hidden="true"></svg>
    <span class="text-label">Reports</span>
  </a>
  <a href="#" class="flex min-h-tap-min flex-col items-center justify-center gap-1 text-muted-foreground">
    <svg class="size-6" aria-hidden="true"></svg>
    <span class="text-label">Account</span>
  </a>
</nav>
```
Active = filled icon + `text-foreground` (bold via `text-label`'s built-in 600 weight);
inactive = line icon + `text-muted-foreground`. Never use `--accent` for the active tab
color — that would blur the brand/status rule at its most-repeated touchpoint; foreground
vs muted-foreground is the active/inactive signal, not color.

### Form field
```html
<div class="flex flex-col gap-1.5">
  <label for="upc" class="text-label uppercase text-foreground">Barcode / UPC</label>
  <input
    id="upc"
    class="min-h-tap-min rounded-md border border-input bg-card px-3 text-body text-foreground placeholder:text-muted-foreground"
  />
</div>
```
Paired fields (e.g. case size + case cost) sit in a `grid grid-cols-2 gap-3` row, per the
reference's half-width paired numeric fields.

### Sync indicator

Already built and correct as built — `SyncIndicator` in
`components/count/count-leg.tsx`. Documented here so future screens reach for the
existing pattern instead of reinventing a sync pill.
```tsx
<div
  className={cn(
    "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-label uppercase",
    pending > 0 ? "bg-warning-bg text-warning" : "bg-success-bg text-success",
  )}
  aria-live="polite"
>
  {pending > 0 ? <><CloudOff className="size-3.5" aria-hidden="true" /> {pending} pending</>
               : <><Check className="size-3.5" aria-hidden="true" /> Synced</>}
</div>
```
Non-interactive (a status display, not a tap target — exempt from the 44/56px floors).
`aria-live="polite"` and always visible, not only on failure — a dropped access point
must be seen, not silent. Never shrink below its current footprint to "declutter"; that
is exactly the 32px `.sync-pill` defect the audit found.

### Sheet

**No sheet ships in the product today, and this phase does not add one.** The
location-switcher sheet from `prototypes/count-scan.html` is explicitly not built — the
shipped `LocationPicker` (full-screen) plus the `StrayPicker` escape hatch already
satisfy "pick a location once per leg," and re-introducing a free location switch next
to the scan button is a locked-location violation (`AGENTS.md`), not a styling gap.

**If any sheet/modal is introduced later** (an overflow-actions sheet, a confirmation
sheet), it must, when closed:
- Not be reachable by Tab — `inert` on the container, or `display: none`, never
  `transform: translateY(100%)` alone (an off-screen but still-in-the-tab-order sheet is
  the exact defect this rule exists to prevent).
- Trap focus while open; restore focus to the trigger on close.
- Close on Escape, not click-only.
- Carry a heading naming its subject (`Edit Speed Rail`, not `Edit location` — the same
  rule as every other edit surface).

```html
<div class="fixed inset-0 z-50 bg-foreground/40" aria-hidden="true"><!-- scrim --></div>
<div role="dialog" aria-modal="true" aria-labelledby="sheet-title"
     class="fixed inset-x-0 bottom-0 z-50 rounded-t-xl border-t border-border bg-card p-card-pad">
  <div class="flex items-center justify-between">
    <h2 id="sheet-title" class="text-row-title text-card-foreground">Sheet title</h2>
    <button aria-label="Close" class="flex size-11 items-center justify-center rounded-full text-muted-foreground">
      <svg class="size-5" aria-hidden="true"><!-- x --></svg>
    </button>
  </div>
  <!-- content -->
</div>
```
No shadow (§5) — depth comes from the `--card`/`--background` step and the scrim, not a
drop shadow.

### Table

The catalog table (`components/office/catalog-table.tsx`) is the first TanStack Table
migration; every table after it follows this spec.
- **Columns are a per-role array built at call time — never `columnVisibility`.**
  `columnVisibility` keeps the column in the table model, so a role that shouldn't see
  it can still find it in the DOM; that is the exact P0.5 defect this bans.
  ```ts
  const columns = [
    productColumn,
    categoryColumn,
    onHandColumn,
    ...(canSeeCost ? [unitCostColumn] : []),
    ...(canManage ? [caseSizeColumn, editColumn] : []),
  ];
  ```
- `scope="col"` on every `<th>`.
- An accessible name via `<caption className="sr-only">` (e.g. "Catalog, 99 active
  products") — never silent.
- A real empty state in `<tbody>` when there are no rows (see Empty state below) —
  never an absent `<tbody>`.
- Row height: `h-row-office` / `min-h-row-office` (57px, `--spacing-row-office`), one
  token everywhere a table renders a row. Cell padding is never zero vertical — `py-2`
  (8px) minimum, so two-line cells get real clearance.
- Hover: `hover:bg-muted` on `<tr>` — reuses the existing token, no new color.
- Zebra, if used: alternating `bg-card` / `bg-muted` on `<tr>` — same reuse. Pick one of
  hover or zebra per table, not neither; don't combine them on the same table unless the
  hover state is still visually distinct from the zebra stripe.
- Numeric columns get `.num` (`text-align: right` only — `font-variant-numeric:
  tabular-nums` is already global on `body`, `.num` must never re-declare it). Apply to
  every genuinely numeric column (Stock, Unit cost, Size, Case, Started/Closed dates,
  Total value); never to an actions column.
- Truncated cells (`.truncate`) carry a `title` attribute with the untruncated value.
  Cells that should never wrap (the count-summary product column) get `max-width` +
  `.truncate` instead of being left to wrap and breaking the fixed row height.
- The row-level Edit button is a real, labelled `<button>` (`Edit`, or an icon +
  `aria-label="Edit {row name}"`), at least 36px (§6's back-office floor) — never the
  first item inside a hidden overflow menu, never a bare text link. Its edit form's
  heading names the row (`Edit Speed Rail`).
- A `⋯` overflow menu for secondary, non-Edit row actions tracks real open/closed state
  in `aria-expanded`, supports Escape and arrow-key navigation inside `role="menu"`,
  moves focus in on open and restores it to the trigger on close, and renders inside a
  container whose `overflow` does not clip it.

### Pagination

Required on every table, not optional polish — TanStack Table's pagination row model.
```html
<div class="flex items-center justify-between border-t border-border px-card-pad py-3">
  <p class="text-caption text-muted-foreground">Showing 1–20 of 99</p>
  <div class="flex items-center gap-2">
    <button aria-label="Previous page" class="flex h-9 min-w-9 items-center justify-center rounded-md border border-input px-2 text-caption text-foreground disabled:opacity-40" disabled>
      <svg class="size-4" aria-hidden="true"><!-- chevron-left --></svg>
    </button>
    <span class="text-caption text-foreground">Page 1 of 5</span>
    <button aria-label="Next page" class="flex h-9 min-w-9 items-center justify-center rounded-md border border-input px-2 text-caption text-foreground">
      <svg class="size-4" aria-hidden="true"><!-- chevron-right --></svg>
    </button>
  </div>
</div>
```
`h-9` (36px) meets the back-office floor (§6). Disabled state is `disabled` +
`disabled:opacity-40`, never a click handler that silently no-ops.

### Sort control

A real `<button>` inside each sortable `<th>` — never a decorative `<span
aria-hidden="true">` with `cursor: pointer` and no handler.
```html
<th scope="col" class="py-2 text-left">
  <button type="button" aria-sort="ascending" class="inline-flex items-center gap-1 text-label uppercase text-foreground">
    Unit cost
    <svg class="size-3.5" aria-hidden="true"><!-- up/down/neutral arrow, matches aria-sort --></svg>
  </button>
</th>
```
`aria-sort` (`"ascending"` / `"descending"` / `"none"`) lives on the `<th>` and is
updated live to match the button's state. Every column that plausibly benefits from
sorting gets it — not an inconsistent subset.

### Empty state

One pattern, reused everywhere a table or a derived figure has nothing to show.
```html
<div class="flex flex-col items-center gap-2 py-section-gap text-center">
  <p class="text-row-subtitle text-muted-foreground">No count has closed yet — on-hand unknown.</p>
  <button class="mt-2 inline-flex h-9 items-center rounded-md bg-primary px-4 text-label uppercase text-primary-foreground">
    Start a count
  </button>
</div>
```
`py-section-gap` (24px) vertical padding — not 64px, which is disproportionate to every
other spacing value in the system. A short sentence states *why*, not just "no
results"; a primary action renders where one exists ("Add a location," "Set a par
level"). This is also the pattern for the §8-point-5 "no basis exists yet" null-value
case (asOfCountId === null) and for a table's empty `<tbody>` (see Table above).

### Avatar / account menu

A real `<button>`, never a decorative `<div>` — the account button is the *only* place
in the back office a user signs out, and it is the parity equivalent of `/count/account`
on the counting surface.
```html
<button aria-label="Account menu" class="flex size-tap-min items-center justify-center rounded-full bg-muted text-label text-foreground">
  JM
</button>
<!-- opens a menu (role="menu") containing: signed-in name, email, role, Sign out -->
```
`size-tap-min` (44px) even though it sits inside the back office's otherwise 36px
density — this is identity + navigation, not a dense data-row control (§6). Initials
render `bg-muted text-foreground`, the same single neutral treatment as every other
identity tile in the product — no color-coded identity (see Chip/identity note below).
Never `aria-hidden="true"` on this control; it is the only user-identity element on the
screen.

### Filter pill

```html
<!-- applied -->
<button aria-pressed="true" class="inline-flex h-9 items-center rounded-full bg-primary px-3 text-label uppercase text-primary-foreground">
  Category: Spirits
</button>
<!-- unapplied -->
<button aria-pressed="false" class="inline-flex h-9 items-center rounded-full border border-input px-3 text-label uppercase text-foreground">
  Status: Active
</button>
```
**Facet-named, not value-named** — `Category: Spirits`, never a bare `Full counts` —
this is the one binding convention across every filterable screen, chosen because it
scales to filters this phase doesn't enumerate without inventing a new copy pattern per
screen. Applied = filled solid; unapplied = outline, no fill.

### View tab

Used where a screen has more than one view of the same data (e.g. Catalog / Needs
attention).
```html
<nav class="flex gap-6 border-b border-border" aria-label="View">
  <button aria-current="page" class="border-b-2 border-foreground pb-2 text-label font-semibold uppercase text-foreground">
    All products
  </button>
  <button class="border-b-2 border-transparent pb-2 text-label uppercase text-muted-foreground">
    Needs attention
  </button>
</nav>
```
Active = underline (`border-b-2 border-foreground`) + bold weight — **never a color
change.** Mirrors the counting app's tab-bar rule: selection is a
weight/underline/icon-fill change, color stays reserved for status/brand (§3).

### Banner

A persistent, inline notification strip — distinct from a Toast (transient,
auto-dismissing) and a Sheet (a blocking overlay). Used for standing context a screen
needs visible the whole time it's open: the "as of count #N" confirmation, the
excluded-lines honesty note on a count summary, a closed-count explanation.
```html
<div class="flex items-start gap-2.5 rounded-md border border-border bg-warning-bg p-3 text-warning">
  <svg class="mt-0.5 size-4 shrink-0" aria-hidden="true"><!-- info/warning glyph --></svg>
  <p class="text-row-subtitle">7 of 49 lines are unpriced and excluded from this total.</p>
</div>
```
Tone follows the status tokens: `bg-warning-bg text-warning` for something the viewer
should notice before trusting the number above it (excluded lines, a preview built from
mock data); `bg-success-bg text-success` for a closed/confirmed state (a closed-count
explanation); `bg-muted text-foreground` for a neutral, no-judgment note (an "as of
count #N" line that isn't itself good or bad news). Never `--accent` — a banner states a
fact about data, it is not a brand touchpoint. No shadow (§5). If a banner's presence or
content changes without a page reload, wrap it in `aria-live="polite"`, the same pattern
as the Sync indicator; a static banner present at initial render needs no live region.

### Popover

Used for a row's `⋯` overflow menu and similar transient, anchored controls.
```html
<div role="menu" class="min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground">
  <button role="menuitem" class="flex w-full items-center rounded-sm px-2 py-2 text-left text-row-subtitle hover:bg-muted">
    Audit stock
  </button>
</div>
```
**No shadow** — this is the one place this spec diverges from the raw reference shot,
which shadows its row-overflow popover; §5's no-shadow policy applies here too. Depth
comes from the `--popover`/`--popover-foreground` tokens plus a `border-border`
hairline. Tracks real `aria-expanded` state (never hardcoded `"false"`), supports
Escape and arrow-key navigation, moves focus in on open and restores it to the trigger
on close, and renders inside a container whose `overflow` does not clip it.

### Tooltip

```html
<span role="tooltip" class="rounded-md border border-border bg-popover px-2 py-1 text-caption text-popover-foreground">
  Excluded — no cost on file
</span>
```
Triggered on hover **and** keyboard focus (never hover-only — a keyboard user needs the
same information), dismissible with Escape, no shadow. Reserved for supplementary
explanation (why a value is excluded, what an abbreviation means) — never the only
place a required label lives; a tooltip that duplicates an already-visible label is
decoration, not a component.

### Toast

A transient, auto-dismissing notification for feedback that doesn't need to stay on
screen — not a substitute for the SET/ADD consequence line (which is a persistent
button-label change, not a toast) and not a substitute for a Banner (which is
standing, not transient).
```html
<div role="status" aria-live="polite" class="flex items-center gap-2 rounded-md border border-border bg-card p-3 text-card-foreground">
  <svg class="size-4 shrink-0 text-success" aria-hidden="true"><!-- check --></svg>
  <p class="text-row-subtitle">Location saved</p>
</div>
```
`role="status"` + `aria-live="polite"` for confirmations; `role="alert"` for errors
(interrupts immediately, does not wait for a pause). No shadow. Never used to deliver
information the user needs to act on later — that belongs in a Banner or an inline
field error, since a toast that has already dismissed itself cannot be re-read.

### Hover

`hover:bg-muted` is the one binding hover treatment for a genuinely interactive row
(a table `<tr>` with an Edit button, a menu item) — reuses the existing `--muted` token,
no new color. **A passive card (§9 Card row, no chevron) gets no hover treatment at
all** — hover implying tap-ability on a non-interactive surface is the same defect as a
`cursor: pointer` on a passive card.

### Zebra

Alternating `bg-card` / `bg-muted` on a table's `<tr>` elements — same token reuse as
Hover, no new color. Optional per table; when used, pick it *or* hover, not neither, and
keep the two visually distinguishable from each other if a table uses both (hover on an
already-`bg-muted` zebra row needs a state that still reads as "hovered").

### Chip

The `StatusPill` component (see Status pill above), reused for a second purpose: a
reason/action label rather than a stock/count status — e.g. `REASON_LABEL` in
`catalog-table.tsx` (`Needs producer`, `Needs case size`, `Needs cost`, `Needs par`),
rendered with `tone="warning"`. Same component, same visual shape
(`rounded-full px-3 py-1 text-label uppercase`) — this entry documents the second use
that §3's original Status pill spec didn't name, it does not introduce a new component.
`tone="neutral"` (`bg-muted text-muted-foreground`) is the chip treatment for a
non-judgment label (a location name, a size) that must not borrow a status tint to look
lively.

### Null-value

Renders the classification from §8 point 5 — the treatment is picked by *which* of the
four cases applies, not by a single shared style:
```html
<!-- 1. structurally not applicable -->
<span class="text-row-subtitle text-muted-foreground">—</span>
<!-- 2. applicable, not yet entered — same size as the data around it, never smaller -->
<span class="text-row-subtitle text-muted-foreground">Not entered</span>
<!-- 3. role-gated — nothing renders; the Money/value component returns null -->
<!-- 4. no basis exists yet — a full sentence via the Empty state pattern, not a cell value -->
```
**Never** italic, and never `text-caption` (13px) for case 2 — that was the P3.4 defect:
"Not entered" is information a manager acts on (it's what drives the "needs attention"
view), so it reads at the same weight as the data around it, not smaller/quieter than
it. Case 1 and case 2 are both `text-muted-foreground` but are not interchangeable
strings — a NULL `case_size` on a spirit is never "Not entered" (nothing will ever be
entered there), and a genuinely missing unit cost is never `—` (something should exist
and doesn't yet).

---

## 10. What the next two agents must not invent

- No new color outside §2's tokens. No new hex values, no `text-gray-500`-style raw
  Tailwind color utilities — every color reference goes through the tokens above.
- No `shadow-*` on cards, sheets, popovers, or modals — see §5 and §9's Popover spec.
- No tap target under 44px anywhere on the counting surface; nothing under 56px on the
  primary count loop. The back office has its own, lower, *not relaxed* floor — see §6's
  "Back-office density" subsection (36px dense-control floor, 44px for
  identity/navigation controls) — do not apply the phone floor to a table row, and do
  not apply the office's 36px floor to anything on the counting surface.
- No rendering of `$0.00`, `—`, or a blank reserved column for a role-gated value that is
  `undefined` — see §8, this is a correctness rule, not a style rule. See §8 point 5 and
  §9's Null-value spec for the other three "no value" cases and their own required
  treatment — collapsing all four to one word or one style is also wrong.
- No forking a component per theme — one component, two token sets, `.dark` class only.
- Green/amber/red stay status-only; brand stays blue-only — see §3.
- No `columnVisibility` for a role-gated table column — the column array is built per
  role at call time, or the column does not exist in the model at all. See §9's Table
  spec.
- No color-coded vendor/person identity. One neutral treatment
  (`bg-muted text-foreground`, initials) for every vendor and every person, everywhere —
  see §9's Avatar/account menu and Chip specs.
- No literal caps in JSX/HTML source (`"JUST COUNTED"`) — sentence case in source, the
  `uppercase` utility does the visual work. See §4.
- No chart, sparkline series, or any component drawn against `--chart-2` through
  `--chart-5` until each is computed per §2's "Chart palette (owed)" method — `--chart-1`
  is the only chart token safe to use today.
- No invented type size (a raw `14px`/`12px` etc.) and no invented letter-spacing
  (`.04em`) outside §4's defined scale — round to the nearest defined step
  (`text-caption` for the smaller cluster, `text-row-subtitle` for the larger) rather
  than adding a new size.
- No fixed-width `<meta viewport>` or a `min-width` on `body` that blocks pinch-zoom —
  see §6 and §7.

---

## Binding rule — no role switcher ships

The back-office prototypes carry a "Preview as Owner / Manager" toggle. It is **prototype
chrome only**, marked with a dashed amber outline and a "PROTOTYPE ONLY — NOT SHIPPED UI"
badge. It exists so a reviewer can see both role variants of a screen side by side without
signing in twice.

**Nothing resembling it may ship.** In production a user's role comes from the session and
is re-read from the database on every server action (`lib/authz.ts`). There is no client-side
role state, and therefore nothing for a user to switch. Concretely:

- Column sets are built **per role** — a manager's TanStack Table column-def array does not
  contain a cost column. It is never one array with a column hidden or filtered at render.
- The same applies to whole sections: the Pricing block on the product form is absent from a
  manager's DOM, not disabled, not blurred, not behind a lock icon.
- This mirrors the server, which **omits** `currentUnitCost`, `unitCostAtCount`,
  `extendedValue` and `totalValue` from the payload entirely for non-owners rather than
  sending zeros. See §8 and CLAUDE.md invariant 8.

A visible-but-locked cost field would also be a false affordance: it tells a manager a number
exists and that they are being denied it, which is worse product design than the number
simply not being part of their job.
