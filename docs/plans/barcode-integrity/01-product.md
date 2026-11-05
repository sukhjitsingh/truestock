# Gate 1 — Product: one barcode, one bottle size

No databases, schemas, endpoints or file names in this document. That is Gate 2.

---

## Problem

**In the owner's words (2026-11-05):**

> "If I scan a bottle, the app does not check the size. I can assign multiple
> bottle sizes to the same barcode."

That turned out to be two problems, and a third that makes them harder to notice.

**1. The app does not recognise a barcode it already knows when the camera reads
it differently.** A barcode on a bottle can be written down in more than one
standard way — the long form, a version of the long form with an extra leading
zero, or the short six-digit form printed on small bottles. They are the same
barcode. The app remembers whichever way the camera read it the first time, and
treats a different reading of the same code as a brand-new bottle. So it asks
"which bottle is this?" again, and lets it be attached to a *different* product.
This was reproduced on 2026-11-05: one Smirnoff barcode ended up attached to the
1.75 L *and* the 200 ml.

**2. Linking a barcode never shows the size before it commits.** When the app
asks "which bottle is this?", the counter searches, sees "Smirnoff", and taps
it. That one tap links the barcode. Nothing asks whether the bottle in hand is
the size on the screen. The catalog today has exactly one Smirnoff — the
750 ml — so a counter holding a 200 ml bottle sees one result, taps it, and from
then on every 200 ml scan is counted *and valued* as a 750. Nothing looks wrong.

**3. When the app does refuse, it doesn't say which size it means.** "This
barcode is already assigned to Smirnoff" does not help when there are three
Smirnoffs.

**Why it matters more than it looks.** This is the same failure shape the whole
app is built to prevent: a number that looks plausible and is wrong. A barcode
on the wrong size miscounts that product on every count from then on, and the
first walk of the bar is when nearly every barcode gets learned — 95 of 99
products have none yet. Mistakes made in that walk are permanent until someone
notices.

---

## Success metric

**One number:**

> **Zero barcodes attached to more than one product**, counting the different
> written forms of the same barcode as one — checked after the first full
> enrolment walk of the bar (Phase 2.9, Run A).

Measured by: a query, run once after the walk, that groups every stored barcode
by its standard form and reports any group holding more than one product. Today
that query would report the Smirnoff case above; after this ships it must
report none, ever, because the app will refuse to create one.

**Three supporting checks, each pass/fail:**

- **The size is on screen before every link.** A counter cannot link a barcode
  without seeing the product's size in large type and confirming it.
- **A different size is quick to add.** From that confirmation, "It's a
  different size" opens the new-product form with the name and category already
  filled in, so adding the 200 ml Smirnoff means picking a size and nothing
  else.
- **The 20-second enrolment budget still holds.** The confirmation adds one
  tap for spirits, wine and non-alcoholic products (beer already has a
  question at this point, so beer gets no extra tap). Timed during Run A.

---

## Announcement

> **Truestock now knows a bottle's barcode however the camera reads it.** The
> long form, the short form on small bottles, or the version with an extra
> leading zero — they all land on the same product, so a bottle you have
> already scanned is never mistaken for a new one. And when the app learns a new
> barcode, it shows you the size in big type and asks you to confirm it before
> anything is saved. Holding a 200 ml when the catalog only has the 750? Tap
> "It's a different size" and the new size is one pick away. If a barcode is
> already taken, the app now tells you exactly which product and size has it.

---

## Screens

All on the phone, in the counting app (dark theme).

| Mockup | What it shows |
|---|---|
| `mockups/link-confirm.html` | The new confirmation step after picking a search result: the product name, the **size as the biggest text on screen**, "Link and count", and "It's a different size". Two states side by side: a spirit (no other question) and a bottled beer (the existing bottle-or-case question folded into the same screen, so beer has no extra step). |
| `mockups/different-size.html` | The new-product form opened from "It's a different size": name and category already filled in from the product the counter almost picked, size waiting to be chosen. |
| `mockups/already-assigned.html` | The refusal message, before and after: it now names the product **and its size**, and offers a way back to the search. |

Fix 1 (recognising the same barcode in any form) has **no screen of its own**.
Its visible effect is the absence of a screen: a bottle you have already
enrolled goes straight to counting instead of asking "which bottle is this?"
again.

---

## Deliberately not in this feature

- **Locking a product's size once it has barcodes or has been counted** (the
  discussion's Fix 3). Deferred by the owner on 2026-11-05. The risk it covers
  stays real: changing a size in the back office changes what every barcode on
  that product means, and changes how *past* counts display that product. It
  will be recorded as an open item when this feature closes.
- **Back-office barcode management** (viewing, moving or removing a product's
  barcodes from a desk). Not requested. The conversion of existing barcodes
  below is a one-time step, not a screen.

---

## Decisions for the owner

Carried over from the 2026-11-05 discussion, still unanswered. Each has a
recommendation; approving this gate as written accepts the recommendations.

1. **A short, 8-digit barcode the app cannot identify.** Two different kinds of
   barcode share the 8-digit length, and the digits alone cannot say which one
   it is; only the camera knows. When the camera *does* say, the app uses that.
   When it does not, **recommended: remember it exactly as read and never
   guess.** A guess that is wrong merges two different products' barcodes,
   which is worse than the rare re-ask it avoids.

2. **When to ask for the size.** **Recommended: every time**, for the reason
   in Problem #2 — "only when the search shows several sizes" would not have
   caught the Smirnoff case, because the catalog had only one size. Cost: one
   tap per new spirit, wine or non-alcoholic barcode.

3. **The standard form a barcode is remembered in.** You ruled out padding
   every code to 14 digits. **Recommended: the shortest standard form that
   still means the same thing** — a 13-digit code that starts with a zero is
   remembered as the 12-digit code it really is, and the short 6-digit form on
   small bottles is expanded to its full 12 digits so both readings match.
   Codes that are not numbers (some cartons and shipping labels) are left
   exactly as read. The exact rules are worked out at Gate 2.

4. **Barcodes already in your local database.** Some of them, like the
   Smirnoff pair, will turn out to be the same barcode on two products once
   they are compared in standard form. The app cannot decide which product is
   right. **Recommended: the one-time conversion lists every such conflict and
   stops, and you pick the winner** (or reset the local database instead).
   Production has no barcodes yet, so this only affects local data.
