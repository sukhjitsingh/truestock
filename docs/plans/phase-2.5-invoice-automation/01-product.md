# Gate 1 — Product: Phase 2.5 OCR invoice automation

No databases, schemas, endpoints or file names in this document. That is Gate 2.

Cites `ROADMAP.md` Phase 2.5 and `docs/invoice-automation-research.md` (Parts 1–5)
rather than re-deriving them. The decision note in the research doc is binding:
**xtraCHEF is out; the build replaces it.**

---

## Problem

**In the owner's words:**

> "Every cost in this app still has to be typed in by hand. I got to about thirty
> products last time and gave up. Until the costs are in, the app tells me my
> inventory is worth nothing — which I know is wrong."

> "I'm paying for a subscription to read my invoices and I don't trust what it
> reads. It's a hundred and fifty dollars a month minimum, the OCR is the thing
> everyone complains about in its own reviews, and when the state asks for two
> years of invoices it can't give me a packet — I'd still be digging through
> paper."

> "A keg comes in with a deposit on it — thirty to fifty dollars that I get back
> when the keg goes home. If that deposit gets counted as what the keg cost me,
> every pour is priced fifteen percent high and I won't see it. It looks like a
> real number. It isn't."

> "The invoices pile up. The law says I have to be able to produce two years of
> them on request, and right now that means a shoebox and an afternoon."

**What ties them together:** the catalog is uncosted because the numbers live on
paper invoices, and the only way they get in is typing. Phase 1.2 built the
typing tool; the owner stopped at product thirty anyway. The invoices are the
source of truth, they arrive every week, and nobody is extracting them.

This is the same shape as every failure this project treats as its worst: not a
broken number, but a **missing** one — an unpriced product silently excluded
from valuation while the total looks plausible.

---

## Success metric

**One number, measured the same way twice:**

> **The owner takes a month's worth of real invoices — 20–25 documents, roughly
> 40 pages, whatever mix of photos, PDFs and emails actually arrives — and goes
> from "in the inbox" to "approved" in a single sitting of under 30 minutes.**

Measured by: timing the first real month after the feature ships, twice — once
the month after that, to confirm it holds as the habit forms. This is the
review-queue-as-governor claim made measurable: extraction speed is irrelevant
if the owner spends an hour a month staring at a queue.

**Three supporting checks, each pass/fail:**

- **The arithmetic check passes on every approved invoice.** The lines add up to
  the total printed on the document. If they don't, the invoice stays in review —
  a dropped line silently under-costs, and under-costing is the failure mode.
- **No keg deposit has ever been folded into a product cost.** A keg invoice
  shows its deposit line as not-product, and the resulting per-bottle cost
  excludes it. Verified by spot-checking the first month's approved keg invoices
  against the original documents.
- **Every invoice from the first month is still in the archive, retrievable by
  vendor or date, three months later** — the retention story exists before any
  regulator asks, and "can I find that invoice?" is answered in one search, not
  one shoebox.

**Explicitly not measured here:** a two-year-old invoice still existing. The
retention mechanism is built now (`retention_until`), but time is the only thing
that proves it. And auto-approval throughput is deliberately *not* a metric —
auto-approve is off for the first ~100 invoices by design (research §3.4), so
the 30-minute number is measured with human review on every document, which is
the honest number.

---

## Announcement

**Truestock now reads your invoices.**

Snap a photo or forward the email, and the line items come back — what you
bought, how many, what it cost — with keg deposits and freight kept out of your
product prices where they belong. Nothing is trusted until you've looked at it:
an invoice that doesn't add up, a price that jumped, a duplicate you already
entered — each one is flagged with *why* it's waiting, not just "needs review."
Fix a line once and the next invoice from that vendor is already right. Costs
flow into your catalog the moment you approve, so the valuation finally has
something real to count, and your reorder list can work. And when the state
asks, the last two years of invoices and counts export as one packet, with a
manifest proving what's in it.

That's the subscription you were paying to replace, built in, for the cost of a
cup of coffee a month.

---

## Screens

Five screens, all new. Mockups are plain HTML, no framework, throwaway by
design, and render every state named below at once, labelled — nothing hidden
behind a click.

| File | Screen |
|---|---|
| `mockups/upload.html` | **New** — getting an invoice in: photo capture, file upload, and a forwarding address that lands emailed invoices in the archive. Shows the three intake paths and the "what happens next" hint. |
| `mockups/review-queue.html` | **New** — the list of invoices waiting on the owner. Each row shows vendor, date, total, and **typed** exception badges ("price jump", "duplicate", "doesn't add up", "unmatched item"). This is the screen the 30-minute number is measured against. |
| `mockups/review-invoice.html` | **New** — the centerpiece: the document on the left, the editable line table on the right, exception badges across the top. Shows the fix-a-line-once affordance ("map this item to your catalog — the next invoice from this vendor will already know it") and the approve/return controls. Every state the research names is here: unmatched line, price variance, missing pack size, total mismatch. |
| `mockups/archive.html` | **New** — every captured invoice, searchable by vendor and date, with its retention date shown. Shows a document that was never approved next to an approved one, and the "this cannot be deleted" framing on every row. |
| `mockups/audit-packet.html` | **New** — the one-button export: pick a date range, get a packet. Shows the request, the "this takes a few minutes, we'll email you a link" state, and what the packet contains (invoices, counts, manifest). |

Two rules carry over from `AGENTS.md` and are not negotiable in the mockups:

- **The back office renders light** (this is office work, not the dim bar), but
  it gets used on a phone anyway — the review queue at least. Tap targets and
  one-handed reachability still apply; the invoice's line table is the one
  genuinely desk-shaped exception, and the mockup should show both.
- **A plausible-but-wrong number is worse than an obviously broken one.** The
  review screen never shows a derived total as if it were printed. If the lines
  don't sum to the printed total, both numbers are shown and the mismatch is the
  badge — never a silently "fixed" figure.

---

## Not in this bundle

Stated so it isn't discovered later:

- **Auto-approve.** Research §3.4 is explicit: never before ~100 invoices of
  real correction data calibrate the confidence threshold. Choosing a threshold
  now is guessing. The feature ships with human review on every document.
- **Vendor EDI feeds, three-way match, receiving, AP payment, QuickBooks/Xero
  sync.** Named in research §3.8 as deferred indefinitely. They are how the
  industry does this at scale; they are not this bar's problem.
- **Reading distributor portals automatically.** Research Part 5 is blunt: the
  portals' downloads are scans of signed paper, and automating login + download
  is a fragility and terms-of-service rabbit hole. Intake stays human-shaped —
  photo, file, email-forward. The owner logs into the portals *once*, during the
  first week of build, to measure the text-vs-scanned split; that measurement
  informs nothing in this Gate, it sizes the build.
- **Corrections to old closed counts.** An approved invoice writes costs forward.
  Closed counts stay exactly as they were counted — that is invariant 2 and no
  feature may touch it.
- **The owner's ninety uncosted products.** This feature populates costs from
  the first approved invoices; it cannot invent the backlog. Phase 2.9 still
  owns the manual entry of whatever the invoices don't cover.

---

## What "done" looks like at the end of the phase

The owner's month-end routine is: forward or photograph the week's invoices,
review them in one sitting, approve. The catalog's costs come from the approved
invoices — never from a re-typed number and never from a deposit line. The
valuation and reorder list are fed by real unit costs for the first time. And
every document that entered the archive is findable, un-deletable, and exportable
as part of an audit packet, because the retention obligation is met at write time
rather than hoped for later.
