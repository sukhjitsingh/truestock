# Vendor template — Southern Glazer's Wine & Spirits

What this vendor's invoices actually look like after `pdf-inspector` turns them into
Markdown, hand-verified against `parseLinesFromMarkdown`
(`lib/domain/extraction-pipeline.ts`), so a future invoice from this vendor — or one
shaped like it — maps automatically instead of re-deriving this from scratch.

This is a **template in the literal sense**: the field mapping below is what the
pipeline should already do correctly for this vendor once items #37/#38 close (see
"Where this is implemented" below), and it is the reference to check a new SGWS
invoice against if extraction ever looks wrong for one.

## 1. Format: a portal export, not a printed invoice

Southern Glazer's invoices arrive as an **"Order History" export from SGWS's Proof
portal** (title on the document itself: *"Proof by Southern Glazer's"*) — generated
directly to PDF from the portal's own order-history view, not scanned or laid out by
a traditional invoicing system. `pdf-inspector` classifies it `TextBased` at
confidence 1.0: it has a full, clean text layer, no OCR pages needed.

That matters because the pipeline's `parseLinesFromMarkdown` was written against the
**traditional printed-invoice shape** — a document header block, a single line-item
table with columns like `Ship Quantity` / `Unit Price` / `Extension` / `Item Number`,
and a totals block near the bottom, all recognized today by the header-pattern
allowlists inside `columnIndex(...)` calls in that function. Southern Glazer's export
is a different shape entirely: a metadata table, a separate totals table, and a
line-item table under its own labeled section — three distinct tables, none of which
use the traditional column names. Treating it as "the same invoice format, just from
a different vendor" is exactly how item #37 happened: the description-column
allowlist didn't include this vendor's actual header, so its table was silently
skipped.

## 2. The exact tables and headers, verbatim

Three tables, plus one standalone field that lives in neither.

**Metadata table** (near the top):

| Document Date | Account ID | Address |
|---|---|---|

**Totals table** (separate from the metadata table and from the line-item table):

| Total Cases | Total Units | Gross Total | Discount Total | Net Total |
|---|---|---|---|---|

**Line-item table**, under a line reading `# Associated Items` (not a table header —
a plain heading line immediately preceding the table):

| Item Name | Quantity | Gross Amount | Discount Amount | Net Amount |
|---|---|---|---|---|

**Invoice number** is none of the above — it appears as standalone bold text
elsewhere in the document, not inside any table:

```
**Invoice Number: 9000001**
```

(`9000001` is a fabricated invoice number — the same one used in
`SOUTHERN_GLAZERS_SYNTHETIC_MARKDOWN`, `tests/extraction-pipeline.test.ts`. Every
example value in this document, including this one, is fabricated; see §6 for why
no real invoice figures are reproduced here.)

## 3. Field mapping

