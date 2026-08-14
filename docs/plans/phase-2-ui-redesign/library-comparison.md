# Data visualization and table rendering — library comparison

**Phase:** ROADMAP Phase 2 (UI redesign).
**Question asked:** visx vs Chart.js vs TanStack, for the back office's dashboard
and table rendering.
**Date:** 2026-08-13. Sources: Context7 (`/airbnb/visx`, `/chartjs/chart.js`),
TanStack Charts docs, npm/bundle surveys.

---

## The decision, up front

| Concern | Choice |
|---|---|
| **Tables** | **TanStack Table v8** — already installed, already assumed by both binding design docs |
| **Meters, sparklines, stat tiles** | **No library.** Plain `<div>` and inline `<svg>` against the existing tokens |
| **Charts (Phase 4)** | **visx**, installed per-package |
| Chart.js | Rejected |
| TanStack Charts | Rejected |
| Recharts / shadcn charts | Named fallback, not chosen |

Nothing is installed in Phase 2. The chart decision is recorded now so Phase 4
does not re-litigate it, and so the Phase 2 spec can define chart *tokens* that a
Phase 4 implementation will actually be able to use.

---

## Starting position

Two facts reframe the question before any comparison runs.

**`@tanstack/react-table ^8.21.3` and `@tanstack/react-query ^5.101.4` are already
in `package.json` and imported by nothing.** Verified by grep: zero `@tanstack`
imports anywhere in `app/`, `components/` or `lib/`. Every table in the product is
a hand-written `<table>`; server state is server actions plus `router.refresh()`
plus a hand-rolled IndexedDB queue in `lib/count-queue.ts`.

**Both binding design docs already write their rules in TanStack's vocabulary.**
`docs/design-reference.md` B5 states the role-gating rule as: *"the TanStack Table
column definitions must be built per role, not filtered at render time."*
`docs/design-system.md` restates it. So "should we use TanStack Table" was decided
before this comparison; what is missing is adoption, not a decision.

**No charting library of any kind is installed** — no recharts, no visx, no d3, no
chart.js, and no hand-rolled SVG charts either. Anything chart-shaped is a
from-scratch choice. **shadcn/ui is also not installed**: no `components.json`, no
Radix. `components/ui/` is 7 hand-written primitives that deliberately follow
shadcn conventions so a later `shadcn init` merges cleanly.

---

## The constraints that actually decide this

These come from `docs/design-system.md`, which describes itself as literal spec
rather than suggestion. They are unusually decisive here, so they are listed
before the options.

1. **One token set, one component tree — never fork a component per theme.**
   Light is `:root`, dark is a `.dark` class. The counting route hardcodes `.dark`;
   the back office renders light. A future office dark toggle must be exactly
   "add or remove `.dark`" and nothing else.
2. **A hard accessibility floor.** 4.5:1 body, 3:1 non-text, a global
   `:focus-visible` outline, `aria-label` on icon-only controls. Ratios are
   computed, not eyeballed.
3. **Hairline borders, no shadows.** Depth is a background-colour step plus a
   12px gap. The only exception in the system is the 2px focus ring.
4. **Status colours are status-only.** Green, amber and red mean in stock, low and
   out. Never chrome, never decoration, never a categorical series.
5. **Role gating is structural.** A manager's table does not contain a cost
   column — not hidden, not filtered at render, absent. A committed browser check
   asserts a manager's DOM contains no `Unit cost for` string at all.

Constraint 1 is the one that ends the chart comparison, and constraint 5 is the
one that ends the table comparison. Neither is about features.

---

## Tables — TanStack Table v8

**Adopted.**

Headless: it computes sorting, filtering, pagination, grouping and column
visibility, and renders nothing. The markup stays ours, which means the existing
tokens, the 57px row, the hairline separator and the no-shadow policy carry over
untouched. A rendering table library would have to be fought on every one of
those.

Column definitions are a plain array built at call time, which makes constraint 5
the *natural* way to write it rather than a discipline to maintain:

```ts
const columns = [
  productColumn,
  categoryColumn,
  onHandColumn,
  ...(canSeeCost ? [unitCostColumn] : []),
  ...(canManage ? [caseSizeColumn] : []),
]
```

The alternative shape the docs warn about — one array with `columnVisibility`
hiding the cost column — is available in the API and must not be used. That is
worth stating in the spec, because it is the easier of the two and it is wrong:
`columnVisibility` keeps the column in the table model, and the wrongness is
invisible until someone reads the DOM.

**What it closes:** no table in the product has sorting, pagination, column
visibility or per-column filtering today. `/office/catalog` reads with a hard
`limit: 100` against 99 active products — two more and it silently understates.
Sort is currently a decorative `<span aria-hidden="true">⇅</span>` with
`cursor:pointer` and no handler bound.

