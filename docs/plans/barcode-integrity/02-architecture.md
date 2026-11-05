# Gate 2 — Architecture: barcode integrity

Read against the code at `b3df49d` + `d637cbb` (2026-11-05). Gate 1:
`01-product.md`. Decisions referenced as "Gate 1 #n" are that doc's
"Decisions for the owner".

**Headline: no schema change, no new endpoint, no new table.** The
`product_barcode.format` column already exists (`varchar(20)`, nullable, never
written today) and `barcode` is `varchar(64)`, which holds a 14-digit string.
The migration chain stays `0000 → 0003`, so this feature adds nothing to the
go-live migration list.

---

## Fit — what this touches

| Module | Today | Change |
|---|---|---|
| **New: a pure barcode module** | — | One self-contained function that turns *(what the camera read, what kind it said it was)* into *(the standard form to store and look up, the kind to record)*. No database, no DOM, no imports from the app. Tested the way `lib/rescan-guard.ts` is: every rule is a table row, no camera. |
| `lib/domain/catalog.ts` | Six places put a raw barcode string into a query or an insert: `resolveBarcode`, `resolveBarcodeForCount`, the insert in `linkBarcodeToProduct` and its "who already has it" lookup, the insert in `createProduct` and its "who already has it" lookup | **All six call the normalizer first.** This is the one choke point: every barcode read or write in the app goes through these functions, including the scan path in `lib/domain/counts.ts` (`scanCountLine` → `resolveBarcodeForCount`) and writes replayed from a phone's offline queue. Both "who already has it" lookups also select the owner's **size and unit type** (Fix 4). |
| `lib/validation/catalog.ts`, `lib/validation/counts.ts` | `linkBarcodeSchema` and `productBarcodeInputSchema` already accept an optional `format`; `resolveBarcodeSchema` and `scanCountLineSchema` do not | Add the same optional `format` to the two that lack it. Validation does **not** normalize — the domain does, so no caller can skip it. |
| `app/actions/catalog.ts`, `app/actions/counts.ts` | Thin: authorize, parse, call domain | Unchanged in shape. `format` passes through with the rest of the parsed input. Authorization unchanged. |
| `components/count/barcode-scanner.tsx` | Detector results carry `format`; the component reads only `rawValue` | `onDetected(barcode)` becomes `onDetected(barcode, format)`. The rescan guard still keys on `rawValue` alone — it decides *whether a frame counts*, not what the code means, so it is untouched. |
| `components/count/count-leg.tsx` | `onBarcode(barcode)` → resolve, rapid scan, or enroll | Carries `format` into `resolveBarcodeAction`, the rapid-scan write payload (and therefore its offline-queue record), and `EnrollForm`. |
| `components/count/enroll-form.tsx` | Search → **one tap links**. Create form defaults a size. | Fix 2: a confirm step between pick and link (size as the largest text; the beer bottle-or-case question moves onto it), "It's a different size" opening the create form with name/category prefilled and **no size preselected**. Fix 4's "Count Smirnoff 750 ml" button. Sends `format` on link and create. |

Not touched: no conversion script (owner decision, see Data); `db/schema.ts`, `drizzle/`, `lib/count-queue.ts` (the queue stores
whatever payload it is given; it gains a `format` field without code changes),
`lib/rescan-guard.ts`, every back-office screen, authz.

---

## The standard form — rules (Gate 1 #1 and #3)

Applied by the pure module, in this order. "Valid" means the GS1 check digit
is correct.