| Southern Glazer's column | `DraftInvoiceLine` field(s) | How |
|---|---|---|
| `Item Name` | `description` (verbatim) + `vendorItemCode`, `packSize`, `packDescription` | `description` keeps the **full compound string**, always, so `desc:` alias keys and the size warning do not change. A cell looks like `SAMPLE VODKA 80 111111 • 1.0L • 12 Case • SCREW CAP` (fabricated — see §6): name and item code, size, case pack, and (optionally) closure, bullet-separated (`•`). `lib/invoice-item-name.ts` reads three things from it, and only from a cell that contains a `•`: the **item code** (last token of the first segment, all digits: 5 or more, or exactly 4 straight after a 2-3 digit proof, as in `80 1234` — so a proof such as `80` or a lone 4-digit vintage is never a code) into `vendorItemCode`; the **case pack** (a whole segment `<n> Case`) into `packSize`; the **size** (a whole segment naming one volume, `1.75L`, `750ML`, `750 ml`, `1.0L`) into `packDescription` as `12/1.0L`. `packDescription` is set only when both a pack and a size were read — a size alone is never turned into `n/size`; the size warning still reads it from `description`. Two pack segments or two volumes are ambiguous and read as nothing. A real column value (or one the model supplied) is never overwritten, field by field. Applied on both the markdown and the Vision path. The reviewer still confirms the prefilled pack size; `product.case_size` is not used, and `each`/`keg` lines stay at effective pack 1. |
| `Quantity` | `quantity` + `uom` | A **compound cell** — `1 Cases`, `2 Units` — not a bare number. Needs a dedicated parser that splits the numeral from the unit word before either reaches `DraftInvoiceLine`; the unit word then normalizes through the same case/each vocabulary `inferUom` already uses elsewhere in this file (`cases` → `case`, `units` → `each`). |
| `Gross Amount` | `rawGross` | Direct — already its own column, no parsing beyond the shared printed-number cleanup (`parsePrintedNumber`). |
| `Discount Amount` | `rawDiscount` | Direct, same as above. |
| `Net Amount` | `rawNet` | Direct, same as above. A row can reach the parser with this cell **blank**, but that is usually a shifted row, not a missing net: see §5a. Otherwise treat a missing net amount as `null`, not `0`, per this file's existing "don't coerce an unknown into a plausible number" rule. |
| `Document Date` | header `invoiceDate` | Table-header lookup, same mechanism `findMarkdownTableValue` already uses for `invoiceDate`/`invoiceNumber` — needs `Document Date` added to whatever pattern list feeds that lookup for this table. |
| `Account ID` | *(not currently mapped to any `invoice`/`invoice_line` column)* | Recorded here for completeness; nothing in the current schema stores a vendor account id. Not a gap this template is asking to be closed — just documenting that the field exists in the source and is presently discarded. |
| `Gross Total` / `Discount Total` / `Net Total` | header `totalGross` / `totalDiscount` / `totalNet` | Table-header lookup (see §4 quirk below for why this must be table-scoped rather than the document-wide label search `findLabeledAmount` does today). |
| `**Invoice Number: N**` | header `invoiceNumber` | Not a table value — needs the existing labeled-text extraction (`findLabeledText`, the same mechanism already used as a fallback when no table carries `invoice number`) to match `Invoice Number:` specifically, since there is no table column to look it up by header. |

## 4. What this vendor's format never provides as its own column — do not invent it

Southern Glazer's line-item table has exactly five columns, and none of the
following exist anywhere in the document:

- **No separate Unit Price column.** Only gross/discount/net amounts are printed
  per line — this is stated on the document itself as a Proof *pre-delivery*
  disclaimer ("refer to post-delivery invoice for additional details and final
  pricing information"). A unit cost is still not derived at extraction (the
  pipeline leaves `unitCost` null); posting derives it later from net ÷ quantity ÷
  the confirmed pack size.
- **No Item Number / SKU column, and no pack column.** The item code, case pack and
  bottle size exist only inside the compound `Item Name` string (`111111`, `12 Case`
  and `1.0L` in the fabricated example above), not as their own cells. They are read
  from it by the rule in §3, with the bullet and whole-segment guards that make a
  miss read as blank rather than as a guess.
- **No UOM column separate from Quantity.** The unit is inside the `Quantity` cell
  itself (`1 Cases`), not a sibling column.
- **No Brand column.**

Consequently, for every line item from this vendor `unitCost` and `extendedCost` are
correctly `null`. `vendorItemCode`, `packSize` and `packDescription` are filled
from `Item Name` when it has the bullet shape and are `null` when it does not;
the reviewer confirms them. Nothing is guessed from a cell that lacks the shape.

## 5. A known data-quality quirk: the polluted totals-table cell

The totals table's **first data cell is not reliably parseable.** The document
concatenates a legal/tax footnote directly onto the `Total Cases` number in that
cell — the spike behind this document observed a stray footnote fragment landing
inside the totals row this way. Do not build anything that depends on parsing
`Total Cases` out of that cell; treat it as unreliable by design, not as a bug to
fix in the parser.