**What it costs:** `catalog-table.tsx` is 696 lines of working, reviewed code with
selection state, an indeterminate select-all, a `visibleSelectedIds` intersection
guard and inline editing that patches from the value the server action returned.
Migrating it is real work with real regression risk, and it is the *only* table
that should be migrated first — the rest follow the pattern once it is proven.

**Bundle:** ~14 kB gz for the core plus the row models actually imported. Already
a dependency, so the marginal cost is zero.

---

## Charts

### visx — adopted for Phase 4

Airbnb's collection of low-level d3-in-React primitives. Its own README is blunt
about what it is: *"a collection of reusable low-level visualization components…
largely unopinionated and meant to be built upon"*, with per-feature packages —
*"pick and choose the packages you need."*

**Why it wins here, in order of weight:**

**It renders SVG, so it satisfies constraint 1 for free.** Marks are DOM elements.
`fill="var(--color-chart-1)"` and `stroke="currentColor"` resolve through the
normal cascade, so adding or removing `.dark` on an ancestor re-themes every chart
with no JavaScript and no re-render. There is one component tree and one token
set, which is exactly what §1 requires.

**It is low enough level to obey constraints 3 and 4.** No default shadows to
strip, no built-in categorical palette to override, no theme object competing with
the CSS variables. `@visx/theme` exists if we want it, but the tokens can drive
everything directly.

**Accessibility is addressable.** SVG is in the accessibility tree.
`@visx/xychart` sets `aria-label` on the root `<svg>` via `accessibilityLabel`,
and its `Tooltip` spreads arbitrary props (`role`, `aria-*`) onto the rendered
element. More importantly, because the output is DOM, a chart can be paired with a
visually-hidden `<table>` carrying the same numbers — the standard technique, and
one canvas cannot do at all.

**Bundle scales with use:** ~15 kB gz for a minimal setup, ~30–50 kB for a typical
chart once `@visx/shape`, `@visx/scale` and `@visx/axis` are in. Phase 4 needs
roughly four chart types, so this stays well under a monolith.

**The cost, stated honestly:** more code per chart than any alternative here.
Axes, legends, tooltips and responsive sizing are assembled rather than
configured. `@visx/xychart` takes the edge off for standard cartesian charts, and
`@visx/responsive`'s `ParentSize` handles sizing. For four charts against a strict
design system this trade is correct; for forty ad-hoc charts it would not be.

### Chart.js — rejected

Not on features. It is mature, well documented, and its canvas renderer handles
10k–100k points comfortably. Truestock does not have that problem: the largest
plausible dataset here is a year of weekly counts across six locations.

Two disqualifiers, both structural:

**Canvas cannot read CSS custom properties.** Every colour must be passed to
Chart.js as a JavaScript string. The entire design system is CSS variables split
across `:root` and `.dark`, so honouring it means reading tokens with
`getComputedStyle`, feeding them into the chart config, watching for theme
changes, and re-rendering. That is a second, JS-side copy of the theme — a
per-theme fork of the component in a different costume, which §1 bans. The
`--border`-is-decorative-but-`--input`-is-functional distinction, and the computed
contrast ratios that go with it, would have to be re-encoded by hand on the JS
side and kept in sync by discipline alone. This project's history says that does
not hold.

**Canvas is invisible to assistive technology.** Chart.js's own accessibility docs
offer two remedies: `role="img"` with an `aria-label`, or fallback content between
the canvas tags. Neither can express a data table — the best available outcome is
a one-sentence summary of a chart, against a §7 floor that is stricter than that.

Two lesser marks: it is imperative with a `new Chart()` / `.destroy()` lifecycle
that needs an effect and careful cleanup in React, and it does not server-render
in the browser sense (Node rendering needs `skia-canvas` and produces a PNG).

### TanStack Charts — rejected

Its documentation states plainly: the latest release is **`0.12.0`**, it is
**pre-alpha**, and **"its API may change between releases."**

That ends it. This is for a back office that has to survive Phase 4's reports and
Phase 5's variance report. What it is *building* is attractive — a headless
grammar of typed marks with SVG default rendering and optional canvas, framework
adapters for React, vanilla and React Native — and it is worth revisiting if it
reaches stable before Phase 4 starts. It should not be adopted on the strength of
sharing a name with the table library that *is* being adopted; they are unrelated
maturity decisions.

Note also that the user's original question grouped "TanStack" as one option. It
is two: TanStack **Table** is the strongest choice on the table half, and TanStack
**Charts** is the weakest on the chart half. Splitting them is most of the answer.

### Recharts / shadcn charts — the named fallback

shadcn/ui's chart block is Recharts v3, composed rather than wrapped, with design
tokens applied. If shadcn is adopted for the missing primitives (`table`, `input`,
`select`, `badge`, `tooltip`, `dialog`, `popover`), its charts come nearly free and
would be the fastest path to a dashboard.

Not chosen because: ~136 kB gz against visx's ~30–50 kB; it brings its own layout
and theming opinions that must be overridden to satisfy constraints 3 and 4; and
shadcn is not currently installed, so "it comes free with shadcn" is a
counterfactual rather than a fact.

