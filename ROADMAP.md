# Truestock — roadmap

Where this goes after the MVP. `STATE.md` is where it is now.

**Re-sequenced 2026-08-12 by owner decision.** The previous order put the first
production deploy immediately after the MVP and pushed invoice capture to a
conditional Phase 4. Both moved: **field validation is deferred to Phase 1.9**,
the **UI redesign and OCR invoice automation now come before go-live**, and
**Toast PMIX moves to Phase 5**. What follows reflects that order, not the old
one.

Phases are ordered by decision, not by dependency alone. Where the new order
creates a consequence worth knowing about, it is stated under the phase rather
than left to be discovered.

| Phase | What |
|---|---|
| **1** | MVP completion — locations screen, bulk cost entry |
| **1.5** | Survive daily use — #14, #1b, #23, #24, reorder output |
| **1.9** | Field validation — the deferred measurements |
| **2** | UI redesign — mobile layout and design flow |
| **2.5** | OCR invoice automation |
| **3** | **Go-live — deploy to production** |
| **4** | Reports, heatmap, back-office enhancements |
| **5** | Toast PMIX import + variance |
| **6** | Compliance packet *(unscheduled — see note)* |
| **7** | AI fill estimation *(conditional, lowest priority)* |

---

## Phase 1 — MVP completion

Catalog, locations, barcode scan, fill level in tenths, quantity input, count
sessions with the Draft → Closed lifecycle, valuation, reorder list, three roles,
multi-tenancy — **all built**, and as of 2026-08-12 every part of the counting
loop has run on a real phone: camera scan and enrol, tenths, sealed quantities,
valuation (count 2 closed at $170.90, reconciled to the cent in SQL), and the
offline write queue draining on reconnect, the last under the production CSP.

**Two things are left to build.** Everything else in Phase 1 is data entry.

### 1.1 Locations management screen — `/office/locations`

**The one genuine MVP gap.** `lib/domain/catalog.ts:803` has `listLocations`
and nothing else — no `createLocation`, no `updateLocation`, no route, no
component. Locations are seed-only.

This already cost real time: adding `Tap 1` so draft kegs could be counted at
all required editing `docs/catalog/locations.csv` **and running SQL against the
live database**. At a customer's bar that is a hard stop — no tap lines, no
renaming a location, no second walk-in. Worse, `location.count_mode` is
unreachable from the app, and that column alone decides whether a product gets
the fill pad or a quantity stepper (the entry screen is chosen *entirely* by
location; `unit_type` does not enter into it).

Build: `createLocation` / `updateLocation` in the domain layer with zod schemas,
owner-gated server actions, the screen, and a nav link. **Deactivate, never
delete** — invariant 6's rule applies to locations for the same reason it
applies to products and users: closed counts reference them.

### 1.2 Bulk cost and case-size entry

