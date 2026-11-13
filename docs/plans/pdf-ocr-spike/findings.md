# Spike: deterministic per-vendor OCR templates

**Status: spike. Purely additive. Nothing is wired into
`lib/domain/extraction-pipeline.ts` or any production path.** This branch is a
record of an experiment, not a feature to merge as-is. Skips the 4-gate workflow
per `docs/plans/README.md` (spike/prototype work).

**Question.** `@firecrawl/pdf-inspector`'s offline OCR returns per-page markdown.
Can a declarative per-vendor template parse that markdown into
`DraftInvoiceLine[]`, with arithmetic proving the result correct, so that Claude
Vision becomes a last resort instead of doing 100% of the scanned/mixed/photo
work?

**Answer in one paragraph.** The machinery works and fails closed on everything
it cannot prove. On the one real scanned sample it extracts every row and the
sum of the lines (deposit credit included) ties to the printed total to the
cent at 100, 150 and 200 dpi, but it does **not pass its own gate at any single
resolution**: the OCR drops a lone one-digit quantity on one or two rows, and
a different row each time. Merging three renders per field recovers all
quantities and passes the unchanged gate (scratch experiment, one sample). So a
template is viable only as a multi-pass design, and nothing here is proven on
more than one document. Treat this as a go/no-go input, not a result.

No real vendor text, names, addresses, phone numbers, item names or prices are in
the repo. Fixtures are synthetic ("Example Draft Distributing").

## What "template" means here

Not ML training. A template is a declarative, deterministic spec: structural
`detect` anchors, header regexes (invoice number, date, printed total), a record
anchor (item code plus pack token such as `1/6 Keg`) and rules that assign the
`$` amounts that follow to PRICE / NET / TOTAL. Golden fixtures plus a strict
arithmetic gate make it "expected and consistent". Automatic template induction
is out of scope.

## What was built (all new files, pure, no DB)

- `lib/domain/ocr-template/types.ts`: template shape and the `OcrTemplateResult`
  union: `ok:true` or `ok:false` with reason `no-template` / `parse-failed` /
  `gate-failed`. `ok:false` always means "escalate to Claude Vision".
- `money.ts`: strict money-token parse and integer-cents helpers (no floats).
- `normalize.ts`: markdown to one whitespace-normalised token stream. No
  character repair (no O to 0, S to $): correctness comes from the gate.
- `engine.ts`: `extractWithOcrTemplate(markdown)` runs normalise, detect, header,
  records, gate. Never throws.
- `gate.ts`: `verifyOcrExtraction(header, lines)`, stricter than the pipeline's
  `arithmeticCheck`.
- `templates/draft-distributor-scanned.ts`: the one real template.
  `templates/index.ts` is the registry.
- `tests/ocr-template.test.ts` and `tests/fixtures/ocr-template/*.md`: 40 tests,
  synthetic fixtures only.

## Why a flat token stream, not lines or cells

The OCR exposes no span coordinates, and its markdown layout is unstable across
render resolution: the same scanned page gave 22 / 19 / 6 / 17 non-empty lines at
100 / 150 / 200 / 300 dpi. The digits were stable (identical dollar-amount
multiset at every resolution tried). So a template anchors on content in the
flattened stream, never on line breaks or table cells. Per row the amounts are
assigned by value relationship (`net == qty x price`, `total >= net`; a credit row
has `total < 0` and `|total| == net`), and a row is refused unless exactly one
assignment exists.

## The gate (`gate.ts`)

`ok:true` only if all hold, in integer cents:

1. The invoice's printed total was read. (The pipeline's `arithmeticCheck` passes
   when the total is null; a template has no second opinion, so this fails.)
2. Every line has a gross amount.
3. Every line has quantity, unit cost and extended cost, and
   `qty x unit == extended` within 0.01.
4. Deposit credits are negative; product, deposit, freight, tax and fee lines are
   not.
5. The sum of gross over all lines, deposits and credits included, equals the
   printed total within 0.02 (the pipeline's `ARITHMETIC_TOLERANCE_USD`,
   duplicated locally because `extraction-pipeline.ts` imports the DB).

Deposits are typed `deposit` / `deposit_return`, counted in the sum, and never
enter product cost (AGENTS.md).

## Measured results

### Synthetic (the engine's correctness)

- 40 tests pass; `tsc` and `eslint` clean.
- Four layout variants of one invoice (mimicking the dpi-dependent line grouping)
  produce byte-identical `lines` JSON, and the variants really are different
  pages.
- A 96-case single-digit flip sweep over every amount and quantity: 86 refused;
  the 10 accepted are all a +1 cent slip in a row's TOTAL cents digit (see
  fragile point 2). The test pins that set at exactly 10.
- Gate self-mutation, each reverted afterwards: widening the sum tolerance fails
  5 tests, widening the line tolerance fails 2, disabling the missing-total check
  fails 4.

### Real scanned sample (structure only, re-run by the orchestrator)

| dpi | template | lines | gate | blocker | sum vs printed |
|---|---|---|---|---|---|
| 100 | detected | 6 | FAIL | quantity unread on 1 line | 0.00 |
| 150 | detected | 6 | FAIL | quantity unread on 1 line | 0.00 |
| 200 | detected | 6 | FAIL | quantity unread on 2 lines | 0.00 |
| 300 | detected | none | parse-failed | one item's window holds 8 amounts, expected 3 | n/a |

- Lines are not identical across dpi: three distinct line-sets at 100/150/200,
  differing only in `quantity` / `rawText` on rows whose quantity was dropped,
  plus one item description misread at 100 dpi.
- The rows, amounts and the deposit credit are right wherever lines were
  produced (the sum ties to the cent). The only blocker is a dropped lone
  one-digit quantity, on a different row each pass.