**`Gross Total`, `Discount Total`, and `Net Total`, by contrast, parse cleanly** —
they are separate cells in the same row, untouched by the footnote pollution. This
is also the concrete reason the totals lookup for this vendor needs to be
**table-and-column-aware** (read the `Gross Total` column specifically) rather than
a document-wide "find a number near the word 'total'" search: a label search over
the whole flattened document text has no way to distinguish the clean `Gross Total`
cell from the polluted cell sitting one column over in the same row.

`Total Units` is a separate, clean column and does not share this problem. It
counts only lines sold as units; `Total Cases` counts lines sold as cases. An
earlier version of this document said `Total Units` disagreed with the line items.
Corrected 2026-11-07: that compared it against the sum of every line, cases
included. Compared against the unit lines alone, it matches.

## 5a. A blank discount shifts the net into the discount column

When a line has no discount, the PDF prints that cell empty, and `pdf-inspector`
closes the gap. The row reaches the parser as gross, then the net sitting in the
`Discount Amount` column, then a blank `Net Amount`. Corrected 2026-11-07: this
document used to call that a genuinely blank net. The owner confirmed against the
printed invoice that the discount was the blank cell and the net equalled the gross.

The row alone cannot show this, because it looks the same as a full discount with
no net printed. The invoice's printed totals can, so `repairShiftedNetCells` moves
the value back only when `Discount Total` and `Net Total` both balance afterwards.
If they do not, the line stays as read and is flagged `doesn't add up`.

## 6. The real invoice this was verified against — structure only, no real figures

`docs/invoice-automation-research.md` §5.4 records the spike this document
formalizes — validated 2026-08-14 against a real owner-provided Southern Glazer's
invoice PDF (60 KB, 1 page, extracted in ~83ms via pdf-inspector v1.14.2).

The real invoice's number, account ID, dollar totals, and product/SKU are
deliberately **not reproduced here** (or anywhere else in this document — every
example value in §2/§3/§4 above is fabricated, matching
`SOUTHERN_GLAZERS_SYNTHETIC_MARKDOWN` in `tests/extraction-pipeline.test.ts`).
The reasoning in open-items.md #36 that keeps the source PDF out of git history
applies just as much to this file: this document *is* committed, so transcribing
the real figures into prose here would reintroduce the exact problem the
`.gitignore` rule below exists to prevent, just through a different file type.

What matters for engineering purposes is the *shape* the real invoice proved out,
which is what's recorded here instead:

- One page, exactly the three-table-plus-standalone-field structure in §2 — no
  additional tables, no additional format variation.
- The totals table counts case lines and unit lines separately (§5).
- One line had no discount, and its net reached the parser in the discount column
  (§5a).
- The compound `Item Name` cell shape described in §2/§3/§4 (product name and
  embedded SKU, then size / case pack / closure type, bullet-separated) is
  exactly what the real invoice printed, character for character in form if not
  in content.

The PDF itself is **never committed** — see open-items.md #36 and the `.gitignore`
rule (`tests/*.pdf`) added alongside this document. Any future work against a real
SGWS invoice should continue producing (or extending) a **synthetic** markdown
fixture shaped like §2 above — never commit the source PDF, and never transcribe
its real invoice number, account ID, totals, or product/SKU into a doc, however
useful it might seem for a future reader to see "real" numbers.

## 7. Where this is implemented

