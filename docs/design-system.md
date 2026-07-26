# Handlebar design system

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

---

## 7. Accessibility floor

- Body text ≥ 4.5:1, large text (18px+/14px+bold) and UI component borders ≥ 3:1 — in
  **both** themes. Every ratio in §2's tables was checked against this; anything that
  failed as measured from the reference was corrected and is called out.
- **Every interactive element has a visible focus state.** `app/globals.css` sets a
  global `:focus-visible` outline (`2px solid var(--color-ring)`, 2px offset) as a floor
  under whatever shadcn's own component focus rings add later — don't remove it.
- **Every interactive element has an accessible label.** Icon-only buttons (scan trigger,
  close/X, overflow menu, chevron-as-button) need `aria-label`; decorative icons that sit
  next to visible text need `aria-hidden="true"` so screen readers don't double-announce.
- Motion is functional only — a scan confirmation, a value change, a saved-state pulse.
  Never a decorative transition. If you can't say what state change a motion is
  confirming, don't add it.

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

---

## 10. What the next two agents must not invent

- No new color outside §2's tokens. No new hex values, no `text-gray-500`-style raw
  Tailwind color utilities — every color reference goes through the tokens above.
- No `shadow-*` on cards, sheets, or modals — see §5.
- No tap target under 44px anywhere; nothing under 56px on the primary count loop.
- No rendering of `$0.00`, `—`, or a blank reserved column for a role-gated value that is
  `undefined` — see §8, this is a correctness rule, not a style rule.
- No forking a component per theme — one component, two token sets, `.dark` class only.
- Green/amber/red stay status-only; brand stays blue-only — see §3.

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