- **Scratch experiment, not in the repo:** merge the 100/150/200 results per field
  (an unread field yields to a read one; two different reads are a conflict),
  then run the unchanged gate. Result: all 6 quantities recovered, gate PASS,
  difference 0.00, one field conflict (the misread description). It triples OCR
  cost and was run on one sample.

### Real phone photo

No template is registered for it. The scanned template does detect it (same
vendor layout family) and then returns `parse-failed` at 100, 150 and 200 dpi:
the photo's reading order detaches the NET and TOTAL columns from their rows and
loses the footer total, so pairing amounts to rows would be guesswork. `ok:false`
(escalate to Claude) is the correct outcome. At 300 dpi the library itself fails
to render a photo-as-PDF: "rendered output would require 277219146 bytes,
exceeding the configured limit of 268435456 bytes".

### Text PDF (Southern Glazer's)

Gets `no-template`, correctly: it already parses natively from pdf-inspector's
tables and needs no OCR template.

## Two design decisions made after seeing real data (review these)

1. **Gate tightened, which made the real result worse.** An earlier revision
   skipped lines with an unread quantity; that passed the 150 and 200 dpi
   variants with null quantities. It now fails such a line with
   `line-arithmetic`, because "pass" must mean every line was verified. Dropped
   quantities stay `null`: never guessed as 1, never derived from `net / price`
   (circular: a misread net yields a different, plausible quantity).
2. **`detect` relaxed from 3 anchors to 2.** The `PRODUCT` heading is dropped by
   the OCR at 100 dpi, which turned a fully readable page into `no-template`.
   `detect` is not the gate.

## Escalation design

`ok:false` always means escalate to Claude Vision, never a partial answer shown
as complete.

- `no-template`: no template, or more than one, claimed the document. The normal
  path for any unknown vendor.
- `parse-failed`: a template claimed it but a row was ambiguous.
- `gate-failed`: rows were read but not provable. `lines` and `gate.failedChecks`
  come back and could seed a review UI or a targeted re-read.
- `ok:true`: skip the Vision call. Auto-approval stays off until about 100 real
  invoices (AGENTS.md); this means "no Vision call", not "no human".

In production: resolve the vendor first, run only that vendor's template, keep
`detect` as a second opinion. A vendor whose pass rate drops simply escalates.

## Fragile points

1. **A lone dropped quantity digit is invisible to the OCR and to us.** Fix
   options: multi-pass per-field consensus (measured above), or Claude.
2. **The 0.02 sum tolerance admits a +1 cent slip in a TOTAL cents digit.** That
   column is not otherwise cross-checked. Tightening to 0.00 would reject
   legitimate rounding, so it is a product decision.
3. **Anchors are one sample deep and the gate checks arithmetic only.** A misread
   description or item code passes (one did at 100 dpi); alias matching and human
   review are the only catch. `detect` is structural, so another vendor on the
   same invoicing software could be claimed and the gate is then the only guard.

## NOT proven

- Any real invoice passing the gate at a single resolution.
- More than one scanned sample for the vendor: every pattern describes one
  document. Need at least 3-5 per vendor, across dates, before trusting anchors.
- A mixed text/scan PDF (no sample exists).
- The phone photo (not templatable on current evidence).
- Descriptions and codes (the gate is arithmetic).
- The Hostinger runtime: the OCR needs PDFium, ONNX Runtime 1.27.0 and a 31 MB
  PP-OCRv6-small model provisioned offline, plus memory and a writable model
  cache. Not verified. Note that the shipped image has never actually run the
  library OCR: PDFium is missing there, so the existing selective-OCR step falls
  back to Claude, and Claude does 100% of scanned/mixed work today.
- The multi-pass consensus: it exists only as throwaway scratch code on one
  sample.

## Adding a vendor template (procedure)

1. Collect at least 3 real invoices from the vendor, ideally across dates. Keep
   them read-only and outside the repo.
2. Run `processPdfWithOcr` on each at 3 dpi values (for example 100, 150, 200).
   Avoid 300 dpi for photos (render memory limit).
3. Normalise with `normalizeOcrText` and author anchors against the normalised
   stream: 2-3 structural `detect` anchors that survive every dpi, a record
   anchor (code, description, pack token), a quantity rule, header regexes and a
   footer label. Build regexes with `new RegExp(String.raw...)`.
4. Write synthetic golden fixtures: invent every name, code and price; copy only
   structure and OCR quirks. Make 4 layout variants of one invoice with
   hand-written expected lines.
5. Replay the real files with a structure-only script (counts, booleans, line
   types, failed check names, never values). Require per dpi: template detected,
   gate verdict, and whether `lines` is byte-identical across dpi.
6. Add mutation tests (flipped digit, missing total, dropped quantity) and run the
   gate self-mutation check: weaken a check, confirm the matching test fails,
   restore.
7. Register in `templates/index.ts` only if step 5 shows the gate passing. If the
   reading order detaches amounts from rows (the photo), register nothing and let
   it escalate.

## Recommendation

Do not wire this yet.

1. Wait for more real samples per vendor; the single sample cannot tell
   generalisation from overfitting.
2. Before any more template work, answer the runtime question: can the OCR
   runtime be provisioned on Hostinger within its memory and time limits? If not,
   everything above is moot.
3. If both are yes, promote the multi-pass consensus from scratch into the module
   (it triples OCR cost: roughly 3 x 3-4 s per page), keep the gate unchanged,
   and run it shadow-mode beside Claude Vision to measure agreement before it is
   allowed to skip a Vision call.
4. A cheaper, lower-risk use of the same OCR, not tested here: keep Claude as the
   extractor but cross-check its amounts against the OCR digits (stable across
   dpi). That removes the main silent-error risk without replacing Claude.
