---
name: project-design-foundation
description: "Handlebar design system foundation (palette, theming mechanism, brand-vs-status rule, role-gated value contract) — read before touching app/globals.css, docs/design-system.md, or prototypes/design-system.html"
metadata:
  type: project
---

The design foundation was built in `app/globals.css` (Tailwind v4 `@theme` tokens),
`docs/design-system.md` (binding rules), and `prototypes/design-system.html` (offline,
openable-in-Chrome proof with a light/dark toggle). Frontend and back-office screen work
should follow that doc literally rather than inventing tokens — it was written so later
agents have "zero room to invent."

**Key decisions a future session needs to know, not just re-derive:**

- **Brand is blue, not green.** `--accent`: `#2563EB` (light, Tailwind blue-600) /
  `#60A5FA` (dark, blue-400). Green/amber/red (`--success`/`--warning`/`--negative`) are
  reserved *exclusively* for stock/count status — never decoration or brand chrome. This
  was the resolution to divergence #6 in `docs/design-reference.md` (the Dribbble
  reference used green as brand, which collides with inventory status semantics).
- **Theming uses the standard shadcn convention inverted at the product-experience
  level**: `:root` = light values (shadcn tooling assumes this), `.dark` class = dark
  overrides. But the *counting route* hardcodes `className="dark"` on its root layout
  element — never conditional on OS/`prefers-color-scheme` — so dark is the true product
  default there. The back-office route renders with no `.dark` class and gets light.
  Whoever builds the counting screen's root layout must remember to hardcode this class;
  it will not happen automatically.
- **The dark-theme detail header does NOT invert to white** the way the light theme
  inverts to black (mirroring the reference exactly). A full-brightness block at the top
  of a phone screen in a dark bar was judged a glare/"flashbulb" risk per CLAUDE.md's
  dim-bar rule. Dark header uses a deep, barely-lighter-than-background surface
  (`#121317`) plus a brand-blue accent for identity, not raw brightness.
- **Several reference hex values failed WCAG AA as measured and were corrected**: the
  reference's secondary-text grey (`#8A8A8A`, 3.45:1 on white) and all three status pill
  text colors (2.1–3.8:1 on their own tint) were darkened to clear 4.5:1. Also the
  reference's hairline card border (`#EAEAEA`, ~1.2:1) fails the 3:1 non-text-contrast
  rule for anything that's the *sole* indicator of a control's boundary — resolved by
  splitting into a decorative `--border` (kept pale, used only for card/list dividers
  where the background-color step is the real boundary cue) and a functional `--input`
  (darkened to `#8C8C8C`/`#6B6B6B`, 3.3–3.4:1, used on form fields and outline buttons).
- **Role-gated value contract** (CLAUDE.md invariant 8 / cost hidden from staff): a money
  component returns `null` — not `$0.00`, not an em-dash — when its prop is `undefined`,
  and the *row layout itself* branches on presence (`grid-cols-[1fr_auto]` vs
  `grid-cols-1`) rather than reserving a blank column. Never use `opacity-0`/`hidden` to
  fake-hide a populated value — if a `staff` request has the value in the DOM at all,
  that's a server bug, not a styling one. This same present/absent branch applies to the
  bottom action bar's primary button (two lines with total vs one line without).
- Elevation policy: hairline borders only, **no `shadow-*` anywhere** (cards, sheets,
  modals) — the one exception is the focus-visible ring, which is accessibility
  machinery, not decoration.
- Tap targets: `tap-min` (44px) floor everywhere, `tap-primary` (56px) floor on the
  counting screen's primary loop — both are named Tailwind spacing tokens
  (`min-h-tap-min`, `min-h-tap-primary`), not a convention agents have to remember by hand.

See `docs/design-system.md` for the full component specs (card row, detail header,
bottom action bar, search+scan field, status pill, stepper, status timeline, tab bar,
form field) with literal Tailwind class strings for each.
