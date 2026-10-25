# Gate 1 — Product: Phase 2.5 backend follow-ons

Two related backend improvements on top of the already-shipped extraction
pipeline. Both are backend-only this round — no new screen in either.

---

## Part A — pdf-inspector selective-OCR adoption

### Problem

Right now, when a scanned or photographed invoice goes through review, the
system sends the *entire document* to an AI vision model unconditionally —
even invoices that turn out, once actually read, to be perfectly clean typed
text that never needed a photo-reading model at all. Today's classification
step only *predicts* whether a page might need OCR; nothing actually tries
reading it locally first before deciding to pay for AI vision.

That's wasted spend on every invoice classified as scanned or mixed, even
the ones that would have read out clean — and it happens silently. Nothing
on the review screen or in the invoice list today tells the owner "this one
didn't need to cost anything, but paid for AI vision anyway."

*(Corrected 2026-08-23: this problem statement originally implied per-page
billing — "only pay for the one bad page on a ten-page invoice." Researched
against pdf-inspector's actual API surface (Rust/napi/wasm/Python, via
context7) and pdf-lib's page-copy API: pdf-inspector has no function that
produces a page-scoped PDF buffer or page image, only page-scoped *markdown*
extraction — so it cannot hand a subset of a document to an external vision
model. True per-page billing would require adding a second library
(pdf-lib) to physically split the PDF; that's out of scope this round — see
`appendix-a-selective-ocr-audit.md` for the full finding. What ships instead
is described below.)*

### Success metric

**Average AI cost per scanned/mixed invoice extraction, before vs. after.**
Every extraction job already records its own cost (`extraction_job.cost_usd`
in the database — visible today, just not summarized anywhere). Take the
average `cost_usd` across scanned/mixed invoices processed in the two weeks
before this change ships, and the same average in the two weeks after.
Expect it to drop **for invoices that turn out to have zero pages actually
needing a photo read** — those now pay nothing for AI vision instead of
paying for it unconditionally. An invoice with even one genuinely bad page
still costs the same as today (a full-document AI-vision call) — this round
does not reduce that invoice's cost, only avoids paying at all on invoices
that didn't need vision in the first place.

### Announcement

Scanned and photographed invoices that turn out to be readable without AI
help now cost nothing extra to process. Behind the scenes, Truestock reads
every page it possibly can on-device first — the same way it already reads
clean typed invoices for free — and only calls out to the paid AI-vision
model when at least one page genuinely can't be read locally: a blurry scan,
a handwritten note, a low-quality fax. If every page on a scanned or
photographed invoice actually turns out to be readable on-device, the whole
invoice now processes for free instead of always paying for AI vision. An
invoice that does still have a genuinely unreadable page costs the same as
it does today. Nothing changes for the person reviewing the invoice — the
same draft line items land in the same review queue.

### Screens

No UI. This is entirely a backend processing change — the existing review
screen and its data are unaffected. Owners and managers see no new screen,
button, or field; they may notice invoices finishing review-prep faster.

---

## Part B — invoice cost-history / cost-posting backend

### Problem

Every time an invoice is approved, Truestock quietly records exactly what
changed a product's cost — old price, new price, which invoice caused it.
But that record is a dead end today: there is no way, anywhere in the app,
to ask "what has this product's cost done over time" or "what did approving
this invoice actually change downstream." The data has been captured, in
full, on every single approval since Phase 2.5 shipped — it's just unreadable
except by someone querying the database directly. That's a gap for the one
person who most needs this: the owner deciding whether a vendor's prices are
creeping up.

### Success metric

**A real, callable answer exists for both directions of the question** —
"what has this product cost, over time" and "what did this invoice's
approval change" — covered by tests that seed two approvals for the same
product and assert the returned history is correctly ordered with accurate
before/after chaining, correctly excludes another organization's history
(tenant isolation), and returns an empty list — never an error — for a
product or invoice with no cost postings yet. Because this ships with no
screen, the metric this round is that the data is *reachable and correctly
scoped through the domain layer*, ready for a screen to consume next round —
not a user-facing timing number.

### Announcement

*(Internal — no UI change yet.)* The backend can now answer "what has this
product cost over time" and "what did this invoice's approval change,"
per product or per invoice. The data was always being recorded on approval —
it just couldn't be read back. This lays the groundwork for a future
cost-history screen without touching the approval/write path or changing
anything a reviewer sees today.

### Screens

No UI, this round. Read functions only, built so a future cost-history
screen (product detail page, or an invoice's own detail page) can be wired
up as a small, mostly-presentational follow-on rather than a new backend
effort.

**Hard constraint carried into Gate 2 for this part:** invariant 8 — cost
and margin data is role-gated, staff never see it. Any new read function
here follows the existing `listInvoicesForOwner`-style split (owner-only
column set) rather than a single ungated query, the same pattern
`lib/domain/invoices.ts` already uses for `InvoiceRow` vs. its manager/staff
projection.