The **fields already exist** — `components/office/product-edit-form.tsx` carries
cost, case size, par level and reorder point, correctly role-gated (`canEditCost`
for cost; par is visible to managers, because par is a quantity and reordering is
a manager's job per spec §4).

What does not exist is throughput. Entering 90 unit costs today means 90 separate
page loads at `/office/catalog/[productId]`. The catalog table's only bulk action
is vendor assignment. This is the difference between one evening with the
invoices and abandoning it at product 30 — and open-item #4 is the shortest path
to the app being *useful* rather than merely correct.

Build: inline-editable cost and case-size columns in `catalog-table.tsx`, reusing
the selection and bulk-bar machinery already there. Preferred over a CSV import —
no new parser, no new silent failure mode, and case size is only 16 rows (bottled
beer only; a NULL case size on the 62 spirits is correct, not missing).

### 1.3 Data entry — not construction

90 unit costs · 16 case sizes · par levels (0 set, so the reorder list still
cannot produce a row) · vendors (0, and `docs/catalog/vendors.csv` ships
header-only on purpose) · 5 wine producers.

**Done when:** locations are manageable from the app, the catalog is costed, and
a count produces a valuation and a reorder list worth acting on.

> **Exit criterion changed.** This phase used to close on *"a full count runs on
> a phone in under 20 minutes."* That measurement moved to Phase 1.9, so keeping
> it here would make Phase 1 uncloseable. The sub-20-minute target is not
> abandoned — it is deferred, and it is Phase 1.9's exit criterion instead.

---

## Phase 1.5 — Make it survive daily use

Small, unglamorous, and it is what decides whether the MVP is still in use in
three months. Driven by open-items, each with its own trigger.

- **Dashboard aggregate reads (#14)** — **the trigger has effectively fired.**
  `app/(office)/office/page.tsx:46` derives the product tile from a read capped
  at `limit: 100`; the catalog now holds **101 products, 99 active**. Two more
  active products and the tile silently understates against a database that is
  fine. The last-closed-count tile has the same shape at `limit: 50`. The fix is
  a dedicated aggregate read in `lib/domain/`, **not a bigger limit** — reusing
  the list actions was right for a first cut, but a cap that grows is a cap that
  fails again later, quietly.
- **Session sweep (#1b)** — `DELETE FROM session WHERE expires_at < NOW() LIMIT
  1000`, batched. The index it needs (`session_expires_at_idx`) already exists.
  **Sequencing note:** the query and the script can be built here, but the *cron*
  can only be created against Hostinger, which is now Phase 3. Build it here,
  schedule it there.
- **`scripts/create-user.ts` unguarded `main()` (#23)** — still open at line 215.
  `db/seed.ts` was fixed with the `import.meta.url === pathToFileURL(argv[1]).href`
  guard; copy it. Cheapest item on this list and its side effect is worse than the
  seed's was — an interactive password prompt fired by any future import.
- **Sticky LAN dev state (#24)** — detection shipped, prevention did not. A plain
  `docker:up` still silently reverts a live LAN session: the container comes back
  healthy, `curl` still returns 200, and the phone loses its allowlisted origin
  with no warning. Either persist `DEV_LAN_ORIGIN` somewhere `docker:up` reads and
  preserves, or make `docker:up` refuse when a LAN session is live.
- **Reorder output — new item.** `/office/reorder` renders and groups by vendor,
  and there is **no export, print, copy or email**. Seeing the list is not the
  job; sending it to the vendor is. Spec §14 explicitly recommends email or SMS
  over web push, which it calls unreliable enough not to build on. Start with the
  boring half — a copyable/printable per-vendor order — and treat delivery as a
  separate decision.

**Already done in this phase:**

- ~~**User management** (#3)~~ — **DONE 2026-08-03, browser-verified 2026-08-04.**
  `listUsers`, `setUserActive`, `setUserRole` and `/office/users`. Deactivation
  deletes the user's `session` rows in the same transaction (invariant 11).
  Self-deactivation, self-demotion and last-active-owner lockout are all refused,
  and the control snaps back to the real value when the server says no.
- ~~**Vendor write path** (#19)~~ — **DONE 2026-07-31, browser-verified.**
  `createVendor`, `updateVendor`, `assignVendorToProducts`, the `/office/vendors`
  screen and bulk catalog assignment. The reorder list can group by vendor per
  spec §9.3 instead of dumping every row under "No vendor set".
- ~~**Rapid-scan mode** (#10)~~ — **DONE 2026-08-04.** Wired rather than deleted,
  at the owner's request. Quantity locations only — a blind +1 on a tenths leg
  would record a full bottle for a part-full one. Frame guard in
  `lib/rescan-guard.ts`, tested without a camera; writing those tests found two
  silent miscounts before anyone scanned anything. *Camera validation moved to
  Phase 1.9.*
- ~~**Offline write queue** (#9)~~ — **DONE 2026-08-12.** Verified on a phone:
  `1 pending` while offline, `Synced` on reconnect with no interaction, exactly
  one ledger row afterwards. Required building `scripts/prod-lan.sh` first —
  `next dev`'s HMR client reloads the page when the network drops, which makes
  the test impossible in dev. Fixed seven unguarded server-action calls found
  along the way, two of them writes.

**Deliberately not built here:** the fill-correction ledger (#2). Its trigger is
the compliance packet, and choosing the ledger convention early changes what the
audit export means. Leave it.

---

## Phase 1.9 — Field validation · *deferred measurements*

**Everything here is measurement, not construction.** None of it is blocked on
code; all of it was deferred on 2026-08-12 by owner decision. It is written down
as a phase rather than dropped because these are the only claims in the project
with no evidence behind them, and the project's own history is that unmeasured
claims fail silently.

Run against the LAN stack — this phase does not need production.
`docs/phone-count-test.md` is the protocol; record results there rather than in a
session log, because a run that is not written down is an anecdote.

- **The enrollment pass (Run A).** 95 of 99 active products have no barcode, so a
  first walk is essentially all enrolment. Measures the **20-second** enroll
  budget from `AGENTS.md`, not the 20-minute one. Also finally answers open
  question #3, the open-vs-sealed split, which every counting-speed estimate
  depends on.
- **The timed count (Run B).** The **sub-20-minute** target the whole design is
  justified by, and still the one claim with no measurement behind it. Only
  meaningful once barcodes resolve, so it follows Run A over the same bottles.
  Watch the per-line gaps: count 2 saw 29s and 102s between two kegs *on the same
  screen with no leg switch*.
- **The five-location walk.** No pass has covered all five. The locked-location
  design and its "count something elsewhere" escape hatch are both untested, and a
  wrong active location fails *silently* — the total stays right and only the
  distribution is wrong.
- **Rapid-scan against a real camera.** The last untested part of scanning and the
  one whose failures are silent by construction. Its frame guard is tested only
  against *modelled* frame sequences. **Count a real shelf in rapid mode, then
  count it by hand, and compare.** Offered only on quantity locations, and
  *hidden* rather than greyed out elsewhere.
- **The two remaining queue gaps (#9).** The **mount-time flush** has never run —
  only the `online` listener was observed — and the queue has never held **more
  than one write at a time**, so ordered replay is still only reasoned about.
- **The standalone server entrypoint.** The 2026-08-12 CSP verification ran under
  `next start`, which printed `"next start" does not work with "output:
  standalone" configuration`. Hostinger runs `node .next/standalone/server.js`,
  which has never been started. Cheap to close locally and it is a Phase 3
  blocker, so closing it here removes a deploy-day unknown.
- **The barcode-resolution branch.** Both real scans so far were *enrolments of
  unknown codes*. Resolving a barcode to a product the catalog already has is a
  different branch of `onBarcode` and has never run on a device.

**Done when:** a full count runs on a phone in under 20 minutes, the numbers are
trusted enough to act on, and rapid mode's count matches a hand count.

---

## Phase 2 — UI redesign · mobile layout and design flow

The counting app's entire reason to exist is being faster than a clipboard in a
dim bar, one-handed, with the other hand holding a bottle. The screens work; how
well they work at pace is the open question, and Phase 1.9's numbers are the
input to this phase rather than an afterthought.

**Start from what exists, which is more than it looks:** `docs/design-system.md`
holds binding rules (two themes, one token set; the counting route hardcodes
`.dark`, the back office renders light; WCAG ratios computed rather than
eyeballed), `docs/design-reference.md` distils the two Dribbble references the
owner supplied along with where we deliberately diverge, and
`prototypes/design-system.html` is live proof of every rule with no build step.
A redesign extends these files; it does not bypass them.

Known material for this phase:

- **The 2026-08-01 mobile pass is built and mostly unproven.** Larger tap targets
  (fill shortcuts to 80 px, tenths to 56 px, steppers 44→56 px), safe-area insets
  for the notch and home indicator, `touch-manipulation` to kill the 300 ms tap
  delay, a horizontally scrollable office nav. The fill pad has now been driven on
  a device; **the quantity stepper, the scanner chrome and the safe-area insets
  have not.**
- **Design flow, not just layout.** The leg model (pick a location, count it,
  *Finish section*, move on) is a flow decision that has never been walked
  end to end across five locations. Phase 1.9 produces the first evidence about
  it.
- **The back office is desktop-first and gets used on a phone anyway.** The office
  nav already needed an overflow fix; the catalog table's bulk bar rendered
  off-screen below 98 rows and had to be made sticky. Both are symptoms.
- **The enroll form is held to a 20-second budget** and is the highest-risk
  interaction in the product. If Phase 1.9 says it is over budget, this is the
  phase that fixes it — and per `AGENTS.md`, by shortening the path or lengthening
  a preset list, not by adding free-text fields that accept a plausible wrong
  answer.

**Two rules carry over and are not negotiable here.** Verify in a browser, never
with `curl` — every client-side failure this project has hit was invisible to
status codes. And a plausible-but-wrong default is more dangerous than an
obviously broken one; the keg default that looked like a real keg and was wrong
for 7 of 9 is the cautionary tale.

---

## Phase 2.5 — OCR invoice automation

**Moved up from a conditional Phase 4.** Costs come from supplier invoices, and
Phase 1's bulk-entry screen is the manual version of this. Build it in the order
researched in `docs/invoice-automation-research.md`.

> **Settle the xtraCHEF question first (spec §13).** That subscription is already
> paid for and already does invoice line-item capture and archival. **One hour of
> testing decides how much of this phase needs building.** Photograph a month of
> liquor invoices into it and judge the extraction. The research doc leans build
> rather than buy — a bought pipeline solves it for one bar and leaves every
> future tenant with a product gap, and it puts the data feeding valuation,
> variance and the Arizona audit packet inside a vendor you do not control — but
> that is an argument, not a measurement.

**Phase A — no AI (~1.5 weeks). Ship this whichever way the test goes.** Upload,
object storage, `retention_until`, manual line entry. It satisfies Arizona
A.A.C. R19-1-501's two-year retention on its own and unblocks open-item #4.

**Phase B — extraction.** OCR behind a thin `extractInvoice()` interface so the
provider is a one-file change. Research recommends Claude Sonnet 5 with AWS
Textract AnalyzeExpense as the documented fallback. **Run a 20–50 invoice eval
before trusting any published benchmark** — they contradict each other on line
items, and "99%+ accuracy" is marketing, not measurement.

Three things the market knows that the original spec missed:

1. **Human review *is* the product.** Every competitor staffs it and sells it as a
   feature. OCR is the cheap half.
2. **Deposits, freight and tax are invoice lines that are not product cost.** A
   keg's $30–50 deposit folded into unit cost makes every keg ~15% high and
   poisons the variance report before it is ever built.
3. **Distributor portals may mean no OCR at all** for some vendors.

**This phase reverses two deliberate MVP exclusions** — it needs AI and file
storage. That is fine here and nowhere earlier, and `AGENTS.md`'s "the MVP
contains no AI and no file storage" rule stops applying at this line, not before
it.

> **Consequence of the new order, stated so it is not discovered later.** This
> phase now lands *before* production exists. Invoices captured during it live in
> local object storage against a local database, so either that data migrates at
> Phase 3 or the first month of invoices is treated as a throwaway pilot. Decide
> which on the way in, not on deploy day.
>
> **Build `retention_until` here, not in Phase 6.** The Arizona retention rule is
> a legal requirement attached to the invoice record itself, and retrofitting a
> never-auto-delete guarantee onto files already stored is strictly harder than
> setting it at write time.

---

## Phase 3 — Go-live · deploy to production

**`docs/go-live.md` is the gate and it is already written.** `docs/deploy.md` is
the runbook — how a deploy happens. go-live is the decision of whether it should.

Blocking items, none of which are construction:

- A production database exists and the chain `0000 → 0001 → 0002` has applied to
  it. It has only ever run against Docker.
- An owner account created via `scripts/create-user.ts` with the **hidden
  prompt**, never `--password`. There is no signup path, deliberately.
- Secrets set in GitHub Actions, `DATABASE_URL` pointing at production.
- `BETTER_AUTH_SECRET` is a fresh production value, not the dev one.
- **A rollback rehearsed**, not merely documented.
- The dev owner password is not reused — `LocalDevOwner123` sat in a plaintext
  container log and must be treated as public.
- The **standalone entrypoint** starts, if Phase 1.9 has not already closed it.

Then run **go-live Part 2 against production, in order, on the first day** — the
browser checks first. Two rules govern it: **a 200 is not evidence**, and
**verify against production, not a copy of it**. Re-running the local suite
against production tells you nothing new.

The session-sweep cron (#1b) gets scheduled here, using the query built in
Phase 1.5.

> **What moving this to Phase 3 costs, stated plainly.** The bar does not use the
> product until this phase lands, so Phases 1.9 and 2 produce measurements from a
> LAN dev stack rather than from daily production use, and Phase 2.5 captures
> invoices with nowhere durable to put them yet. That is a legitimate trade — the
> app is better when it arrives — but "we will learn it in production" is not
> available as an answer until here.

---

## Phase 4 — Reports, heatmap, back-office enhancements

Everything the back office should do once real data exists and the app is live.
Deliberately after go-live: reports built against 8 count lines are guesses,
and this project's worst failure mode is a number that looks plausible.

Candidate scope, to be narrowed when there is data to look at:

- **Count history and trend** — value over time, per location, per category.
- **A depletion heatmap** — which products move, where, and when. This is the
  read that tells the owner what to stop stocking.
- **Reorder intelligence** — suggested quantities that account for observed
  depletion rather than only par minus on-hand.
- **Unpriced/incomplete surfacing** — `incompleteReasons` already computes this
  per product on every read and drives the catalog's "needs attention" view;
  the dashboard could carry it.
- **Export** — the generic half of Phase 1.5's reorder output, applied to counts
  and valuations.

**Prerequisite from Phase 1.5:** #14's dedicated aggregate reads. Every report
here is an aggregate, and building them on top of capped list reads would repeat
the exact mistake #14 exists to fix.

---

## Phase 5 — Toast PMIX import + variance

**This is the feature that justifies the whole project.** Theoretical usage from
the POS against actual usage from counts.

CSV upload, map Toast Item GUID → product + pour spec, produce the
actual-vs-theoretical report.

**The recipe map is the work, not the import.** Draft is nearly free — a 16 oz
Coors Light is one Toast item, one product, one pour size. Cocktails are where the
tedium lives.

Draft depletion must be grossed up by the waste factor (invariant 10): a 16 oz
pour draws `16 / (1 - waste_factor)` from the keg. Skip it and every keg looks
~10% short, turning the report into false positives. The `waste_factor` column
already exists and draft products carry `0.100`.

The owner's own pour model — 16 oz and 22 oz servings, per-keg waste, margin per
pour — is on the catalog workbook's **Draft Economics** tab. It is the manual
prototype of this report. Read it before building.

**Do not start until several months of trustworthy counts exist.** A variance
report built on counts nobody believes is worse than no report, because it will
be believed. Under the new order this is naturally satisfied: production lands at
Phase 3, so by Phase 5 there is history.

---

## Phase 6 — Compliance packet · *the differentiator, unscheduled*

**Not in the owner's 2026-08-12 sequence and kept deliberately** — it was
previously Phase 3, and it is the thing no off-the-shelf product produces, which
is a large part of why building rather than buying was the right call. Slot it
when the retention obligation becomes real, which is the moment invoices start
being stored (Phase 2.5) rather than the moment this phase is scheduled.

Arizona A.A.C. R19-1-501: two years of invoices, monthly beginning/ending
inventory, produced on request.

- Month-End Close report, food and liquor separated, locked once closed
- `retention_until` on every invoice image, never auto-deleted before it —
  **build this in Phase 2.5**, per that phase's note
- One-button audit packet export: date range → PDF/ZIP
- Immutable who-counted-what-and-when

Closes open-item #2 as a prerequisite: fill corrections currently write no ledger
row, which is exactly the audit-trail gap this phase cannot ship with. Decide the
ledger convention for replaces deliberately — a full-array replace has no delta
representation in `count_line_write`'s current shape, and the convention chosen
changes what the export means.

---

## Phase 7 — AI fill estimation · *conditional, lowest priority*

Deferred on evidence, not caution: vision models cannot reliably count, fill level
from a casual photo is genuinely hard in bar lighting, and every commercial
competitor already concedes this by making the human tap the level.

**Revisit with real data in hand.** After a month of tapped tenths you will know
which bottles are slow and ambiguous, which tells you whether AI would help and
where. Run the 20-bottle test then.

The governing rule if it is ever built: **AI proposes, human confirms, the app
never blocks on the AI being right.** Log `ai_proposed_fill` against
`human_confirmed_fill` from day one — that is the kill-switch evidence.

**A cheaper alternative worth piloting first:** a $30 scale plus stored tare
weights gives ±2% on opaque bottles in bad light, which no camera will match.
`empty_weight_g` and `full_weight_g` already exist for it.

---

## Selling it — not a phase yet

Truestock is multi-tenant because it is meant to be sold (invariant 9), and that
was done before the first migration ran because tenant isolation is cheap now and
a data migration plus a full invariant re-audit later.

**Deliberately not built, all additive:** users in more than one organization, an
org switcher, billing, self-serve signup, per-tenant subdomains.

**Nothing here should be built before one bar uses the product for a month.** The
first real customer is the one already counting — which, under the new order,
starts at Phase 3.

---

## Explicit non-goals

Unchanged from spec §3, and worth re-reading monthly — scope creep into a full
bar-management platform is the named risk.

- Recipe/pour costing per cocktail
- Employee-level shrinkage attribution
- Multi-location for a single tenant
- Full offline operation
- Wine-specific features (decided 2026-07-26 — volume does not justify it)
- Vintage tracking
