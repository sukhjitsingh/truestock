# Truestock — roadmap

Where this goes after the MVP. `STATE.md` is where it is now.

Phases are ordered by dependency, not ambition. Two of them are conditional and
should not be started until the question above them is answered — that is the
point of writing them down rather than building them.

---

## Phase 1 — MVP · *built, not deployed*

Catalog, locations, barcode scan, fill level in tenths, quantity input, count
sessions with the Draft → Closed lifecycle, valuation, reorder list, three roles,
multi-tenancy.

**Remaining work is verification, not construction.** See `docs/go-live.md`.

**Done when:** a full count runs on a phone in under 20 minutes, weekly counts
happen without being nagged, and the numbers are trusted enough to act on.

---

## Phase 1.5 — Make it survive daily use

Small, unglamorous, and it is what decides whether the MVP is still in use in
three months. Driven by open-items, each with its own trigger.

- **User management** (#3) — a screen to deactivate someone and change a role.
  Must revoke `session` rows in the same transaction as flipping `active`.
  *Trigger: the first time anyone needs deactivating.*
- **Real costs entered** (#4) — 88 unit costs and 16 case sizes. Valuation is thin
  until this happens. *Trigger: the owner working through supplier invoices.*
- **Uncapped dashboard reads** (#14) — replace capped list reads with a dedicated
  aggregate. *Trigger: catalog passes ~100 products.*
- **Session sweep** (#1b) — a batched nightly delete on Hostinger cron.
  *Trigger: first deploy, or `session` growth being noticed.*
- **Rapid-scan mode** (#10) — `scanCountLine` is built and unreachable. Could be a
  real win on the 60–75% of units that are sealed. *Decide against a timed count,
  not in the abstract — and if the answer is no, delete it.*

---

## Phase 2 — Toast PMIX import + variance

**This is the feature that justifies the whole project.** Theoretical usage from
the POS against actual usage from counts.

CSV upload, map Toast Item GUID → product + pour spec, produce the
actual-vs-theoretical report.

**The recipe map is the work, not the import.** Draft is nearly free — a 16 oz
Coors Light is one Toast item, one product, one pour size. Cocktails are where the
tedium lives.

Draft depletion must be grossed up by the waste factor (invariant 10): a 16 oz
pour draws `16 / (1 - waste_factor)` from the keg. Skip it and every keg looks
~10% short, turning the report into false positives.

**Do not start until several months of trustworthy counts exist.** A variance
report built on counts nobody believes is worse than no report, because it will
be believed. This is why it comes after the MVP has been running, not after the
MVP has been built.

---

## Phase 3 — Compliance packet · *the differentiator*

Arizona A.A.C. R19-1-501: two years of invoices, monthly beginning/ending
inventory, produced on request.

- Month-End Close report, food and liquor separated, locked once closed
- `retention_until` on every invoice image, never auto-deleted before it
- One-button audit packet export: date range → PDF/ZIP
- Immutable who-counted-what-and-when

**No off-the-shelf product produces this**, which is a large part of why building
rather than buying was the right call.

Closes open-item #2 as a prerequisite: fill corrections currently write no ledger
row, which is exactly the audit-trail gap this phase cannot ship with. Decide the
ledger convention for replaces deliberately — it changes what the export means.

---

## Phase 4 — Invoice capture · *conditional*

> **Settle the xtraCHEF question first (spec §13).** That subscription is already
> paid for and already does invoice line-item capture and archival. **One hour of
> testing decides whether this phase needs building at all.** Photograph a month
> of liquor invoices into it and judge the extraction.

If it is built, build it in the order researched in
`docs/invoice-automation-research.md`:

**Phase A — no AI (~1.5 weeks).** Upload, object storage, `retention_until`,
manual line entry. This satisfies the Arizona retention requirement on its own and
**should ship whichever way the xtraCHEF test goes.**

**Phase B — extraction.** OCR behind a thin `extractInvoice()` interface so the
provider is a one-file change. Run a 20–50 invoice eval before trusting any
published benchmark; they contradict each other on line items.

Three things the market knows that the original spec missed:

1. **Human review *is* the product.** Every competitor staffs it. OCR is the cheap
   half.
2. **Deposits, freight and tax are invoice lines that are not product cost.** A
   keg's $30–50 deposit folded into unit cost makes every keg ~15% high and
   poisons the variance report.
3. **Distributor portals may mean no OCR at all** for some vendors.

**This phase reverses two deliberate MVP exclusions** — it needs AI and file
storage. That is fine here and nowhere earlier.

---

## Phase 5 — AI fill estimation · *conditional, lowest priority*

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
first real customer is the one already counting.

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
