# Invoice automation — competitive teardown, buy vs build, and a build spec

Research input for the spec §13 xtraCHEF decision. **This document does not replace the
one-hour test** — it tells you what to look for while running it, and what to build if it
comes back negative.

Nothing here touches code. The Drizzle definitions in Part 3 are a *design proposal*;
`db/schema.ts` is unmodified.

Researched 2026-07-27. Pricing and review scores go stale fast — every figure is sourced,
and where a vendor hides pricing behind a demo this says so rather than guessing.

---

## Executive summary

**Lean: build, but not yet, and not all of it.** Truestock is being sold as multi-tenant
SaaS. A bought invoice pipeline solves the problem for one bar and leaves every future
customer with a product gap — and it puts the data that feeds valuation, variance, and the
Arizona audit packet inside a vendor you don't control. That argument is close to decisive
on its own. What it does *not* justify is building the AI half first: the compliance
archive (upload + storage + retention + manual line entry) has no AI in it, satisfies
A.A.C. R19-1-501 by itself, unblocks open-item 4, and is about a week and a half of work.
Ship that regardless of how the test goes.

**Three things the market does that the spec has not considered** are in §1.4. The biggest
is that the commercial answer to line-item accuracy is not better OCR — it is OCR plus a
human, sold as a feature. MarginEdge advertises "~24-hour line-item turnaround"; BevSpot
says a "dedicated team" reviews the digitized data. The spec treats extraction as a solved
AI problem with a confidence score attached. It isn't.

**OCR recommendation: Claude Sonnet 5 behind a thin `extractInvoice()` interface**, with
AWS Textract AnalyzeExpense as the documented fallback. Reasoning in §3.2.

---

# Part 1 — Competitive teardown

## 1.1 xtraCHEF by Toast — the incumbent