| Input | Condition | Stored `barcode` | Stored `format` |
|---|---|---|---|
| digits only, length 12, 13 or 14 | valid | left-padded with zeros to **14** | as reported |
| digits only, length 8 | `format = upc_e`, valid | **expanded to its 12-digit UPC-A**, then padded to 14 | `upc_e` |
| digits only, length 8 | `format = ean_8`, valid | padded to 14 | `ean_8` |
| digits only, length 8 | format missing or anything else | **as read** — never guessed (Gate 1 #1) | as reported, or null |
| digits only, any length | check digit invalid | as read | as reported |
| digits only, other lengths (e.g. 6, 10) | — | as read | as reported |
| anything containing a non-digit (Code 128 `X004YKHTYX`, Code 39) | — | as read, trimmed only (Code 128 is case-sensitive) | as reported |

`format` is stored only if it is one of the detector's known names
(`upc_a`, `upc_e`, `ean_13`, `ean_8`, `code_128`, `code_39`, …); anything else
becomes null rather than a free-text value from a client.

**Why "valid check digit" gates everything:** the normalizer's only danger is
merging two *different* codes into one. A valid GS1 check digit is what proves
a string is the code it appears to be; without it, leaving the string alone is
the safe direction (at worst the app asks "which bottle is this?" again).

**Worked example (verified, see 00-status.md):** `082000000013` (UPC-A),
`0082000000013` (EAN-13) and `08200103` + `upc_e` all store as
`00082000000013`.

---

## Endpoints

**None new.** Next.js server actions, all existing:

| Action | Change |
|---|---|
| `resolveBarcodeAction` | accepts optional `format` |
| `scanCountLineAction` | accepts optional `format` |
| `linkBarcodeToProductAction` | already accepts `format`; now stored. Conflict message names size |
| `createProductAction` | `barcode.format` already accepted; now stored. Conflict message names size |

A write queued **before** this ships has no `format`. That is safe by the rules
above: 12/13/14-digit codes normalize without it, and an 8-digit code without a
format is used as read — which is exactly how it was stored before.

---

## Data

**No table or column changes.** Query shapes stay identical; only the string
bound into them changes.

- **Lookup** (`resolveBarcode`, `resolveBarcodeForCount`): `WHERE
  organization_id = ? AND barcode = ?` with the *standard* form. Still served
  by the `product_barcode_organization_barcode_unique` index.
- **Insert** (`linkBarcodeToProduct`, `createProduct`): writes the standard
  form and the recorded format. The same unique index now refuses every
  written form of one code, not only identical text — the database, not app
  code, is what enforces "one barcode, one product".
- **Conflict lookup** (both inserts, on a duplicate-key error): the existing
  `product_barcode ⋈ product` lookup adds `product.size_ml` and
  `product.unit_type` to its select, so the message reads
  *"…already belongs to Smirnoff 750 ml"* (or *"…keg"* for a keg).

**No conversion of existing rows — dropped by the owner 2026-11-05**, because
there is no production database yet, so every production barcode will be
written by the new code. This supersedes Gate 1 #4.

What that leaves on the owner's **local Docker database**: rows enrolled before
this ships stay exactly as they were scanned. A 12- or 13-digit row **no longer
resolves**, because lookups now use the 14-digit form. Scanning that bottle
opens "Which bottle is this?" again; linking it to the same product succeeds
and adds a second, standard-form row beside the stale raw one. Harmless for
counting, but untidy. **Recommended: `bun run
docker:reset` once this ships**, which the phone-count protocol already uses
between runs. Production is unaffected.

---

## Flow — main paths

**1. Scan a bottle already in the catalog (one-shot mode).**
camera → detector `{rawValue, format}` → `BarcodeScanner.onDetected(raw, format)`
→ `CountLeg.onBarcode` → `resolveBarcodeAction({barcode: raw, format})` →
`requireRole` → `resolveBarcode` → **normalize** → indexed lookup → product →
entry screen. *A bottle read as EAN-13 that was enrolled as UPC-A now lands
here instead of on "Which bottle is this?".*

**2. Rapid scan.** Same as 1, then `runWrite("scan", {countId, barcode: raw,
format, locationId, qty})` → queued in IndexedDB → `scanCountLineAction` →
`scanCountLine` → `resolveBarcodeForCount` → **normalize** → increment.

**3. Unknown barcode → link to an existing product (Fix 2).**
resolve returns null → `EnrollForm(barcode, format)` → search → pick →
**confirm screen** (size large; beer asks bottle/case here) → "Link and count" →
`linkBarcodeToProductAction({productId, barcode, format, packLevel})` →
`linkBarcodeToProduct` → ownership check → **normalize** → insert →
entry screen for that product.

**4. "It's a different size."** confirm screen → create form, name + category
prefilled from the picked product, no size selected → pick size → 
`createProductAction({…, barcode: {barcode, format, packLevel}})` →
`createProduct` → **normalize** → insert product + barcode → entry screen.

**5. Already assigned (Fix 4).** insert in 3 or 4 hits the unique index →
lookup names owner + size → `ConflictError` → message shown. **"Count
Smirnoff 750 ml"** calls `resolveBarcodeAction({barcode, format})` again — with
normalization this finds the owning product — and opens its entry screen.
This deliberately avoids widening `ActionResult`'s error shape to carry a
product id: the client already has the barcode, and resolving it is one
indexed read.

---

## External

**None.** No third-party API, no environment variables, no new dependency. The
GS1 check-digit and UPC-E expansion rules are public, fixed algorithms
implemented in the pure module; the detector's format names come from the
`barcode-detector` package already installed (its `DetectedBarcode.format`).

---

## Risks at this level

1. **A normalizer bug merges two products' barcodes.** Mitigated by the
   valid-check-digit gate and by table-driven tests that include near-misses
   (one wrong digit, wrong length, letters). The worst failure *after* the gate
   is a re-ask, never a merge.
2. **Existing local rows are not converted** (owner decision). They stop
   resolving once the new code runs; see Data. Local only — reset the Docker
   database after this ships. Production has no rows to convert.
3. **Detectors may disagree on UPC-E.** ZXing (the polyfill this handset uses)
   reports UPC-E as 8 digits; a native detector might expand it itself. Both
   end in the same standard form under the rules above, which is the point —
   but only a phone can confirm which one a given handset does. Phase 2.9's
   enrolment walk is where that gets observed.