Recorded here so the trade is explicit. If Phase 4 finds visx's assembly cost
worse than expected, this is the fallback — and switching is cheap, because
nothing outside the chart components will depend on either.

---

## The finding that matters more than the library choice

**Most of what this dashboard needs is not a chart.**

`docs/design-reference.md` calls the stock cell the best idea in the desktop
reference: `20 unit · Low` over a 2px bar whose width is on-hand ÷ par and whose
colour is status. That is a `<div>` with a percentage width. So is a par meter. A
sparkline is a single `<path>`. A stat tile is text.

Taking a charting dependency for those would be the wrong trade twice over: it
adds weight for something the platform does natively, and it puts the most
frequently-read number in the back office inside a library's rendering model
instead of the token system. **These stay dependency-free and get specified as
primitives in the web UI spec**, with visx reserved for Phase 4's genuine charts —
count value over time, the depletion heatmap, category distribution.

Two rules that go with them, both from the reference doc's divergences:

- **No par means no bar and no status word** (B1). `ProductPar.location_id` is
  nullable and the MVP writes NULL rows only, so many products have no par. Never
  infer a denominator — a meter with a guessed denominator is a plausible wrong
  number, which is the failure class this project cares most about.
- **Never label anything "Current"** (B2). On-hand is derived from the last
  *closed* count. `reorderList()` returns `asOfCountId`, null when nothing has
  closed. Every derived number carries an explicit "as of count #N" and a real
  empty state.

---

## Blocking prerequisite — the chart palette is currently the status palette

`app/globals.css` defines `--chart-1` through `--chart-5` in both themes, and
three of the five are byte-identical to the status tokens:

| Token | Light | Equals | Dark | Equals |
|---|---|---|---|---|
| `--chart-1` | `#2563eb` | `--accent` | `#60a5fa` | `--accent` |
| `--chart-2` | `#1f7a3d` | **`--success`** | `#6fcf8e` | **`--success`** |
| `--chart-3` | `#92600a` | **`--warning`** | `#f0b429` | **`--warning`** |
| `--chart-4` | `#b8305a` | **`--negative`** | `#f0718a` | **`--negative`** |
| `--chart-5` | `#6b6b6b` | `--muted-foreground` | `#a8a8a5` | `--muted-foreground` |

These are shadcn's default chart slots, carried in when the token file was
written, and nothing has used them yet — which is the only reason this has not
already caused a problem.

Constraint 4 forbids it. A category breakdown drawn in these tokens puts a green
wedge and a red wedge on a bar-inventory dashboard where green already means *in
stock* and red already means *86'd*. A reader who interprets it that way has been
taught to by the rest of the product.

The same defect already appears independently in the prototypes: vendor and person
identity dots use `#2563eb`/`#92600a`/`#1f7a3d`/`#b8305a` as raw hex — the four
reserved status colours spent on identity, in a file that annotates the rule it is
breaking. See `ui-audit.md` P0.1 and P2.5.

**No chart may be drawn until the series palette is re-derived.** The requirement:
five or more hues that are mutually distinguishable, distinguishable in both
themes, distinguishable under the common colour-vision deficiencies, and that do
not reuse the green/amber/red status hues or read as adjacent to them. Contrast
computed against `--background` and `--card` in both themes, in the same style as
the existing token table, rather than eyeballed. `--chart-1` may keep the brand
blue; `--chart-2` through `--chart-5` need replacing.

Series colour should also never be the *only* channel — direct labels or pattern
differentiation carry the meaning, with colour as reinforcement.

---

## Summary

| | TanStack Table | visx | Chart.js | TanStack Charts | Recharts |
|---|---|---|---|---|---|
| Renders | nothing (headless) | SVG | Canvas | SVG/Canvas | SVG |
| CSS-variable theming | n/a — our markup | native | **requires JS re-plumbing** | native | via wrapper |
| Satisfies "no per-theme fork" | ✔ | ✔ | **✘** | ✔ | ✔ |
| Accessible output | ✔ our markup | ✔ DOM + hidden table | **✘ `aria-label` only** | ✔ | ✔ |
| Per-role column absence | **native idiom** | n/a | n/a | n/a | n/a |
| Bundle (gz) | ~14 kB (installed) | ~15–50 kB modular | ~67–92 kB | n/a | ~136 kB |
| Maturity | stable v8 | stable v3 | stable v4 | **pre-alpha 0.12.0** | stable v3 |
| **Verdict** | **Adopt** | **Adopt (Phase 4)** | Reject | Reject | Fallback |

**Phase 2 installs nothing.** It adopts TanStack Table for the tables that already
exist, defines the meter/sparkline/stat-tile primitives with no dependency, fixes
the chart palette, and writes the chart contract down. Phase 4 installs visx
against a catalog that by then has costs, pars and vendors in it — because today
it has 9 of 99 products costed, 0 par rows and 0 vendors, and a chart built now
would render empty and prove nothing.