**Pricing: not published.** Toast quotes it through sales or as an add-on to an existing
Toast account. Third-party listings cite roughly **$149/mo** (Capterra) up to **$349/mo**
for a professional tier — *no dollar figure is vendor-confirmed*, and you should treat both
as unreliable.
([RestaurantTools.ai](https://restauranttools.ai/tools/xtrachef),
[independent review](https://restaurantinventorymanagementsoftware.com/solutions/xtrachef))

**Tiers.** Essentials (formerly Lite) = invoice processing with AI line-item capture,
accounting sync, basic food-cost analytics. Pro = all of that **plus recipe costing and
inventory management**. Spec §13's read is correct: Essentials was never going to do
counting or actual-vs-theoretical — those are Pro features.
([Phoenix Geeks tier writeup](https://phoenixgeeks.us/about-phoenix-geeks/pg-restaurant-blog/maximizing-efficiency-with-xtrachef-essentials-vs-pro/))

**Capture workflow.** Three intake paths: email forwarding of vendor invoices, mobile photo
capture of paper, and automatic processing through supported integrations. Vendor claim:
"AI extracts line items, quantities, and prices from invoices with 99%+ accuracy."
That number is marketing, not measurement.

**Accounting sync.** QuickBooks Online, Xero, Sage Intacct, Oracle NetSuite, with GL
coding. **Price-change alerting** is present ("alerts you to significant price
fluctuations"). **Archival/retention policy is not documented publicly** — which is a
problem, because that is exactly the Arizona §10 requirement you'd be depending on.

**Review sentiment — spec §13's 2.4/5 figure still holds.** G2: **2.4/5 across 12
reviews**. Capterra: **4.3/5 across 6 reviews**. The gap is real and the samples are tiny
on both sides. What the complaints are actually about:

| Complaint | Frequency |
|---|---|
| Support offers immediate workarounds but never root-causes; "hundreds of hours in back-and-forth emails"; same problems persisting 3+ years | Dominant theme |
| **OCR scanning inaccurate** — "causes more issues than helps" | Recurring |
| Software loading issues; scheduled downtime every Sunday night | Recurring |

([G2 reviews](https://www.g2.com/products/xtrachef/reviews),
[G2 pros/cons](https://www.g2.com/products/xtrachef/reviews?qs=pros-and-cons))

Twelve reviews is not a verdict. It is enough to say the risk spec §13 flagged is real and
unresolved, and that your own hour of testing is worth more than the score.

## 1.2 Feature matrix — restaurant/bar tools

Legend: ● full · ◐ partial/tier-gated · ○ absent or undocumented · ? not verifiable

| | Price (verified?) | Email-in | Mobile photo | Vendor EDI | Human review | Line items | Item→catalog match | Price alerts | Accounting sync | Counting / AvT |
|---|---|---|---|---|---|---|---|---|---|---|
| **xtraCHEF Essentials** | ~$149–349/mo (**unverified**) | ● | ● | ◐ | ? | ● | ● | ● | ● (QBO/Xero/Intacct/NetSuite) | ○ |
| **xtraCHEF Pro** | quote only | ● | ● | ◐ | ? | ● | ● | ● | ● | ◐ (weak on bar per reviewers) |
| **MarginEdge** | **$350/mo/location**, unlimited invoices | ● | ● | ● | ● (**~24h turnaround, advertised**) | ● | ● | ● | ● QBO/Xero/Intacct | ● |
| **Ottimate** (ex-Plate IQ) | quote only | ● | ● | ● | ● | ● | ● | ● | ● + AP payments | ○ |
| **Restaurant365** | ~$600–800/location/mo (3-unit quote) | ● | ● | ● | ● | ● | ● | ● | ● (full ERP) | ● |
| **Craftable** (Bevager/Foodager) | quote only | ● | ● | ● (distributor EDI) | ● | ● | ● | ● | ● | ● (bar-focused) |
| **WISK** | **$189/mo** entry; $159–799 by size | ● | ● | ◐ | ? | ● | ● | ● (**"cost change → alert"**) | ● | ● (bar-focused) |
| **BevSpot** | ~$99/mo entry | ◐ | ● | ○ | ● (**"dedicated team reviews"**) | ● | ● | ● | ◐ | ● |
| **Backbar** | **$0 / $79 / $129** | ○ | ● | ○ | ? | ◐ **$129 tier only** | ● | ◐ | ○ | ● |
| **Sculpture Hospitality** | quote only | ? | ● | ? | ● (**human consultant does the count**) | ● | ● | ? | ● | ● |
| **Optimum Control** | quote only | ? | ● | ? | ? | ● | ● | ● | ● | ● |
| **Yellow Dog** | quote only | ? | ● | ● (200+ integrations) | ? | ● | ● | ? | ● | ● |

Sources: [MarginEdge pricing](https://www.marginedge.com/pricing/) ·
[MarginEdge independent review](https://restaurantinventorymanagementsoftware.com/solutions/marginedge) ·
[WISK review](https://restaurantinventorymanagementsoftware.com/blog/wisk-ai-review-pricing-alternatives) ·
[Backbar pricing](https://www.getbackbar.com/pricing) ·
[BevSpot](https://www.softwareadvice.com/inventory-management/bevspot-profile/) ·
[Restaurant365 quote range](https://factura.ai/restaurant365-review/) ·
[Craftable](https://craftable.com/foodager/) ·
[category comparison](https://restaurantinventorymanagementsoftware.com/category/inventory)

**Two price anchors worth internalizing.**

1. **Backbar prices "photograph an invoice and get line items typed in for you" at a $50/mo
   delta** — $79 Essential stores the photo, $129 Professional does "automatic invoice data
   entry… All data from your invoices will be entered for you just by taking a picture."
   That is the market's honest valuation of the exact feature you are considering building.
2. **The category norm is flat per-location with unlimited invoices**, not per-document.
   MarginEdge is explicit about it. If Truestock ever charges for this, per-document pricing
   is off-model for the buyer.

## 1.3 Horizontal AP / document-OCR players — for the workflow patterns

| | Pricing | Pattern worth stealing |
|---|---|---|
| **Rossum** | **from ~$18,000/yr** — enterprise only | Claims >98% accuracy and specifically leads on *line items*, from training on millions of invoice layouts rather than templates. Their positioning confirms line items are the hard part. |
| **Dext** | SMB pricing, email-first | **Lowest-friction ingestion wins.** Email-in as the primary channel, not photo. |
| **Vic.ai** | enterprise | Autonomous GL coding at both header and line-item level. |
| **Ramp** | **$0** AP tier (funded by card interchange); Plus $15/user/mo | Free OCR + approval workflows + fraud checks; three-way matching on the paid tier. Shows the feature can be a loss-leader. |
| **Bill.com** | per-user subscription | The reference AP approval-routing model. |

Sources: [Rossum/Dext/Vic.ai comparison](https://www.gennai.io/blog/invoice-automation-tools-comparison-2026) ·
[Ramp AP](https://ramp.com/accounts-payable) ·
[Ramp vs Bill.com](https://www.kenfromfinance.com/blog/ramp-vs-bill-com)

The consistent industry statement across these sources: *"line-item extraction remains the
hardest problem"* — a typical invoice has 5–50 line items, and header-field accuracy
(vendor, date, total) is a solved 95%+ while line items are where providers diverge.
Header accuracy is worthless to Truestock. Every number that matters is on a line.

## 1.4 What the market does that the spec has not considered

This is the highest-value section. Ordered by how much it would hurt to discover late.

### (a) Human review is the product, not the fallback

MarginEdge sells "fast (~24-hour) line-item invoice digitization" as a headline feature.
BevSpot: "a dedicated team reviewing the digitized data." Sculpture Hospitality sends a
human to do the count. **Three independent vendors in this category concluded that
unattended extraction is not good enough and built the human in.**

Spec §7 frames invoice OCR as "the single most valuable AI feature." The market's answer is
that OCR is the cheap half and the review queue is the product. Design accordingly: the
review UI is the largest single chunk of work in Part 3's estimate, and that is correct,
not a smell.

The corollary matters for the test: **if xtraCHEF's ~24h turnaround is human-mediated, that
is a feature, not latency to complain about** — and it also means the "scan an unknown
bottle during a count and have it resolve" flow will never work through it.

### (b) Vendor EDI / direct distributor feeds — the highest-accuracy path involves no OCR at all

MarginEdge, Restaurant365, Craftable, Ottimate and Yellow Dog all accept EDI feeds directly
from major distributors (Sysco, US Foods), *bypassing scanning entirely*.
([Fintech EDI writeup](https://fintech.com/blog/the-benefits-of-edi-integration-with-restaurant-accounting))

A bar buys liquor from two to four wholesalers. In most US markets those wholesalers
(Southern Glazer's, RNDC, Breakthru) run a customer portal with downloadable invoice
history — often CSV, always PDF. **For the majority of your volume the hard AI problem may
be an integration problem you can solve with a login and a download.** The spec's Phase 4
assumes photograph → OCR is the only path in. It should assume OCR is the *fallback* for
the vendors who don't have a portal.

Do this check during the hour: log in to the bar's distributor portals and see what export
formats exist. It costs ten minutes and may delete half the project.

### (c) Deposits, freight, and fees are not product cost — and this is a Truestock-specific landmine

An invoice total is not the sum of its product lines. Keg deposits are the classic bar case:
a half barrel carries a **$30–50 refundable deposit** that is not COGS. Freight, fuel
surcharge, state liquor tax and bottle deposits all appear as invoice lines.

Divide naively and every keg's unit cost is inflated by roughly 15%, every draft pour cost
is wrong, and the Phase 2 variance report — the report that justifies the whole project —
is built on it. **This is precisely the "numbers that look plausible and are wrong" failure
mode CLAUDE.md names as the app's worst.** Neither spec §8's `InvoiceLine` sketch nor
anything else in the docs models a non-product line.

Fix in Part 3: `invoice_line.line_type`, and cost derivation that only reads
`line_type = 'product'`.

### (d) Credit memos and short deliveries

The spec models `Invoice` as a positive document only. Reality: your kitchen rejects a
shorted delivery or returns empties, and the supplier issues a **credit memo** that must be
matched against the original invoice. Restaurant365 and MarginEdge both handle these; the
industry guidance is explicit that credit memos are what keeps a vendor feed correct.

A returned keg's deposit credit is the common bar case and it is a *negative* line against a
*deposit* line type. Model it now (a `document_type` discriminator) or migrate later.

### (e) Duplicate-invoice detection and exception routing by type

Standard in the category: exceptions are *typed* — price variance, quantity short, duplicate
invoice number — and routed to the person who can resolve that class. For a single bar the
routing is trivial (there's one owner), but the *typing* is not: it determines what the
review queue shows and it is the difference between "3 invoices need attention" and "3
invoices need attention: 1 price jump, 1 short-ship, 1 duplicate."

Duplicate detection is cheap and high-value: content hash for byte-identical re-uploads,
plus `(organization, vendor, invoice_number)` for the same invoice photographed twice.

### (f) Three-way match (PO ↔ receiving ↔ invoice)

The control that compares purchase order, receiving report, and invoice, releasing only when
all three agree within tolerance. Truestock has none of the three concepts.

**This is where the money actually leaks** — you can only detect being billed for product
that never arrived if something recorded what arrived. It is also correctly out of scope for
the MVP and probably for v2. Named here so that when you eventually build receiving, you
know it wants to close this loop rather than be a standalone feature.

### (g) The vendor's item code is the durable join key, not the description

The market matches on the vendor's own SKU. `"TITOS HNDMD VDKA 750"` is unstable across
invoices and vendors; Southern Glazer's item number for it is stable forever. Spec §674's
framing — invoice OCR auto-creating draft products keeps the catalog from decaying — is
right about the *goal* and quiet about the *key*. Match on `(vendor_id, vendor_item_code)`
first and fall back to description only when a code is absent.

### (h) Price-variance alerting is the retention feature

Every single competitor has it. It requires no AI, no matching sophistication, and nothing
but cost history — and it is the feature owners actually open the app for. WISK's pitch is
literally "if a cost change occurs, you'll get an alert so you can decide whether to adjust
your pricing." It costs one table and one query. Build it in the first invoice phase, not
later.

---

# Part 2 — Buy vs build

## 2.1 Real subscription cost

For one bar, the realistic options and their honest annualized cost:

| Option | Monthly | Annual | What you get | What's missing |
|---|---|---|---|---|
| Keep xtraCHEF Essentials | ~$149–349 (**unverified**) | $1,800–4,200 | Invoice pipeline + archive | No counting, no AvT, no Arizona packet |
| Upgrade xtraCHEF Pro | quote | ? | + counting + recipe costing | Reviewers flag bar-specific inventory as its weakest area (spec §13 already notes the loudest source is a competitor — but the G2 scores are independent) |
| MarginEdge | $350 | $4,200 | Invoices + counting + AvT + price alerts, unlimited | Toast users pay a **~$50/mo API pass-through**; no Arizona packet |
| WISK | $189–299 | $2,270–3,590 | Bar-native counting + invoice scanning | No Arizona packet |
| Backbar Professional | $129 | $1,548 | Auto invoice data entry + bar counting | No Arizona packet, no AvT depth |
| Cancel everything, build | ~$3–6 API + <$1 storage | **~$50–80** | Everything, eventually | Six to nine weeks of your time |

## 2.2 Real running cost of building

**Volume assumption for one bar:** two to four deliveries a week from two to four vendors ≈
**20–25 invoices/month, 1–3 pages each ≈ 40 pages/month.** Adjust when you count the actual
stack of paper.

Per-page extraction cost, one vision call with a ~1,500-token schema/instruction prompt and
~1,500 tokens of JSON out:

| Provider | Per page | 40 pages/mo (1 bar) | 4,000 pages/mo (100 tenants) | Notes |
|---|---|---|---|---|
| **Claude Haiku 4.5** ($1/$5 per MTok) | **~1.1¢** | **$0.42** | $42 | 1568px cap — small print is a risk |
| **Claude Sonnet 5** ($3/$15; intro $2/$10 through 2026-08-31) | **~4.1¢** (~2.8¢ intro) | **$1.64** | $164 | 2576px high-res tier |
| **Claude Opus 5** ($5/$25) | ~6.9¢ | $2.76 | $276 | Overkill for transcription |
| AWS Textract AnalyzeExpense | ~1¢ ($10/1k pages) | $0.40 | $40 | 150 pages/mo free tier |
| Azure Document Intelligence (prebuilt invoice) | ~1¢ ($10/1k pages) | $0.40 | $40 | |
| Google Document AI Invoice Parser | **~10¢ effective** | $4.00 | $400 | Bills in **10-page blocks** — a 1-page invoice costs the same as ten |
| Veryfi | 8–16¢ | — | — | **$500/mo floor** — disqualifying below ~5,000 pages/mo |
| Nanonets | ~5¢ | $2.00 | $200 | Pay-as-you-go, $200 signup credit |
| Rossum | — | — | — | **From ~$18,000/yr.** Enterprise. |

Claude pricing per the `claude-api` skill (cached 2026-06-24). Textract/Azure/Google/Veryfi/
Nanonets/Rossum per the searches cited in §1.3 and
[AWS](https://aws.amazon.com/textract/pricing/) /
[Azure](https://docuocr.com/blog/azure-document-intelligence-pricing) /
[Google](https://flowwright.com/blog/document-ai-pricing-guide) writeups. Some sources
disagree on Textract AnalyzeExpense ($1.50 vs $8–10 per 1,000 pages) — the $10 figure is the
conservative one and is what AWS's own page implies at ~$0.01/page.

**Storage.** An invoice page as a downscaled JPEG is ~300 KB; keep the full-resolution
original too and call it ~1.8 MB per page. One bar: 40 pages/mo → ~860 MB over a three-year
retention → **under 2¢/month on Cloudflare R2** ($0.015/GB-mo). One hundred tenants: ~86 GB
→ **~$1.30/month.** Storage is genuinely free at this scale; the reason to think about it is
durability, not cost.

**So: the marginal cost of building is roughly $2–4/month for one bar and under $200/month
at a hundred tenants.** Cost is not a decision variable here. Effort is.

## 2.3 Real build effort

Honest days-of-focused-work, for someone who knows this codebase:

| Chunk | Days |
|---|---|
| Schema + migrations (7 tables) | 2–3 |
| Upload, object storage, signed URLs, retention | 3–4 |
| Extraction job pipeline (queue table + cron worker + retries + idempotency) | 4–5 |
| **Review queue UI** — the largest piece | 5–7 |
| Product matching, aliasing, learned mappings, draft-product path | 5–7 |
| Cost flow + price history + invariant-2 safety | 2–3 |
| Audit packet export (background job → ZIP → signed link) | 3–4 |
| Offsite second copy + retention enforcement | 2 |
| Testing against real messy invoices | 3–5 |
| **Total** | **~30–40 days ≈ 6–8 focused weeks** |

For a solo builder with a bar to run, that is three to four months of calendar. Say the
calendar number out loud when deciding, not the effort number.

One platform constraint worth naming now: **Hostinger managed Node has no Lambda and no
queue service.** The extraction pipeline has to be a database-backed job table drained by a
cron-invoked worker route (Hostinger does support cron jobs). That is fine — it's how the
job table in Part 3 is shaped — but it means "just fire an async function" is not the
design, because a Next.js request that returns kills the work.

## 2.4 What you give up by building

- **Vendor EDI relationships.** MarginEdge and R365 have direct feeds from Sysco and US
  Foods. You cannot get those. (Mitigated by §1.4(b): distributor *portals* are usually
  reachable by hand, and liquor distributors are not Sysco.)
- **QuickBooks / Xero / Sage sync.** Real work, real ongoing maintenance, and the thing
  every bookkeeper asks for on day one. Not building it means the owner still re-keys into
  accounting.
- **A maintained item-matching corpus.** Ottimate and Rossum have seen millions of invoices.
  Your matcher starts at zero and learns only from your own corrections.
- **Someone else's support burden.** When extraction breaks at 11pm before a count, that is
  now your problem forever.
- **AP payment rails.** Ottimate, Ramp, Bill.com pay the vendor. Out of scope and should
  stay out of scope.

## 2.5 What you give up by buying — and why this is probably decisive

- **Control of the data that feeds valuation and variance.** Every closed count's value,
  every pour cost, and the entire Phase 2 variance report derive from unit costs that would
  live in Toast's database.
- **A second system of record.** Two places where "what does this product cost" is answered,
  with no constraint keeping them in agreement. CLAUDE.md's whole invariant list exists
  because plausible-but-wrong numbers are this app's worst failure mode; a second
  uncontrolled cost source is a factory for them.
- **A subscription you don't control**, whose OCR quality is the single most-complained-about
  thing in its own reviews.
- **The Arizona audit packet stops being one button.** Spec §10 calls the packet the
  differentiator. It is a ZIP of invoices + closed counts + monthly beginning/ending figures.
  If the invoices live in xtraCHEF, half the packet is a manual export from another vendor's
  UI. That is not a one-button export and it is not a differentiator.
- **And the one that probably settles it: a bought tool solves this for one bar, not for
  your customers.** Invariant 9 exists because this is being sold. If Truestock ships to a
  second bar, "go buy xtraCHEF too" is the answer to "where do my costs come from" — which
  means every customer needs a Toast account and a second subscription, their cost data
  never enters Truestock, and the product's flagship report can't be built. There is no
  version of Truestock-as-SaaS where the invoice half is somebody else's.

Weigh that last point as heavily as it reads. It doesn't say build it *now*; it says the
invoice half is not permanently outsourceable, so the only question the test answers is
*when*.

## 2.6 The middle path — when it's right and when it isn't

Spec §13's middle path: keep xtraCHEF for invoices, build only the counting half.

**It is right when all of these hold:**
- The only thing shipping this year is the counting half, for this one bar.
- The bar stays on Toast anyway, so the marginal cost is small and cancellation is moot.
- The one-hour test comes back clean *including exportability* (see §2.8, check 6).
- You would otherwise spend those three months not shipping anything.

**It is wrong the moment any of these are true:**
- You are onboarding a second organization. (`organization` is already the tenant boundary
  in the schema — the intent is not hypothetical.)
- The Arizona audit packet needs to actually work.
- Extraction output can be *seen* but not *exported* — that isn't a middle path, it's a
  second silo, and it is the most likely negative outcome of the test.

**A third option the spec doesn't raise, and the best one if the test is ambiguous:** keep
xtraCHEF running for the owner's own bookkeeping *while* building Truestock's Phase A
archive, and use xtraCHEF's extraction output as **labeled ground truth to evaluate your own
extractor**. You need a 20–50 invoice eval set to make any provider decision honestly (§3.2);
xtraCHEF hands you one for the price of a subscription you're already paying. Cancel once
your own numbers beat theirs on your own invoices.

## 2.7 The contract caveat

`docs/spec.md:665` is right to flag it: **Toast contracts commonly run multi-year, and
removing a subscription mid-term may not be available.** Before any of the above matters,
pull the actual agreement and find (a) the term end date and (b) the clause covering removal
of an add-on module. If you can't cancel until 2027, the decision is only about what to
*build*, not about what to *stop paying for* — which makes the middle path strictly better
in the interim, and makes the ground-truth idea in §2.6 free.

## 2.8 The one-hour test — what to actually check

Photograph a month of liquor invoices into xtraCHEF. **Use the worst ones you have** —
carbon copies, faded thermal, handwritten adjustments, three-page deliveries. Clean invoices
prove nothing; every provider in the market scores 95%+ on those.

Work down this list. Checks 2, 5, 6 and 9 are the ones that flip the decision.

| # | Check | Why it flips the decision |
|---|---|---|
| 1 | Are **line items** extracted at all, or only header totals? | If only header + amount, it's an AP tool. It gives you nothing for costing. Stop here and build. |
| 2 | Are `vendor item code`, `description`, `pack/size`, `quantity`, `unit price`, `extended price` **separate fields**? | A description blob can't be matched or costed. This is the single most important check. |
| 3 | Is **pack size** a field, or buried in text (`12/750ML`)? | Case cost ÷ case size is the whole derivation. If pack size is text, you're parsing it yourself anyway. |
| 4 | Sum the extracted **product** lines. Does it equal the invoice subtotal? | Any gap means dropped lines — the silent under-costing failure. |
| 5 | Are **keg deposits, freight, fuel surcharge and liquor tax** separated from product lines? | If folded in, every keg cost is ~15% high and the variance report is poisoned at the source. §1.4(c). |
| 6 | Can you **export line items** — CSV or API — or is it view-only in their UI? | View-only kills the middle path outright. The data can never reach Truestock's valuation. |
| 7 | How long does processing take — seconds, minutes, or overnight? | Overnight rules out any in-count interaction, and tells you the humans are in the loop. |
| 8 | What does it do with a **product it has never seen**? Create it, ask you to map it, or drop it silently? | Silent drops are the worst answer. §1.4(g). |
| 9 | Correct one wrong line. Then photograph the **same vendor's next invoice**. Is that line right now? | Difference between a tool that improves and a tool that costs you ten minutes forever. |
| 10 | Export **every invoice image for a date range** as files. Is it one bulk operation? | This is the Arizona audit packet requirement. One-at-a-time clicking is not a compliance archive. |
| 11 | Submit the **same invoice twice**. Flagged as a duplicate? | §1.4(e). |
| 12 | Submit a **credit memo**. Handled, or does it choke on negative quantities? | §1.4(d). |
| 13 | Hand-verify the extracted **per-unit cost** on three lines — not the totals. | Per-unit cost is what feeds valuation. Totals being right proves nothing about it. |
| 14 | Log in to the **distributor portals** and see what export formats exist. | May make the whole OCR question moot for most of your volume. §1.4(b). |
| 15 | Pull the **Toast agreement** — term end date and add-on removal clause. | §2.7. |

**Decision rules:**

- **Line items export cleanly, with pack size and per-unit cost separated from deposits, and
  corrections stick** → keep it for now, build only the counting half, and revisit when a
  second organization appears.
- **Line items missing, unexportable, or deposits folded into product cost** → cancel (if the
  contract permits) and build.
- **Extraction is good but export is view-only** → not a middle path. Build, and keep the
  subscription only as a ground-truth source until your extractor beats it.

---

# Part 3 — Build spec

Written to be ready whichever way the test goes. Phase A of §3.8 should ship regardless.

## 3.1 Data model

Design proposal. **Do not apply these to `db/schema.ts` from this document** — they go
through the `database` agent and drizzle-kit when the phase is actually planned. Conventions
follow the existing file: `int` autoincrement PKs, `organizationId` on every table with an
FK to `organization` and `onDelete: "restrict"`, `DECIMAL` for all money, `date` columns in
`mode: "string"`, `...auditColumns`.

### Enums

```ts
export const invoiceDocumentTypeEnum = ["invoice", "credit_memo"] as const;
export const invoiceStatusEnum = [
  "uploaded", "extracting", "needs_review", "approved", "rejected", "superseded",
] as const;
export const invoiceLineTypeEnum = [
  "product", "deposit", "deposit_return", "freight", "tax", "fee", "discount", "unknown",
] as const;
export const invoiceLineUomEnum = ["each", "case", "keg", "other"] as const;
export const invoiceMatchMethodEnum = [
  "vendor_alias_code", "vendor_alias_desc", "barcode", "fuzzy", "manual",
  "created_draft", "unmatched",
] as const;
export const extractionJobStatusEnum = [
  "queued", "running", "succeeded", "failed", "cancelled",
] as const;
export const costSourceEnum = ["invoice", "manual", "import"] as const;
```

### `invoice`

```ts
export const invoice = mysqlTable("invoice", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organization_id").notNull()
    .references(() => organization.id, { onDelete: "restrict" }),

  // Nullable until the vendor is identified in review. Ownership-checked on
  // every write — a client-supplied vendorId proves existence, not tenancy
  // (invariant 9).
  vendorId: int("vendor_id").references(() => vendor.id, { onDelete: "restrict" }),

  documentType: mysqlEnum("document_type", invoiceDocumentTypeEnum)
    .notNull().default("invoice"),
  invoiceNumber: varchar("invoice_number", { length: 100 }),
  // DATE, string mode — same timezone reasoning as count_line.opened_at.
  invoiceDate: date("invoice_date", { mode: "string" }),
  deliveredOn: date("delivered_on", { mode: "string" }),

  status: mysqlEnum("status", invoiceStatusEnum).notNull().default("uploaded"),

  // Header totals AS PRINTED on the document, never derived. The arithmetic
  // check in §3.4 compares derived line sums against these; deriving them
  // would make the check vacuous.
  subtotal:     decimal("subtotal",      { precision: 12, scale: 2 }),
  taxTotal:     decimal("tax_total",     { precision: 12, scale: 2 }),
  freightTotal: decimal("freight_total", { precision: 12, scale: 2 }),
  depositTotal: decimal("deposit_total", { precision: 12, scale: 2 }),
  total:        decimal("total",         { precision: 12, scale: 2 }),

  // Object storage, never bytes in the database (spec §552).
  storageBucket: varchar("storage_bucket", { length: 64 }).notNull(),
  storageKey:    varchar("storage_key",    { length: 512 }).notNull(),
  contentSha256: varchar("content_sha256", { length: 64 }).notNull(),
  byteSize:      int("byte_size").notNull(),
  mimeType:      varchar("mime_type", { length: 100 }).notNull(),
  pageCount:     int("page_count"),
  offsiteCopiedAt: timestamp("offsite_copied_at"),

  // Arizona A.A.C. R19-1-501: invoice_date + 2 years minimum, 3 is safer and
  // matches spec §564. Computed on approval, never on upload — an invoice
  // whose date is still unknown gets the longest retention, not the shortest.
  // NO CODE PATH DELETES AN INVOICE OBJECT. There is no delete action.
  retentionUntil: date("retention_until", { mode: "string" }),

  uploadedBy: int("uploaded_by").notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  approvedBy: int("approved_by").references(() => user.id, { onDelete: "restrict" }),
  approvedAt: timestamp("approved_at"),
  rejectedReason: text("rejected_reason"),
  notes: text("notes"),
  ...auditColumns,
}, (t) => [
  // Byte-identical re-upload is a no-op, not a second invoice. Per-tenant:
  // two bars can legitimately hold the same document.
  uniqueIndex("invoice_org_sha_unique").on(t.organizationId, t.contentSha256),
  index("invoice_org_status_idx").on(t.organizationId, t.status),
  index("invoice_org_date_idx").on(t.organizationId, t.invoiceDate),
  index("invoice_org_vendor_number_idx")
    .on(t.organizationId, t.vendorId, t.invoiceNumber),
]);
```

**On the vendor/number duplicate:** deliberately an *index*, not a unique constraint. Vendors
reuse numbers across years, credit memos sometimes carry the parent's number, and a hard
constraint would block a legitimate upload at 11pm. Duplicate-by-number is a **review-queue
warning**, not a database error. Byte-identical is the only thing enforced.

### `invoice_line`

```ts
export const invoiceLine = mysqlTable("invoice_line", {
  id: int("id").autoincrement().primaryKey(),
  // Denormalized from `invoice` so the unique index below can be tenant-scoped
  // and so every read filters on it without a join — same pattern and same
  // reason as productBarcode.organizationId.
  organizationId: int("organization_id").notNull()
    .references(() => organization.id, { onDelete: "restrict" }),
  invoiceId: int("invoice_id").notNull()
    .references(() => invoice.id, { onDelete: "cascade" }),

  lineNumber: int("line_number").notNull(),
  rawText: text("raw_text"),                                   // verbatim, for audit

  // §1.4(c): the line that keeps deposits and freight out of unit cost.
  lineType: mysqlEnum("line_type", invoiceLineTypeEnum).notNull().default("unknown"),

  // §1.4(g): the durable join key.
  vendorItemCode: varchar("vendor_item_code", { length: 64 }),
  description:     varchar("description", { length: 512 }),
  packDescription: varchar("pack_description", { length: 64 }),  // "12/750ML"

  quantity:   decimal("quantity", { precision: 12, scale: 3 }),
  uom:        mysqlEnum("uom", invoiceLineUomEnum),
  // Parsed from packDescription. NULL means "not determinable", never 1.
  packSize:   int("pack_size"),
  unitCost:     decimal("unit_cost",     { precision: 10, scale: 4 }),  // as billed
  extendedCost: decimal("extended_cost", { precision: 12, scale: 2 }),

  productId: int("product_id").references(() => product.id, { onDelete: "restrict" }),
  matchMethod: mysqlEnum("match_method", invoiceMatchMethodEnum)
    .notNull().default("unmatched"),
  matchConfidence: decimal("match_confidence", { precision: 4, scale: 3 }),
  extractionConfidence: decimal("extraction_confidence", { precision: 4, scale: 3 }),

  reviewedBy: int("reviewed_by").references(() => user.id, { onDelete: "restrict" }),
  reviewedAt: timestamp("reviewed_at"),
  ...auditColumns,
}, (t) => [
  uniqueIndex("invoice_line_invoice_lineno_unique").on(t.invoiceId, t.lineNumber),
  index("invoice_line_org_product_idx").on(t.organizationId, t.productId),
  index("invoice_line_org_vendor_code_idx").on(t.organizationId, t.vendorItemCode),
]);
```

### `vendor_item_alias` — the learned mapping

```ts
export const vendorItemAlias = mysqlTable("vendor_item_alias", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organization_id").notNull()
    .references(() => organization.id, { onDelete: "restrict" }),
  vendorId: int("vendor_id").notNull()
    .references(() => vendor.id, { onDelete: "restrict" }),

  vendorItemCode: varchar("vendor_item_code", { length: 64 }),
  // Uppercased, punctuation stripped, abbreviations expanded, size tokens
  // removed — see §3.5. Stored so the unique index can enforce one alias per
  // normalized form.
  normalizedDescription: varchar("normalized_description", { length: 255 }),

  productId: int("product_id").notNull()
    .references(() => product.id, { onDelete: "restrict" }),
  packSize: int("pack_size"),
  uom: mysqlEnum("uom", invoiceLineUomEnum),

  // Only a human confirmation creates an alias. A fuzzy match never
  // self-promotes — that is how a matcher silently learns a wrong mapping and
  // then applies it forever.
  confirmedBy: int("confirmed_by").notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  confirmedAt: timestamp("confirmed_at").notNull().defaultNow(),
  timesApplied: int("times_applied").notNull().default(0),
  lastAppliedAt: timestamp("last_applied_at"),
  active: boolean("active").notNull().default(true),
  ...auditColumns,
}, (t) => [
  uniqueIndex("vendor_item_alias_org_vendor_code_unique")
    .on(t.organizationId, t.vendorId, t.vendorItemCode),
  uniqueIndex("vendor_item_alias_org_vendor_desc_unique")
    .on(t.organizationId, t.vendorId, t.normalizedDescription),
  index("vendor_item_alias_org_product_idx").on(t.organizationId, t.productId),
]);
```

> MariaDB, like MySQL, treats multiple NULLs as distinct in a unique index, so a code-only alias and a
> description-only alias coexist without collision. That is the desired behaviour; it is
> also a footgun if you ever assume the constraint prevents "two aliases for the same line."
> It doesn't. The matcher resolves precedence (§3.5), not the database.

### `invoice_extraction_job`

```ts
export const invoiceExtractionJob = mysqlTable("invoice_extraction_job", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organization_id").notNull()
    .references(() => organization.id, { onDelete: "restrict" }),
  invoiceId: int("invoice_id").notNull()
    .references(() => invoice.id, { onDelete: "cascade" }),

  status: mysqlEnum("status", extractionJobStatusEnum).notNull().default("queued"),
  attempt: int("attempt").notNull().default(1),

  provider:      varchar("provider", { length: 32 }).notNull(),   // "anthropic"
  modelId:       varchar("model_id", { length: 64 }).notNull(),
  promptVersion: varchar("prompt_version", { length: 32 }).notNull(),

  // Same idempotency mechanism as count_line_write.client_line_id, and
  // deliberately NOT per-tenant for the same reason: a UUID that IS the
  // guarantee must not depend on the retry carrying a matching org.
  idempotencyKey: varchar("idempotency_key", { length: 36 }).notNull(),

  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  inputTokens: int("input_tokens"),
  outputTokens: int("output_tokens"),
  costUsd: decimal("cost_usd", { precision: 10, scale: 6 }),

  // Kept forever. Three jobs at once: re-parse without re-paying; audit trail
  // of what the model actually said versus what the human corrected; and the
  // eval set for the next provider comparison. This is the cheapest thing in
  // the whole design and the most valuable six months from now.
  rawResponse: json("raw_response"),
  errorCode: varchar("error_code", { length: 64 }),
  errorMessage: text("error_message"),
  ...auditColumns,
}, (t) => [
  uniqueIndex("invoice_extraction_job_idempotency_unique").on(t.idempotencyKey),
  index("invoice_extraction_job_status_idx").on(t.status, t.id),  // the cron drain query
  index("invoice_extraction_job_org_invoice_idx").on(t.organizationId, t.invoiceId),
]);
```

### `invoice_line_correction` — append-only audit + training signal

```ts
export const invoiceLineCorrection = mysqlTable("invoice_line_correction", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organization_id").notNull()
    .references(() => organization.id, { onDelete: "restrict" }),
  invoiceLineId: int("invoice_line_id").notNull()
    .references(() => invoiceLine.id, { onDelete: "cascade" }),
  field: varchar("field", { length: 64 }).notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  correctedBy: int("corrected_by").notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  correctedAt: timestamp("corrected_at").notNull().defaultNow(),
}, (t) => [
  index("invoice_line_correction_org_line_idx").on(t.organizationId, t.invoiceLineId),
  index("invoice_line_correction_field_idx").on(t.organizationId, t.field),
]);
```

Never updated, never deleted. Two jobs: the audit trail spec §10 wants ("who approved
what"), and the measurement that tells you where extraction is actually weak — a
`GROUP BY field` over six months is a better provider evaluation than any published
benchmark.

### `product_cost_history` — the table that makes invariant 2 safe

```ts
export const productCostHistory = mysqlTable("product_cost_history", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organization_id").notNull()
    .references(() => organization.id, { onDelete: "restrict" }),
  productId: int("product_id").notNull()
    .references(() => product.id, { onDelete: "restrict" }),

  unitCost: decimal("unit_cost", { precision: 10, scale: 4 }).notNull(),
  caseSize: int("case_size"),
  effectiveDate: date("effective_date", { mode: "string" }).notNull(),

  source: mysqlEnum("source", costSourceEnum).notNull(),
  sourceInvoiceLineId: int("source_invoice_line_id")
    .references(() => invoiceLine.id, { onDelete: "restrict" }),
  createdBy: int("created_by").notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("product_cost_history_org_product_date_idx")
    .on(t.organizationId, t.productId, t.effectiveDate),
  uniqueIndex("product_cost_history_source_line_unique").on(t.sourceInvoiceLineId),
]);
```

Append-only. `product.current_unit_cost` becomes a **denormalized cache of the latest row**
rather than the source of truth. That single change is what makes price-variance alerting
(§1.4(h)) a query instead of a feature, and what makes "why is this bottle costed at
$18.40?" answerable.

### Relationship to what already exists

| Existing | Relationship |
|---|---|
| `vendor` (line 279) | `invoice.vendor_id` and `vendor_item_alias.vendor_id`. Already org-scoped. Nothing changes. |
| `product` (line 329) | `invoice_line.product_id`, `vendor_item_alias.product_id`, `product_cost_history.product_id`. Invariant 6 holds — an inactive product still has invoice history pointing at it, which is exactly why it must never be hard-deleted. |
| `product.current_unit_cost` DECIMAL(10,4) | Becomes a cache. Written only by the approval path in §3.6. The 4-decimal precision already exists specifically because unit cost is derived from `case_cost / case_size` — that comment in the schema header is describing this feature before it was built. |
| `product.case_size` | Read during derivation; a `pack_size` disagreement between invoice and catalog is a **review flag**, not a silent overwrite. |
| `count_line` cost snapshots (line 578) | **No code path in the invoice system may write to `count_line`.** Enforce this as a review rule, not just a convention. See §3.6. |

**One additive column on `product`:**

```ts
// True when the row was created by invoice extraction rather than by a human.
// Drives a "needs a real name / category / size" nudge in the catalog screen.
// Not a soft-delete and not `active` — a provisional product is fully usable.
provisional: boolean("provisional").notNull().default(false),
```

## 3.2 OCR / vision provider comparison

| Provider | Line items on messy multi-page | Per page | Latency | Data privacy / training | Verdict |
|---|---|---|---|---|---|
| **Claude (Sonnet 5)** | Strong overall; benchmarks conflict on line items specifically (see below) | ~4.1¢ | 5–20 s | **Commercial Terms: Anthropic does not train on API customer content. API inputs/outputs retained 7 days (reduced from 30 on 2025-09-14), never used for training. ZDR available.** No free tier with different terms. | **Recommended** |
| Claude (Haiku 4.5) | Same family; capped at 1568px so small print degrades | ~1.1¢ | 3–10 s | Same | Cost floor if volume ever matters |
| **Gemini (Flash/Pro)** | One 2026 source puts Gemini 3 Pro highest at 94.75% avg extraction | ~1–3¢ | fast | **Paid tier: not used for training. Free tier / AI Studio: content IS used to improve Google products, human reviewers may see it.** | Capable, but see disqualifier |
| **AWS Textract** AnalyzeExpense | Purpose-built; 91.1% on invoices with line items in one study, but a 2026 source reports a decline to 82.87% | ~1¢ | 2–6 s | AWS standard terms; no training on customer content | **Documented fallback** |
| **Azure Document Intelligence** | 87% line items in one study — the strongest line-item figure found | ~1¢ | 2–6 s | Azure standard terms | Strong second choice |
| **Google Document AI** Invoice Parser | Comparable to Azure/Textract | **~10¢ effective** | 2–6 s | GCP standard terms | **Disqualified on billing shape** |
| **Veryfi** | 98.7% claimed overall, purpose-built for financial docs | 8–16¢ | 3–5 s | Vendor-specific | **Disqualified: $500/mo floor** |
| **Mindee** | Competitive; no minimum commitment | quote | fast | Vendor-specific | Viable, unremarkable |
| **Nanonets** | Performed well in comparative tests | ~5¢ | — | Vendor-specific | Pricing opacity |
| **Rossum** | Leads on line items — trained on millions of layouts, not templates | — | — | Vendor-specific | **Disqualified: from ~$18,000/yr** |

Sources: [AI Multiple invoice OCR benchmark](https://aimultiple.com/invoice-ocr) ·
[invoicedataextraction benchmarks](https://invoicedataextraction.com/blog/invoice-ocr-api-benchmarks) ·
[Parsli LLM-vs-OCR](https://parsli.co/blog/llm-ocr-vs-traditional-ocr) ·
[Anthropic commercial terms summary](https://terms.law/ToS-Watchdog/ai-services/anthropic/) ·
[Gemini tier privacy split](https://docs.bswen.com/blog/2026-03-23-gemini-free-tier-data-privacy/) ·
Claude pricing per the `claude-api` skill (cached 2026-06-24).

### Uncertainty, stated plainly

**The published benchmarks contradict each other on the only question that matters.**

- AI Multiple (**December 2024**, ~400 key-value pairs from **20 public invoices**) found
  Claude Sonnet 3.5 highest overall including on degraded images — and noted *all* providers
  "often face difficulties in extracting line items."
- A separate cited study put GPT-4o + OCR at **57% on line items** versus Azure Document
  Intelligence at **87%** and Textract at **82%** — i.e. the general LLM materially *worse*
  than specialized parsers on structured table extraction.
- Another 2026 figure has Textract's own line-item performance falling from 91.10% to 82.87%
  year over year.

These measure different corpora with different metrics, both samples are tiny, and **none
used liquor distributor invoices.** Do not act on any of them. The `invoicedataextraction`
survey says it outright: no published benchmark includes messy, multi-page, multi-language
invoices at scale.

**Run your own eval on 20–50 of this bar's actual invoices before committing.** That is the
only number worth anything, and §2.6 explains how to get the labeled set for free.

### Recommendation: Claude Sonnet 5, with reasons

1. **The privacy question has no trap in it.** Spec §198 already flags that free tiers
   training on prompts are disqualifying for vendor cost and margin data. With Gemini that
   remains a live footgun forever — one developer prototyping against a free key leaks the
   bar's cost structure, and nothing in the code makes that visible. Anthropic's commercial
   API terms have no free tier with different terms to fall into. For a system that carries
   invoices, vendor pricing and margin, removing a whole class of accidental disclosure is
   worth more than a percentage point of extraction accuracy.
2. **The task is not OCR.** It is transcription *plus* normalization *plus* classification:
   assign `line_type`, parse `pack_size` out of `"12/750ML"`, decide `uom`. A vision model
   does all three in one call and returns schema-validated JSON via
   `output_config.format`. Textract returns fields; you then write the classifier. On a
   97-product catalog that is the difference between one prompt and a parser you maintain.
3. **PDFs go in directly.** Distributor portals hand you PDFs; Claude accepts them as
   `document` blocks (base64, up to 32 MB / 600 pages) with no rasterization step. Send the
   **whole invoice as one document**, not page by page — a line table continuing across a
   page break is exactly where per-page calls drop lines.
4. **Cost is not a decision variable.** $1.64/month for one bar. The gap to Textract's ~$0.40
   is not a reason to write a classifier.
5. **High-resolution matters here specifically.** Sonnet 5 is in the 2576px tier (up to
   ~4,784 image tokens); Haiku 4.5 caps at 1568px. Invoice small print — item codes, pack
   descriptors — is exactly where that resolution earns its 3× cost.

**Configuration notes for the implementation:**

- Put every call behind one function — `extractInvoice(doc) → InvoiceExtraction` — per spec
  §188's own model-agnostic rule. Record `provider` / `model_id` / `prompt_version` on the
  job row so a provider swap is measurable, not a leap of faith.
- Use `output_config.format` with a JSON schema. Do not hand-parse.
- Run at `effort: "low"` or `"medium"`. This is structured transcription, not reasoning, and
  adaptive thinking is on by default on Sonnet 5 — it will spend tokens deliberating about an
  invoice otherwise. Size `max_tokens` to cover thinking *plus* output.
- Prompt-cache the schema/instruction block (~1,500 tokens, above Sonnet 5's 1,024-token
  minimum). Saves ~10% per page — negligible for one bar, ~$16/mo of $164 at a hundred
  tenants.

**The one real thing you give up by choosing Claude: bounding-box geometry.** Textract,
Azure and Document AI return the pixel region each field came from, which lets a review UI
highlight the source on the image as you click down the line table. That is a genuinely
better review experience and it is not available here. Mitigation: show the page image beside
the table with no highlighting in v1, and revisit if reviewing is slow in practice. It is the
strongest argument for Textract and it should be reconsidered honestly if the review queue
turns out to be the bottleneck.

## 3.3 Storage and retention

**Cloudflare R2** as primary. Reason: S3-compatible (any S3 SDK works from Node on
Hostinger), $0.015/GB-month, and **zero egress fees** — which matters because the audit
packet is a bulk-download event and Backblaze B2's free egress is capped at 3× stored bytes.
B2 is cheaper per GB ($0.006) and is the right choice for the **second copy**, where egress
never happens.

| | One bar | 100 tenants |
|---|---|---|
| Volume (3-year retention, originals + downscaled) | ~860 MB | ~86 GB |
| R2 primary | **<$0.02/mo** | **~$1.30/mo** |
| B2 offsite copy | **<$0.01/mo** | ~$0.52/mo |

**Rules:**

- **Never base64 in the database** (spec §552). `invoice` stores `storage_bucket`,
  `storage_key`, `content_sha256`, `byte_size`.
- **Signed URLs are bearer tokens.** The authorization check happens in the server action
  that *mints* the URL, not on fetch — verify `Actor.organizationId` owns the invoice before
  signing, and a cross-tenant id returns `NotFound` (invariant 9). TTL 5–15 minutes.
- **`retention_until = invoice_date + 3 years`** (spec §10 says 2 minimum, 3 safer; §564
  already commits to 3). Computed on approval. If `invoice_date` is still NULL, use
  `uploaded_at + 3 years` — the longest retention, never the shortest.
- **No delete path exists in code for invoice objects.** Not a soft-delete flag, not an
  admin action. If a bucket lifecycle rule is ever configured, set it far beyond
  `retention_until`; better, set none, because a lifecycle rule is a silent deleter that no
  code review will catch.
- **Offsite second copy** via a nightly Hostinger cron that syncs objects with
  `offsite_copied_at IS NULL`. Hostinger's daily backup covers the database; it does not cover R2,
  and spec §530's point stands — a lapsed renewal or billing dispute should not be able to
  take out a two-year legal record.

## 3.4 The review queue

Extraction is never trusted blind. §1.4(a) is the market's verdict on this and it should be
the design's premise.

**Auto-approve is gated on all four of these, and any failure routes to review:**

1. Every `line_type = 'product'` line matched via a **confirmed** `vendor_item_alias` with an
   exact `vendor_item_code` hit. Fuzzy matches never auto-approve.
2. `extraction_confidence ≥ threshold` on every numeric field on every line.
3. `pack_size` is non-NULL on every `uom = 'case'` product line.
4. **The arithmetic check:** `Σ(extended_cost) over all lines` equals the printed `total`
   within $0.02.

Check 4 is the highest-value guard in the design and it costs nothing. If the lines don't sum
to the total the model itself transcribed, something was dropped — and a dropped line is the
failure that silently *under*-costs inventory, which is worse than a visibly wrong one. It
only works because §3.1 stores header totals as printed rather than derived.

**Do not enable auto-approve at all for the first ~100 invoices.** The confidence threshold
has to be calibrated against real corrections; choosing one a priori is guessing, and the
`invoice_line_correction` table is what turns it into a measurement. This is the same
discipline as spec §7's kill-switch evidence.

**Exception typing** (§1.4(e)) — the queue shows *why*, not just *that*:

| Type | Trigger |
|---|---|
| `unmatched_product` | No alias, no confident fuzzy match |
| `price_variance` | Derived unit cost differs from `product.current_unit_cost` by more than X% |
| `total_mismatch` | Check 4 failed |
| `missing_pack_size` | Case line with no parseable pack size |
| `possible_duplicate` | Same `(org, vendor, invoice_number)` already exists |
| `unknown_line_type` | A line the model couldn't classify — deposits usually land here first |
| `vendor_unresolved` | Header vendor didn't match any `vendor` row |

**Review UI shape:** page image on the left, editable line table on the right, exception
badges at the top. Each edit writes an `invoice_line_correction` row. Approving the invoice
requires zero remaining exceptions.

**How a correction teaches the matcher — this is the whole learning loop:**

When a human assigns `product_id` to a line, upsert a `vendor_item_alias`:
- If `vendor_item_code` is present → key on `(org, vendor, code)`.
- Otherwise → key on `(org, vendor, normalized_description)`.
- Carry `pack_size` and `uom` onto the alias.

The next invoice from that vendor matches it automatically at step 1 of the ladder. No model
training, no embeddings, no retraining pipeline — a confirmed row in a table. That is what
test check 9 in §2.8 is probing for in xtraCHEF, and it is the difference between a tool that
improves and one that costs ten minutes forever.

## 3.5 Product matching

The genuinely hard part. Deterministic first, fuzzy last, human always.

**The ladder** — first hit wins, and the rung is recorded in `match_method`:

| # | Rung | Confidence | Auto-applies? |
|---|---|---|---|
| 1 | `(vendor_id, vendor_item_code)` → confirmed alias | 1.00 | Yes |
| 2 | `(vendor_id, normalized_description)` → confirmed alias | 0.95 | Yes |
| 3 | UPC printed on the line → `product_barcode` lookup | 0.90 | Yes |
| 4 | Fuzzy token score against `product.name` + `brand` + `size_ml` | computed | **No — suggestion only** |
| 5 | No match → create-draft-product path | — | **No** |

**Normalization — the `"TITOS HNDMD VDKA 750"` problem.** At 97 products, hand-curated
string normalization beats embeddings: it is debuggable, deterministic, free, and a wrong
match is traceable to a specific rule instead of a vector. Steps:

1. Uppercase, strip punctuation, collapse whitespace.
2. **Extract size tokens into a separate field before comparing names.** `750`, `750ML`,
   `1.75L`, `1L`, `12/750ML` → `{pack_size: 12, size_ml: 750}`. This is also where
   `pack_size` comes from, and it must run before name comparison or the size dominates the
   token score.
3. Expand a hand-maintained abbreviation dictionary: `VDKA→VODKA`, `HNDMD→HANDMADE`,
   `BRBN→BOURBON`, `WHSKY→WHISKEY`, `TQLA→TEQUILA`, `LTR→L`, `IMP→IMPORTED`. Grow it from
   real corrections, not from imagination.
4. Score remaining tokens (Jaccard or trigram) against candidates **filtered to matching
   `size_ml`** — a 750ml and a 1.75L handle of the same brand are different SKUs (the
   schema's own `(org, name, size_ml)` unique index says so).

**The create-draft-product path** — spec §674 names this as what keeps the catalog from
decaying, and it is the payoff for the whole feature:

- Pre-fill `name` from the normalized description, `size_ml` from the parsed size token,
  `case_size` from parsed pack size, `vendor_id` from the invoice, `category` from a
  vendor-level default.
- Set `provisional = true` and `active = true`. The product is immediately usable for
  costing and counting; the flag drives a "finish this row" nudge in the catalog screen.
- Set `current_unit_cost` from the derived per-each cost (§3.6).
- **Do not backfill `case_size` on spirits.** CLAUDE.md is explicit: NULL `case_size` on
  liquor is correct data, not missing data, and `computeLineUnits` depends on that. If a
  liquor invoice arrives billed by the case, that populates `invoice_line.pack_size` — not
  `product.case_size` — unless a human confirms the bar actually stocks it that way.
- Creating a draft product also creates the alias, so the second invoice from that vendor
  resolves at rung 1.

## 3.6 Cost flow — be precise here

The place where getting it wrong produces plausible-looking wrong numbers.

**Derivation, on approval, per product line only:**

```
if line_type != 'product'            → contributes nothing to cost. Skip. (§1.4(c))
if uom == 'each'                     → per_each = extended_cost / quantity
if uom == 'case' and pack_size != NULL → per_each = extended_cost / (quantity * pack_size)
if uom == 'case' and pack_size == NULL → DO NOT DERIVE. Route to review.
if uom == 'keg'                      → per_each = extended_cost / quantity   (a keg is one unit)
```

Three deliberate choices in that block:

- **`extended_cost / (quantity × pack_size)`, not `unit_cost / pack_size`.** The invoice's
  `unit_cost` on a case line is the *case* price, and `quantity` may be greater than one.
  Deriving from the extended amount is robust to both and to the vendor rounding the unit
  price for display.
- **NULL `pack_size` never becomes 1.** Same rule as `count_line.unit_cost_at_count`: NULL
  means "not determinable", and coercing it to a number is the exact failure the existing
  schema comments warn against. A case line with an unknown pack size is a review item, not
  a 12× cost error.
- **Deposits are excluded, always.** A keg's deposit line and its product line are separate
  invoice lines; the deposit is a refundable asset, not COGS. A returned-empty credit is
  `line_type = 'deposit_return'` on a `document_type = 'credit_memo'`.

**Write path, in one transaction per approved invoice:**

1. Insert a `product_cost_history` row per distinct product: `unit_cost = per_each`,
   `case_size = pack_size`, `effective_date = invoice.invoice_date`, `source = 'invoice'`,
   `source_invoice_line_id`, `created_by = approver`.
2. Update `product.current_unit_cost` **only if** `invoice.invoice_date >=` the
   `effective_date` of that product's current latest history row.
3. Set `invoice.status = 'approved'`, `approved_by`, `approved_at`, `retention_until`.

Step 2's condition matters and is easy to miss: **entering a three-month-old invoice late
must not reprice today's catalog backwards.** The history row is still written — you want
the price series complete — but the cache only moves forward in invoice-date order.

**Interaction with invariant 2 — closed counts are never retroactively repriced:**

Invariant 2 holds here **by construction, not by care**: nothing in the invoice system has
any write path to `count_line`. Make that a stated rule the `code-reviewer` agent checks,
not a convention — the whole point of a snapshot column is that it becomes wrong the moment
something helpful updates it.

Two specific consequences to be deliberate about:

- **Closed counts stay exactly as they are.** A count line with `unit_cost_at_count = NULL`
  (88 of the 97 seeded products have no cost today) stays NULL forever, even after the first
  invoice fills in that product's cost. That is already the documented rule in
  `db/schema.ts`; the invoice system does not get an exception to it. The "N lines counted
  but unpriced" figure on old counts is a true statement about those counts.
- **Draft counts also stay as they are.** A draft count line that snapshotted the old cost
  keeps it. Do not re-snapshot open drafts when an invoice lands mid-count — a count whose
  total shifts under the person counting it is worse than one that is slightly stale, and
  "the cost as of when this bottle was counted" is the more defensible claim.

**Price-variance alerting** (§1.4(h)) falls out for free: on derivation, compare `per_each`
against the product's current cost and raise a `price_variance` exception past a threshold.
One query over `product_cost_history` gives the trend chart every competitor ships.

## 3.7 Compliance — feeding the Audit Packet

Spec §10's one-button export, date range → ZIP. Everything it needs now exists:

| Packet contents | Source |
|---|---|
| Every invoice image/PDF in range, named `{invoice_date}_{vendor}_{invoice_number}.{ext}` | `invoice.storage_key` |
| `invoices.csv` — one row per invoice with vendor, number, date, totals, approver, approval timestamp | `invoice` + `user` |
| `invoice_lines.csv` — every line with product, quantity, unit cost, extended, line type | `invoice_line` |
| Every closed count in range as CSV | existing `count` / `count_line` |
| Monthly beginning/ending inventory value table | existing closed counts |
| `manifest.txt` — generated-at, date range, row counts, per-file SHA-256 | computed |

Three implementation notes:

- **Generate as a background job**, not in a request. A three-year range with a few hundred
  invoice images will exceed any request timeout. Same job-table + cron shape as extraction:
  write the ZIP to R2, then hand back a signed link.
- **The `approved_by` / `approved_at` trail is why those columns exist.** Spec §10 asks for
  "log who counted what and when, immutably"; the invoice half of that is who approved which
  cost. `invoice_line_correction` gives the field-level version.
- **Include the manifest hashes.** A packet you can prove wasn't edited after export is worth
  more than one you can't, and it costs a loop.

> Same caveat as spec §354: this is planning research, not legal advice. Confirm the current
> A.A.C. R19-1-501 requirements and your license series with the DLLC and your attorney.

## 3.8 Phased build order

| Phase | Contents | Effort | Ship when |
|---|---|---|---|
| **A — Archive** | Upload, R2 storage, signed URLs, `retention_until`, offsite sync, **manual line entry**. Tables: `invoice`, `invoice_line`, `product_cost_history`. **No AI at all.** | **~1.5 weeks** | **Now, regardless of the test.** Satisfies A.A.C. R19-1-501 on its own, unblocks open-item 4 (costs), and is the cheapest item on this list. |
| **B — Extraction + review** | `invoice_extraction_job`, cron worker, `extractInvoice()` behind one interface, review queue with **everything manual-confirm**, exception typing, `invoice_line_correction`. | 2–3 weeks | After the test comes back negative, or after a second organization appears. |
| **C — Matching** | `vendor_item_alias`, the ladder, normalization dictionary, create-draft-product, `product.provisional`. | 1.5–2 weeks | Immediately after B — B without C means re-matching every line by hand forever. |
| **D — Cost flow + alerts** | Derivation, `product_cost_history` writes, `current_unit_cost` cache, price-variance exceptions and trend view. | ~1 week | After C. |
| **E — Audit packet** | Background ZIP job, manifest, CSVs. | ~1 week | Spec's Phase 3. Can precede B–D if compliance pressure arrives first — Phase A's manual entry is enough to feed it. |
| **F — Auto-approve** | Confidence thresholds calibrated on ~100 invoices of real correction data. | 2–3 days | Only after B–D have run long enough to have the data. Never before. |
| **Deferred indefinitely** | Vendor EDI, three-way match, receiving, AP payment, QuickBooks/Xero sync. | — | Named so they're not rediscovered as surprises. |

**Total B through E: ~6–8 weeks of focused work.** Phase A is separable, cheap, and useful on
its own — which is why it should ship first whatever the test says.

---

## Sources

xtraCHEF: [Toast product page](https://pos.toasttab.com/products/xtrachef) ·
[G2](https://www.g2.com/products/xtrachef/reviews) ·
[independent review](https://restaurantinventorymanagementsoftware.com/solutions/xtrachef) ·
[RestaurantTools.ai](https://restauranttools.ai/tools/xtrachef) ·
[Essentials vs Pro](https://phoenixgeeks.us/about-phoenix-geeks/pg-restaurant-blog/maximizing-efficiency-with-xtrachef-essentials-vs-pro/)

Restaurant/bar tools: [MarginEdge pricing](https://www.marginedge.com/pricing/) ·
[MarginEdge review](https://restaurantinventorymanagementsoftware.com/solutions/marginedge) ·
[Backbar pricing](https://www.getbackbar.com/pricing) ·
[WISK](https://restaurantinventorymanagementsoftware.com/blog/wisk-ai-review-pricing-alternatives) ·
[BevSpot](https://www.softwareadvice.com/inventory-management/bevspot-profile/) ·
[Craftable](https://craftable.com/foodager/) ·
[Ottimate](https://restaurantinventorymanagementsoftware.com/solutions/ottimate) ·
[Restaurant365 quote range](https://factura.ai/restaurant365-review/) ·
[category comparison](https://restaurantinventorymanagementsoftware.com/category/inventory)

Horizontal AP: [invoice automation comparison](https://www.gennai.io/blog/invoice-automation-tools-comparison-2026) ·
[Ramp AP](https://ramp.com/accounts-payable) ·
[Ramp vs Bill.com](https://www.kenfromfinance.com/blog/ramp-vs-bill-com)

Workflow patterns: [EDI integration](https://fintech.com/blog/the-benefits-of-edi-integration-with-restaurant-accounting) ·
[three-way match](https://ustechautomations.com/resources/blog/automate-restaurant-supplier-invoice-three-way-match-2026) ·
[restaurant invoice management](https://invoicedataextraction.com/blog/restaurant-invoice-management)

OCR providers: [AI Multiple benchmark](https://aimultiple.com/invoice-ocr) ·
[API benchmarks](https://invoicedataextraction.com/blog/invoice-ocr-api-benchmarks) ·
[LLM vs traditional OCR](https://parsli.co/blog/llm-ocr-vs-traditional-ocr) ·
[AWS Textract pricing](https://aws.amazon.com/textract/pricing/) ·
[Azure Document Intelligence pricing](https://docuocr.com/blog/azure-document-intelligence-pricing) ·
[Google Document AI pricing](https://flowwright.com/blog/document-ai-pricing-guide) ·
[Veryfi/Mindee/Nanonets](https://www.koncile.ai/en/ocr-comparisons/nanonets-vs-mindee)

Data privacy: [Anthropic commercial terms](https://terms.law/ToS-Watchdog/ai-services/anthropic/) ·
[Anthropic retention](https://anarlog.so/blog/anthropic-data-retention-policy/) ·
[Gemini tier split](https://docs.bswen.com/blog/2026-03-23-gemini-free-tier-data-privacy/)

Claude model IDs, pricing, image-token tiers, cache minimums and structured-output config
per the `claude-api` skill (cached 2026-06-24), not from memory.

## 5.4 Spike result — real Southern Glazer's invoice, extracted in ~100 ms

Validated on 2026-08-14 against the owner's actual invoice
`Southern Glazer's Invoice-5402426.pdf` (60 KB, 1 page) using pdf-inspector v1.14.2. The
binary used was **`linux-x64-gnu` running inside `node:22-slim` via Docker** — deliberately
the same glibc/arch as the Hostinger production runtime, so this is a partial de-risk of
§5.2's spike (the standalone-packaging half remains unproven, see below).

**Classify** — `TextBased`, 1 page, confidence **1.0**, no OCR pages needed. The invoice
is a generated PDF from SGWS's Proof portal, not a scan.

**Extract** — 83ms, valid layout-aware Markdown. Tables intact, per-line items recovered:

- Header: Invoice **5402426**, dated 02/02/2026, account ID 10880.
- Totals: Gross **$483.64**, Discount **$123.78**, Net **$359.86**.
- 4 line items with pack details parsed out of the item name
  (`BLACK VELVET CANADIAN 80 984395 • 1.0L • 12 Case • SCREW CAP`), quantity, gross/discount/net.
- Title: *"Proof by Southern Glazer's"*.

**Two findings that validate the pipeline design, not just the tool:**

1. **The extraction surfaces exactly the discrepancy the review queue and arithmetic check exist for.** Header says Total Units **7**; the line items sum to **8** (1 case + 2 + 1 + 4). The last line's net cell is blank (`$168.00/$168.00/[]`). A human reviewer or the arithmetic check catches both — this real invoice is a live demo of why auto-approve stays off.
2. **This is the Proof *pre-delivery* document, not final.** The extractor captured the invoice's own disclaimer: taxes/fees included, "refer to post-delivery invoice for additional details and final pricing information." Line items carry no unit price — only gross/discount/net — so unit cost for valuation must be derived (gross ÷ qty ÷ pack), and the post-delivery invoice may differ. Worth noting in the review step.

**Parse caveats for the normalizer (all cheap):** the tax-note footnote landed inside the totals row as a stray cell; one garbage footer fragment (`ack db e Fe`); UoM mixes "Cases"/"Units" and needs the `pack_size` parser from Part 3.

**A dev-machine constraint discovered here:** pdf-inspector's optional deps only ship `darwin-arm64` — there is **no `darwin-x64` (Intel Mac) binary.** The owner's dev Mac is x86_64, so the package cannot run natively here. The npx failure was this missing optional dependency (npm optional-deps bug [npm/cli#4828](https://github.com/npm/cli/issues/4828)) compounding the absent binary. Local dev runs it via Docker (linux-x64) — the same command path the Hostinger spike will use.

**What this means:** pdf-inspector's value to Truestock is proven on the exact arch production runs, in-process, ~100 ms, free. §5.2's remaining unknown is narrowed to the `output: 'standalone'` file-tracing half of the spike; the runtime-load half has effectively passed.