Being built in `lib/domain/extraction-pipeline.ts` alongside this document (parallel
work — see open-items.md #37/#38), extending mechanisms that already exist in that
file rather than introducing a parallel code path:

- **A shared header-pattern constant** for the description column, so `Item Name`
  is recognized as a `description` column. This should be a genuinely **shared**
  constant rather than another copy: as of this writing, `parseLinesFromMarkdown`'s
  own description-column allowlist and `countMarkdownTableDataRows`'s
  cross-check allowlist are already two separately-maintained lists that have
  already drifted from each other (the cross-check list recognizes `/^item$/`,
  the extraction list does not) — exactly the kind of split item #37 warns about,
  where a table can match one check and silently miss the other. Adding `Item
  Name` to only one of the two would reproduce that bug in miniature.
- **A compound-quantity-cell parser**, distinct from today's `quantityIndex` /
  `uomIndex` pair (which assumes quantity and unit are printed in separate
  columns — true for the traditional layout, false here). Splits a cell like
  `1 Cases` into a numeral and a unit token, then normalizes the unit token
  through the same case/each vocabulary `inferUom` already uses.
- **A table-aware totals lookup**, extending `findMarkdownTableValue` (already
  table-header-aware, currently used only for `invoiceDate`/`invoiceNumber`) to
  also resolve `Gross Total` / `Discount Total` / `Net Total` by column header —
  rather than `findLabeledAmount`'s current whole-document label search, which
  §5 above explains cannot safely be used against this vendor's polluted totals
  row.

Exact function/constant names may differ from the descriptions above by the time
this parallel work lands — this section describes the mechanism and its
responsibility, not a promise of a specific identifier. If a name here doesn't
match, search `lib/domain/extraction-pipeline.ts` for the responsibility described,
not the literal name.

## 8. Where this is proven

New tests in `tests/extraction-pipeline.test.ts`, alongside this same parallel work
— expected inside or near the existing `describe("parseLinesFromMarkdown", ...)`
block, against a **synthetic** Markdown fixture shaped exactly like §2 above (per
open-items.md #36's own suggested fix: extract the table *structure*, not the real
vendor data, into a test fixture). At minimum this should assert: `Item Name` is
recognized as the description column and kept as the full compound string; a
`Quantity` cell like `1 Cases` splits into `quantity: "1"` / `uom: "case"`;
`Gross Total` / `Discount Total` / `Net Total` are read from the totals table by
column header even when the adjacent `Total Cases` cell is polluted with a
footnote fragment; `unitCost` / `extendedCost` come back `null` for every line, per
§4; and `vendorItemCode` / `packSize` / `packDescription` are read from `Item Name`
by the §3 rule (`tests/invoice-item-name.test.ts` covers each rule).

## 9. Related open items

- **#34** (`mixed` classification has no DB-backed regression test) — not specific
  to this vendor. Southern Glazer's classifies `text`, not `mixed` (§1), so this
  vendor's invoices never exercise the code path #34 is about. Recorded here only
  because it surfaced in the same 2026-08-16 verification session as #36–#38.
- **#35** (`parseDateValue`'s US-date regex has no month/day bounds check) —
  directly relevant: `Document Date` (§2/§3) is a US-format date
  (e.g. `03/15/2026`, the fabricated example date used in
  `SOUTHERN_GLAZERS_SYNTHETIC_MARKDOWN`) and goes through exactly this function. A garbled or
  OCR-style-misread date on a future Southern Glazer's invoice would silently
  roll over into a wrong `retentionUntil` rather than failing safely, per #35's
  own description.
- **#36** (the real SGWS invoice used to build this was untracked, not
  gitignored) — addressed alongside this document: `.gitignore` now carries a
  `tests/*.pdf` rule (see §6), and this document is the "extract the specific
  table structure into a fixture" half of #36's suggested fix.
- **#37** (`parseLinesFromMarkdown` doesn't recognize `Item Name` as a
  description-column header) — this is the finding this entire document exists
  to close out. §7 names the fix.
- **#38** (a stray non-directory file at `var/invoices/{orgId}` throws a raw
  `EEXIST`) — found during the same E2E verification run against this vendor's
  real PDF, but not specific to its data; an environment/deployment issue.
  `writeInvoiceFile` (`lib/storage/invoice-files.ts`) now catches `EEXIST` and
  throws a message naming the offending path, with a regression test in
  `tests/invoice-storage.test.ts`.
