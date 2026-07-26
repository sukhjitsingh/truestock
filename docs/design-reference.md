# Design reference — extracted from the Dribbble shots

The owner supplied two shots, one per surface. This file is the distillation — read it
instead of trying to fetch them (Dribbble blocks server-side fetching; the analysis below was
done by viewing the rendered pages in a browser).

| Surface | Shot | By |
|---|---|---|
| **Part A — counting app** (mobile) | [Inventory Store Branch Management App](https://dribbble.com/shots/25041260-Inventory-Store-Branch-Management-App) | DIGI.CO |
| **Part B — back office** (desktop) | [Ecomiq – SaaS E-Commerce Inventory Management](https://dribbble.com/shots/25782378-Ecomiq-SaaS-E-Commerce-Inventory-Management) | Bagus Fikri / Fikri Studio |

**These are references, not specs.** Where they conflict with `CLAUDE.md` or `docs/spec.md`,
those win. Each part has a "Where we deliberately diverge" section — read it before adopting
anything above it.

---

# PART A — Counting app (mobile)

Source: DIGI.CO, "Inventory Store Branch Management App"

---

## What the shot actually contains

Five frames, all mobile, all iPhone-framed on a dark green→black radial gradient backdrop.
The backdrop is presentation staging — it is **not** part of the app UI and must not be
copied into the product.

| Frame | Screens | What it teaches us |
|---|---|---|
| SALES ORDERS | list + detail | Row anatomy, status pills, paired bottom action bar, **search field with a scan icon** |
| SUPPLY CHAIN HUB | 3× menu grid | Full-width nav cards, isometric icons, uppercase labels |
| STOCK TRANSFERS | list + detail | Vertical status timeline, thumbnail rows |
| CREATE NEW PRODUCT | 3× wizard | Numbered stepper, form field styling, **barcode field** |
| (nav) | tab bar | 4-tab bottom nav, active = filled icon + bold label |

---

## Color

The reference app UI is **light mode**. Near-black and white do all the structural work;
green is the only brand hue and it is used sparingly.

| Role | Hex (measured) | Where it appears |
|---|---|---|
| Page background | `#F7F7F5` | Warm off-white, behind cards |
| Surface / card | `#FFFFFF` | Every card and input |
| Hairline border | `#EAEAEA` | 1px card and input outline — carries the edge, **not** shadow |
| Text primary | `#111111` | Titles, prices, values |
| Text secondary | `#8A8A8A` | Subtitles, SKU numbers, inactive tabs |
| Inverted surface | `#0A0A0A` | Detail-screen header block, primary buttons |
| Brand green | `~#4C9A5E` | Icon accents, active timeline nodes, "available" states |

**Status pills** — pale tinted background, saturated text, fully rounded, ~11px uppercase
with letter-spacing:

| State | Background | Text |
|---|---|---|
| Negative | `#FDE8EC` | `#D2426B` |
| Positive | `#E4F5E6` | `#4A9B5C` |
| In-progress | `#FDF0DC` | `#E09A3C` |

---

## Typography

- One geometric sans throughout. Tight, slightly condensed, low contrast. The project already
  loads **Geist** (`app/layout.tsx`) — it is a close match. Do not add a font dependency.
- **Screen titles**: uppercase, letter-spaced ~0.06em, medium weight, ~13–14px, centered in
  the header. This uppercase-letterspaced treatment is the single most recognizable trait of
  the reference — it appears on every screen title, field label, and button.
- **Field labels**: uppercase, letter-spaced, ~11–12px, `#111`. Sit directly above the input.
- **Row title**: ~17–20px, semibold, `#111`.
- **Row subtitle**: ~14–15px, regular, `#8A8A8A`.
- **Numerals**: right-aligned in rows. Use tabular figures so columns line up — the reference
  gets away without it because the numbers are fake and uniform; a real count will not.

---

## Component anatomy

### Card row (the workhorse)
```
┌─────────────────────────────────────────┐
│ [thumb]  Title text              ›      │   ← chevron top-right, not centered
│  64px    Secondary / SKU                │
│                                         │
│          2 pcs              €600.00     │   ← qty left, value right, same baseline
└─────────────────────────────────────────┘
```
- Radius ~16px, 1px `#EAEAEA` border, white fill, **no drop shadow**
- ~12px gap between cards; cards are separate, not a joined list
- Optional status pill sits under the subtitle

### Detail header (black block)
The detail screens invert the top ~40% of the screen to `#0A0A0A`:
```
  ✕                                    ⋮
  Project #1246799                          ← large, white, ~28px
  ( SO-090018 )  ( UNFULFILLED )   (+) (👤+)  ← outline pill + status pill, circular actions
  📅 NOVEMBER 10TH, 2024   ( UNINVOICED €5820.00 )  ← white summary pill
```
Then the body reverts to `#F7F7F5` with white cards. This gives the entity identity real
weight without a hero image. **This pattern is the best thing in the shot** — it maps
directly onto a count-session header.

### Bottom action bar
Two buttons, side by side, pinned to the bottom over a soft white fade:
- **Secondary**: white fill, `#EAEAEA` border, `#111` uppercase label
- **Primary**: `#0A0A0A` fill, white label, supports **two lines** — action on top, value
  beneath (`PICK ORDER` / `€5820.00`). Adopt this for `CLOSE COUNT` + total.
- Radius ~14px, height ~56px, equal width

### Search field
White pill, magnifier icon left, **barcode-frame icon right**. The reference already pairs
search with scan in one control — exactly what `CLAUDE.md` requires ("always offer a search
picker beside the scan button"). Adopt this directly.

### Stepper
Numbered circles `01…05` joined by a rule. Completed = filled black circle with a check;
current = black outline; upcoming = grey outline.

### Status timeline (STOCK TRANSFERS detail)
Vertical rail on the black header: filled green node = done, ringed node = current, grey =
upcoming, each with a label and date. Maps onto `draft → in_progress → submitted → reviewed
→ closed`.

### Bottom tab bar
4 tabs, line icons, label under each. Active = filled icon + `#111` bold label; inactive =
line icon + `#8A8A8A`.

---

## Where we deliberately diverge

These are the points where following the reference would break a stated requirement. Each
one is a decision, not an oversight.

1. **The reference is light mode. The counting screens must be dark.**
   `CLAUDE.md` — "Dim-bar UI. High contrast, large tap targets, dark mode." A `#F7F7F5`
   background at full brightness in a dark bar is a flashbulb in the user's face.
   **Resolution:** build the token set so the reference's *structure* (hairline borders, flat
   surfaces, uppercase labels, black/white contrast engine) survives a dark inversion. The
   counting app defaults to dark; the back office may use the light treatment as shot, since
   it is used at a desk. Both themes ship from one token set — do not fork the components.

2. **The 5-step "CREATE NEW PRODUCT" wizard is wrong for scan-to-enroll.**
   The shot spreads product creation over five paged steps. `CLAUDE.md` requires the
   enrollment form to complete in **under 20 seconds**, and calls it "the single highest-risk
   interaction in the MVP." Five steps cannot hit that.
   **Resolution:** keep the *field styling* (uppercase label above a bordered white input,
   paired half-width fields for related numbers). Discard the stepper. Scan-to-enroll is one
   screen, barcode pre-filled, minimum viable fields, everything else deferred to the back
   office.

3. **Tap targets in the shot are too small.** Row chevrons and the stepper circles are
   ~24px. The requirement is one-handed operation while holding a bottle.
   **Resolution:** 44px minimum for anything tappable, 56px+ for anything on the primary
   count loop. Tenths controls should be considerably larger than that.

4. **Product thumbnails don't exist here.** The reference leans on product photography in
   every row. Handlebar's MVP has **no file storage and no photos** — that is explicit scope.
   **Resolution:** replace the thumbnail with a category glyph or a monogram tile at the same
   64px footprint, so row rhythm is preserved. Do not introduce image upload.

5. **Prices are shown unconditionally.** In Handlebar, cost and value are role-gated
   (invariant 8) and the server *omits the field entirely* for non-owners — `unitCostAtCount`,
   `extendedValue`, and `totalValue` are absent, not zero.
   **Resolution:** the value slot in every row/summary component must render correctly when
   the field is `undefined` — collapsing cleanly, not showing `$0.00`, `—`, or an empty
   container that leaves the layout lopsided. Never hide cost with CSS.

6. **Green as the brand accent is a hazard in this domain.** In the reference green just means
   "brand." In an inventory tool, green/amber/red read as *status* — in stock, low, out.
   **Resolution:** reserve the three status tints strictly for stock and count state. Pick a
   distinct non-green brand hue, or use green only as brand and choose different status hues.
   Whichever is chosen, state the rule in the design system so screens do not drift.

---

# PART B — Back office (desktop)

Source: Bagus Fikri / Fikri Studio, "Ecomiq – SaaS E-Commerce Inventory Management"

One frame: a dense desktop inventory table. It is a different visual language from Part A —
light, information-dense, desk-oriented — and that is correct. The counting app and the back
office are used in different places by different people under different lighting. They share
the token set; they do not share the density.

## Shell layout

```
┌──┬──────────────────────────────────────────────────────────────────┐
│+ │ Fikri Store ⌄ / Inventory    [ ⌕ Search or Press '/' ]   🔔 💬 ◉ │  ← top bar
├──┼──────────────────────────────────────────────────────────────────┤
│▫ │  ☰  Inventory  ⋯  ⟳                          [ + Reorder ]       │  ← page header
│▫ │  ─────────────────────────────────────────────────────────────   │
│▫ │  ⊞ All product │ + View                        ⊙ View Settings   │  ← view tabs
│▫ │  [⌕ Search] │ (2 Feb - 14 apr ⌄) (Category ⌄) (Supplier ⌄) …     │  ← filter bar
│▫ │  ┌─────────────────────────────────────────────────────────────┐ │
│▫ │  │ Product name ⇅ │ SKU ⇅ │ Category ⇅ │ … │ Current Stock ⇅   │ │  ← sticky header
│▫ │  ├─────────────────────────────────────────────────────────────┤ │
│⚙ │  │ ▭ Macbook Pro…  │ MAC-09485 │ Electronic │ ◉ Urban Deals │…│ │
│» │  └─────────────────────────────────────────────────────────────┘ │
└──┴──────────────────────────────────────────────────────────────────┘
```

- **Icon rail** ~64px, white, no labels. Icons ~20px, `#8A8A8A`. Active item = white rounded
  tile with border + soft shadow. A single accent-filled square button pinned at the top is
  the global "create". A `»` expand affordance sits at the bottom.
- **Top bar** — workspace switcher (name + chevron), `/` breadcrumb separator, current page in
  bold. Centred command palette input, ~430px, light grey fill, placeholder literally names
  the shortcut: *"Search or Press '/' for commands"*. Right cluster: notifications with unread
  dot, messages, avatar.
- **Page header** — collapse toggle, page title ~28px bold, overflow `⋯`, a refresh/history
  icon, then the accent primary button hard right.
- **View tabs** — active has a black underline and black text; inactive grey. `+ View` creates
  a saved view.
- **Filter bar** — a search input, then dropdown pills. **The applied filter is filled solid
  black; unapplied filters are white with a border.** That is the whole active-filter
  affordance — no badge, no count. Clean and worth copying. `Manage Table` sits hard right.

## Table

- Header row: light grey fill, ~13px, grey, semibold, each sortable column carries a `⇅` glyph.
- Rows ~57px, separated by a bottom hairline only — **rows are not cards**. This is the
  opposite of Part A and it is right for density.
- Cells: 40px rounded thumbnail; product name truncates with an ellipsis rather than wrapping;
  SKU in a monospaced-feeling face; category as a small grey chip; supplier as a coloured
  circular avatar + name; unit price right-aligned.
- **Stock cell — the best idea in this shot.** Two lines:
  ```
  20 unit · Low
  ▰▱▱▱▱▱▱▱▱▱          ← 2px bar, width = on-hand ÷ par, colour = status
  ```
  A number, a word, and a bar in one cell. It reads at a glance across 97 rows.
  Note the empty state: rows at `0 unit` show **no bar and no status word** — the bar is
  omitted entirely rather than drawn at zero width.
- **Row overflow `⋯`** opens a popover: *Reorder · Audit Stock · Create Stock Alert · Stock
  History*. Radius ~10px, soft shadow, each item icon + label, hover = grey fill.

## Colour (Part B)

Structurally the same engine as Part A — near-black text, white surfaces, grey hairlines —
with one saturated accent used only for the primary action and the active rail button.
The shot's accent is **orange** (~`#EA6A1E`). See divergence B3 before using it.

---

## Where we deliberately diverge (Part B)

**B1. The stock bar must be driven by par, and par may not exist.**
The reference's bar implies a known maximum. Handlebar's `ProductPar` has a **nullable
`location_id`** and the MVP writes NULL rows only; plenty of products will have no par at
all. Follow the shot's own empty-state instinct: **no par → no bar and no status word**, just
the unit count. Never infer a denominator to make the bar drawable.

**B2. "Current Stock" is derived from the last CLOSED count, not live.**
`reorderList()` computes on-hand from the latest closed count and returns `asOfCountId`,
which is **null when no count has ever closed**. A table that silently shows stale or absent
figures as if they were live is exactly the plausible-but-wrong failure `CLAUDE.md` exists to
prevent. The back office must show an explicit "as of count #N / date" line, and a real empty
state when `asOfCountId` is null. Do not label anything "Current".

**B3. Do not introduce orange as a second brand colour.**
Part A's shot uses green as its accent, Part B's uses orange, and the design system has
already settled on a **blue** brand precisely so that green/amber/red stay reserved for stock
status (see `docs/design-system.md` §3). Orange collides with the amber "Low" status the very
same table renders. **Use the brand token from the design system; do not hardcode the
reference's orange.** If the owner wants orange as brand, that is a design-system change made
in one place, not a per-screen override.

**B4. No product thumbnails, no supplier avatars-as-photos.**
Same reason as Part A divergence #4 — the MVP has no file storage. Keep the 40px slot for
rhythm; fill it with a category glyph. Vendor "avatars" become deterministic coloured initial
tiles derived from the vendor name, not uploaded images.

**B5. Cost and price columns are role-gated (invariant 8).**
`manager` and `staff` never see cost or value, and the server **omits the fields entirely**.
A `Unit Price` column must not render as an empty column for a manager — the column itself is
absent from their table. Column sets are role-derived, not CSS-hidden. This also means the
TanStack Table column definitions must be built per role, not filtered at render time.

**B6. Density is fine here; tap-target minimums are not.**
Part A's 56px targets are a counting-app rule for one-handed phone use. The back office is
mouse-and-keyboard at a desk — 57px rows and 32px controls are appropriate. Do not inflate
the table to phone sizing. Do keep focus rings and keyboard navigation, which the shot omits
entirely.
