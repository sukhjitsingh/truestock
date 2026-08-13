# Gate 1 — Product: finish the MVP, then make it survive daily use

No databases, schemas, endpoints or file names in this document. That is Gate 2.

---

## Problem

**In the owner's words, four complaints:**

> "I added a tap line and it took a developer and a SQL query. I can't add a
> walk-in, I can't rename Speed Rail, and I can't tell the app that the
> storeroom is counted by the case instead of by tenths."

> "Putting in my costs means opening ninety separate pages. I got to about
> thirty last time and gave up. Until that's done the app tells me my inventory
> is worth nothing, which I know is wrong."

> "The dashboard says how many products I have. I have a hundred and one. It
> says a hundred."

> "I can see the reorder list on my phone. I can't send it to anybody. I end up
> retyping it into a text message to my rep, which is where the mistakes come
> from."

And one nobody complains about because it hasn't bitten yet: a helper script
prompts for a password the moment anything imports it, and starting the dev
containers the ordinary way silently kicks the phone off the network it was
counting on.

**What ties them together:** everything in the counting loop works and has been
proven on a real phone. What's missing is the *ability to set the thing up and
get the numbers out* — the parts a manager touches once a week instead of once
a minute. Those parts are currently developer-only, and a product that needs a
developer to add a walk-in cannot be sold.

---

## Success metric

**One number, measured the same way twice:**

> **The owner enters unit costs for all 90 uncosted products in one sitting,
> without help, and the dashboard's inventory value is non-zero and correct to
> the cent against a hand-checked SQL total.**

Measured by: timing the sitting (target **under 45 minutes**, versus 90 page
loads today — this is roughly 30 seconds per product including finding it on
the invoice), then reconciling the closed count's valuation against a manual
`SUM` the way count 2 was reconciled at $170.90 on 2026-08-12.

**Three supporting checks, each pass/fail:**

- A location can be added, renamed, have its counting mode changed, and be
  retired **from the app**, with no SQL and no CSV edit.
- The dashboard's product count reads **99 active** with 101 rows in the
  catalog, and stays right when the catalog passes 200.
- A per-vendor order goes from the reorder screen into a text message **without
  retyping** — one tap to copy, or one tap to print.

**Explicitly not measured here:** how long a full count takes on a phone. That
is Phase 1.9's number, deferred by owner decision on 2026-08-12. Keeping it in
this bundle would make it uncloseable.

---

## Announcement

**Truestock now sets itself up.**

You can add and rename locations from the app — a new tap line, a second
walk-in, or the storeroom you decided to count by the case instead of by
tenths. Retired locations stay on old counts, because a closed count never
changes.

Costing your catalog no longer means ninety page loads. Type costs and case
sizes straight into the catalog list, one row after another, and each one saves
as you go. That's the difference between one evening with your invoices and
giving up at product thirty.

The reorder list is now something you can send. Copy a vendor's order to your
clipboard or print it, without retyping it into a text message.

And the dashboard tells the truth. Its numbers are now counted in the database
instead of estimated from the first hundred rows — so they stay right as your
catalog grows.

---

## Screens

Three screens change, one is new. Mockups are plain HTML, no framework, and are
throwaway by design.

| File | Screen |
|---|---|
| `mockups/locations.html` | **New** — the locations list: name, counting mode, sort order, an inline add/edit row, and a retire action with its confirmation. Shows the retired state and the two refusals (last active location; a location an open count is using). |
| `mockups/catalog-inline-cost.html` | **Changed** — the catalog table with cost and case-size cells editable in place: focus, dirty, saving, saved, and per-cell error. Shows a NULL case size on a spirit reading as "n/a" rather than an empty box begging to be filled. |
| `mockups/reorder-output.html` | **Changed** — the reorder screen with per-vendor **Copy** and **Print**, the copied-confirmation state, and the plain-text block that lands in the clipboard. |
| — | **Dashboard** — no visual change. Same tiles, correct numbers. |

Two screen rules carry over from `AGENTS.md` and are not negotiable in the
mockups:

- **Dim-bar UI** applies to the counting route. These are back-office screens,
  which render light — but they get used on a phone anyway, so tap targets and
  overflow behaviour still matter. The catalog table's bulk bar already had to
  be made sticky because it rendered off-screen below 98 rows.
- **A plausible-but-wrong default is more dangerous than an obviously broken
  one.** No prefilled cost. No prefilled case size. An empty cost cell is
  honest; a `0.00` cell is a lie that values inventory at nothing and looks
  entered.

## Not in this bundle

Stated so it isn't discovered later:

- **Emailing or texting the reorder list.** Spec §14 prefers email/SMS over web
  push, but delivery is a separate decision with its own provider, secret and
  failure mode. This bundle ships the copyable/printable half.
- **CSV import for costs.** Preferred against, per ROADMAP 1.2 — a new parser
  is a new silent failure mode, and case size is only 16 rows.
- **The cron that runs the session sweep.** Hostinger only exists at Phase 3.
- **The owner's actual data entry** — 90 costs, 16 case sizes, par levels,
  vendors, 5 wine producers. This bundle makes it possible in one sitting; it
  cannot do it.
