# Gate 3 — Program Design: barcode integrity

Signatures only — no implementation bodies. Gates 1 and 2 approved 2026-11-05.

**Correction to Gate 2, recorded rather than rewritten:** Gate 2 said
`product_barcode.format` is "never written today". The domain code *does*
write it (`linkBarcodeToProduct` and `createProduct` pass `format` through);
**no client ever sends one**, so in practice every row has `format = NULL`.
The design is unchanged by this.

---

## Files

| File | New/changed | Why it lives there |
|---|---|---|
| `lib/barcode.ts` | **new** | The self-contained normalizer (owner requirement). Pure: no imports from `@/db`, `@/lib/domain`, React or the DOM — the same shape as `lib/rescan-guard.ts`, so the rules are tested without a camera or database. |
| `lib/bottle-sizes.ts` | changed | Gains `formatProductSize` and `kegGallons`; preset lists become `{ ml, nickname? }` with `label` derived from `formatProductSize`. AGENTS.md makes this file "the single definition of what a size is"; the confirm screen (client) and the conflict message (server) must print a size identically, so the formatter cannot live in either. |
| `lib/validation/catalog.ts` | changed | `resolveBarcodeSchema` gains optional `format`. `linkBarcodeSchema` and `productBarcodeInputSchema` already have it. |
| `lib/validation/counts.ts` | changed | `scanCountLineSchema` gains optional `format`. |
| `lib/domain/catalog.ts` | changed | All six barcode touchpoints normalize first. The two duplicated "who already has it" lookups collapse into one private helper that also selects size and unit type. |
| `lib/domain/counts.ts` | changed | `scanCountLine` passes `input.format` to `resolveBarcodeForCount`. One line. |
| `app/actions/catalog.ts` | changed | `resolveBarcodeAction` passes `parsed.format` to the domain. Authorization untouched. |
| `app/actions/counts.ts` | unchanged | `scanCountLineAction` already passes the whole parsed input through. |
| `components/count/barcode-scanner.tsx` | changed | `DetectorLike` result type gains `format`; `onDetected` is called with it. The rescan guard still receives `rawValue` only. |
| `components/count/count-leg.tsx` | changed | Carries `format` through `onBarcode`, the rapid-scan payload (so also the offline queue record) and the `enroll` phase. |
| `components/count/count-line-card.tsx`, `components/count/catalog-search.tsx`, `components/office/catalog-table.tsx` | changed | Print sizes with `formatProductSize` instead of their own `${sizeMl}ml` (owner: one spelling everywhere). `count-leg.tsx` and `enroll-form.tsx` get the same change alongside their other edits. |
| `components/count/enroll-form.tsx` | changed | Fix 2 (confirm step, "It's a different size"), Fix 4's "Count …" button, and `format` on both writes. |
| `lib/barcode-reader.ts` | **new** (owner, slice 1) | `chooseBarcodeReader`, the format lists and `ZXING_WASM_PATH`. Pure, so the built-in-vs-app-reader rule is tested without a phone. |
| `scripts/copy-zxing-wasm.mjs` | **new** (owner, slice 1) | Copies the app reader's engine into `public/zxing/` on every `dev`/`build`; guarded `main()`. |
| `package.json`, `.gitignore`, `middleware.ts`, `components/count/preflight.tsx` | changed (slice 1) | Run the copy before `dev`/`build`; ignore the copied file; make the CSP comment true; preflight names the reader. |
| `tests/barcode-reader.test.ts` | **new** (slice 1) | The reader rule, and the copied engine against the package's published SHA-256. |
| `scripts/lib/fake-barcode-camera.mjs` | **new** (slice 1) | EAN-13/UPC-A/UPC-E → `.y4m` for Chromium's fake camera. |
| `tests/barcode-normalize.test.ts` | **new** | Table-driven tests of the pure module. |
| `tests/bottle-sizes.test.ts` | changed | `formatProductSize` cases. |
| `tests/catalog-write-path.test.ts` | changed | A new `describe` block: the bug, reproduced against a real database, then fixed. |
| `scripts/verify-browser.mjs` | changed (see Least confident #6) | Browser checks for the confirm and different-size screens. |

**Not changed:** `db/schema.ts`, `drizzle/`, `lib/count-queue.ts`,
`lib/rescan-guard.ts`, `lib/action-result.ts`, `lib/domain/errors.ts`, and no
back-office file beyond the catalog table's size cell and the shared size
dropdown labels.

---

## One size spelling, everywhere (owner, 2026-11-05)

Today six components each format a size themselves with `` `${sizeMl}ml` ``
(kegs print just `Keg`), and the preset lists carry hand-written labels such as
`19533 ml (sixtel)`. All of them move onto `formatProductSize`:

| Where | File:line today | Today | After |
|---|---|---|---|
| Back-office catalog table | `components/office/catalog-table.tsx:424` | `1750ml` / `Keg` | `1.75 L` / `Sixtel keg` |
| Phone entry screen header | `components/count/count-leg.tsx:643` | same | same as above |
| Phone stray-bottle search | `components/count/count-leg.tsx:895` | same | same |
| Phone catalog search | `components/count/catalog-search.tsx:75` | same | same |
| Phone count-line card | `components/count/count-line-card.tsx:83` | same | same |
| Phone link search results | `components/count/enroll-form.tsx:303` | same | same |
| Size dropdowns (phone create form, back-office product form) | `lib/bottle-sizes.ts` preset `label`s | `1.75 L (handle)`, `19533 ml (sixtel)` | size text from `formatProductSize`, then the nickname in brackets: `1.75 L (handle)`, `355 ml (12 oz)`, `Sixtel keg (5.16 gal)` |

The preset lists change shape from hand-written labels to `{ ml, nickname? }`,
with `label` derived once at module load — so the dropdown and every other
screen cannot disagree. Nicknames stay because they help someone *pick*
("handle", "tallboy", "magnum"); they are never shown outside a dropdown.
Kegs' nickname is the gallon figure from `kegGallons`.

---

## Types & signatures

### `lib/barcode.ts` (new, pure)

```ts
/** The symbologies the scanner asks the detector for. Anything else a client
 *  sends as a format is stored as null, never as free text. */
export const SCANNED_BARCODE_FORMATS = [
  "upc_a", "upc_e", "ean_13", "ean_8", "code_128", "code_39",
] as const;
export type ScannedBarcodeFormat = (typeof SCANNED_BARCODE_FORMATS)[number];

export interface NormalizedBarcode {
  /** What is stored and looked up. 14 digits for a valid GS1 retail code;
   *  otherwise the input, trimmed, exactly as read. */
  barcode: string;
  /** What the camera said it read, if it is a known name; otherwise null. */
  format: ScannedBarcodeFormat | null;
}

/** The one rule-set. Total: never throws, for any input. Idempotent:
 *  normalizeBarcode(normalizeBarcode(x, f).barcode, f) deep-equals the first
 *  result. */
export function normalizeBarcode(raw: string, format?: string | null): NormalizedBarcode;

// Internal, not exported — tested only through normalizeBarcode:
function isValidGs1(digits: string): boolean;          // GS1 mod-10 check digit
function expandUpcE(eightDigits: string): string | null; // → 12-digit UPC-A, or null if not expandable
function toKnownFormat(format?: string | null): ScannedBarcodeFormat | null;
```

### `lib/bottle-sizes.ts` (added)

```ts
/** One spelling of a product's size, used by both the confirm screen and the
 *  "already belongs to" message. Decided by the owner 2026-11-05:
 *    bottle/can < 1000 ml  → "750 ml"
 *    bottle/can ≥ 1000 ml  → litres, trailing zeros dropped: "1 L", "1.5 L", "1.75 L"
 *    keg 19533             → "Sixtel keg"
 *    keg 29337             → "Quarter barrel keg"
 *    keg 58674             → "Half barrel keg"
 *    any other keg         → litres + " keg": "50 L keg"            */
export function formatProductSize(p: {
  unitType: "bottle" | "can" | "keg";
  sizeMl: number;
}): string;

/** Secondary line under a keg's size on the confirm screen: "5.16 gal".
 *  Null for anything that is not one of the three named keg sizes. */
export function kegGallons(p: { unitType: "bottle" | "can" | "keg"; sizeMl: number }): string | null;
```

### Validation (changed fields only)

```ts
// lib/validation/catalog.ts
export const resolveBarcodeSchema = z.object({
  barcode: barcodeStringSchema,
  format: z.string().trim().max(20).optional(),   // new
});

// lib/validation/counts.ts — scanCountLineSchema gains:
  format: z.string().trim().max(20).optional(),   // new
```

`format` stays a loose string at the boundary on purpose: a phone running an
older bundle, or a detector that reports a name we do not list, must not have
its scan *rejected*. `normalizeBarcode` is what narrows it.

### `lib/domain/catalog.ts` (changed signatures)

```ts
export async function resolveBarcode(
  actor: Actor,
  barcode: string,
  format?: string | null,              // new
): Promise<BarcodeResolution | null>;

export async function resolveBarcodeForCount(
  organizationId: number,
  barcode: string,
  format?: string | null,              // new
): Promise<{ productId: number; packLevel: PackLevel } | null>;

// unchanged signatures; bodies normalize input.barcode / input.barcode.barcode
export async function linkBarcodeToProduct(actor: Actor, input: LinkBarcodeInput): Promise<ProductSummary>;
export async function createProduct(actor: Actor, input: ProductCreateInput): Promise<ProductSummary>;

// new, private — replaces the two copies of the "who already has it" lookup
async function barcodeOwnerMessage(
  tx: Runner,
  organizationId: number,
  normalizedBarcode: string,
  shownBarcode: string,   // as scanned, for the message
): Promise<string>;
// → 'This barcode already belongs to Smirnoff 750 ml.'  /  '…to Blue Moon Sixtel (Sixtel keg).'
//   (fallback, if the owner row cannot be read: '…already belongs to another product.')
```

### `components/count/barcode-scanner.tsx`

```ts
onDetected: (barcode: string, format: string | null) => void;
type DetectorLike = {
  detect(source: CanvasImageSource): Promise<{ rawValue: string; format?: string }[]>;
};
```

### `components/count/count-leg.tsx`

```ts
type Phase =
  | /* …unchanged… */
  | { kind: "enroll"; barcode: string; format: string | null };   // format added

async function onBarcode(barcode: string, format: string | null): Promise<void>;
async function rapidScan(barcode: string, format: string | null, locationId: number): Promise<void>;
// rapid-scan write payload: { countId, barcode, format, locationId, qty: 1 }
```

### `components/count/enroll-form.tsx`

```ts
export function EnrollForm(props: {
  barcode: string;
  format: string | null;                          // new
  onCancel: () => void;
  onResolved: (product: ProductSummary) => void;  // unchanged
}): JSX.Element;

// Internal mode state grows one variant:
type EnrollMode =
  | { kind: "search" }
  | { kind: "confirm"; product: ProductSummary }   // new — Fix 2
  | { kind: "create"; from?: ProductSummary };     // `from` set by "It's a different size"

function LinkExisting(props: {
  barcode: string;
  onPick: (product: ProductSummary) => void;      // was: linked on tap
  onNewProduct: () => void;
}): JSX.Element;

/** New. Size is the largest text. Beer's bottle/case choice lives here. */
function ConfirmLink(props: {
  barcode: string;
  format: string | null;
  product: ProductSummary;
  onLinked: (product: ProductSummary) => void;
  onDifferentSize: (packLevel: "each" | "case") => void;
  onBack: () => void;
}): JSX.Element;

function CreateNew(props: {
  barcode: string;
  format: string | null;                          // new
  /** "It's a different size": prefill name + category + unit type, and
   *  forbid this size. When set, NO size is preselected. */
  from?: { product: ProductSummary; packLevel: "each" | "case" };   // new
  onCreated: (product: ProductSummary) => void;
  onBackToSearch: () => void;
}): JSX.Element;
```

---

## Call stack

**A. Scan a known bottle (one-shot).**
```
detector.detect → {rawValue, format}
  BarcodeScanner tick → onDetected(rawValue, format ?? null)
    CountLeg.onBarcode(barcode, format)
      resolveBarcodeAction({ barcode, format })
        requireRole → resolveBarcodeSchema.parse
        resolveBarcode(actor, barcode, format)
          normalizeBarcode(barcode, format)              ← lib/barcode.ts
          SELECT … WHERE organization_id = ? AND barcode = <normalized>
      → setPhase({ kind: "entry", product, … })
```

**B. Rapid scan.**
```
CountLeg.onBarcode → rapidScan(barcode, format, locationId)
  resolveBarcodeAction({ barcode, format })                (as A)
  runWrite("scan", { countId, barcode, format, locationId, qty: 1 })
    enqueue(IndexedDB) → scanCountLineAction(body)
      scanCountLine(actor, input)
        resolveBarcodeForCount(orgId, input.barcode, input.format)
          normalizeBarcode → SELECT …
        → applyIncrement (unchanged)
```

**C. Unknown → link (Fix 2).**
```
resolve → null → setPhase({ kind: "enroll", barcode, format })
  EnrollForm(barcode, format)
    LinkExisting → searchProductsAction → onPick(p) → mode "confirm"
    ConfirmLink → "Link and count"
      linkBarcodeToProductAction({ productId, barcode, format, packLevel })
        linkBarcodeToProduct
          assertProductOwned (unchanged)
          normalizeBarcode → INSERT (normalized barcode, normalized format)
      → onResolved(product) → entry screen
```

**D. "It's a different size".**
```
ConfirmLink.onDifferentSize(packLevel) → mode { kind: "create", from: { product, packLevel } }
  CreateNew(from) → name/category/unitType prefilled, size empty, from.product.sizeMl excluded
    createProductAction({ …, barcode: { barcode, format, packLevel } })
      createProduct → INSERT product → normalizeBarcode → INSERT product_barcode
```

**E. Already assigned (Fix 4).**
```
INSERT product_barcode → duplicate key
  barcodeOwnerMessage(tx, orgId, normalized, raw)
    SELECT p.name, p.size_ml, p.unit_type … → formatProductSize
  throw ConflictError("This barcode already belongs to Smirnoff 750 ml.")
ConfirmLink / CreateNew receives !ok
  resolveBarcodeAction({ barcode, format })      ← finds the owner (now normalized)
  → if found: show "Count <name> <size>" → onResolved(owner)
```

---

## Test plan

**Order rule:** every DB test below marked **[RED FIRST]** is written and run
against the *unchanged* code before any fix lands, and must fail there. Its
failure output is recorded in `00-status.md`. A test that passes against the
old code proves nothing (`docs/plans/README.md`, "Real tests only").

### `tests/barcode-normalize.test.ts` (new, pure)

Literal values below were computed with an independent check-digit and UPC-E
implementation (see `00-status.md`) — not with the module under test.

| Test | Asserts |
|---|---|
| `UPC-A becomes the 14-digit form` | `082000000013` → `00082000000013`, format `upc_a` |
| `EAN-13 with a leading zero becomes the same 14 digits` | `0082000000013` → `00082000000013` |
| `a 14-digit GTIN is unchanged` | `00082000000013` → itself |
| `UPC-E with format upc_e expands, then pads` | `08200103` + `upc_e` → `00082000000013` |
| `THE BUG: three readings of one bottle are one barcode` | the three inputs above produce deep-equal `barcode` |
| `UPC-E expansion — each of the four rules` | one valid example per final-digit rule (0–2, 3, 4, 5–9), each pinned to its known UPC-A |
| `an 8-digit code with no format is left as read` | `08200103` with `undefined` / `null` / `"unknown"` → `08200103` |
| `an 8-digit code with format ean_8 is padded` | a valid EAN-8 → 6 zeros + it |
| `a UPC-E with a wrong check digit is left as read` | — |
| `NEAR MISS: one wrong digit is never merged` | `082000000014` (bad check) → as read, ≠ `00082000000013` |
| `EAN-13 not starting with zero is padded by one` | a valid `5…` EAN-13 → `0` + it |
| `a 14-digit code with a non-zero indicator is unchanged` | — |
| `lengths that are not GS1 retail lengths are left as read` | 6, 10, 11 digits |
| `Code 128 is left as read, case preserved, trimmed` | `" X004YKHTYX "` → `X004YKHTYX`; `x004ykhtyx` stays lower-case |
| `an unknown format name is stored as null` | `"qr_code"`, `"<script>"`, `""` → `format: null` |
| `idempotent` | for every row above, normalizing the output again changes nothing |
| `total` | `""`, whitespace, 64 characters of junk → returns, never throws |

### `tests/bottle-sizes.test.ts` (added)

| Test | Asserts |
|---|---|
| `formatProductSize prints ml under a litre` | bottle 750 → `"750 ml"`, can 355 → `"355 ml"`, bottle 999 → `"999 ml"` |
| `formatProductSize prints litres from 1000 ml, dropping trailing zeros` | 1000 → `"1 L"`, 1500 → `"1.5 L"`, 1750 → `"1.75 L"` |
| `formatProductSize names the three keg sizes` | 19533 → `"Sixtel keg"`, 29337 → `"Quarter barrel keg"`, 58674 → `"Half barrel keg"` |
| `formatProductSize falls back to litres for an unnamed keg` | keg 50000 → `"50 L keg"` |
| `every size in the seed catalog formats to a non-empty label` | reads the seed CSV like the existing catalog test; no product prints `"NaN"`, `"0 ml"` or an empty string |
| `preset labels are built from formatProductSize` | every preset's label starts with `formatProductSize` of its own size; `1750` → `"1.75 L (handle)"`; `19533` → `"Sixtel keg (5.16 gal)"` |
| `kegGallons` | 19533 → `"5.16 gal"`, 29337 → `"7.75 gal"`, 58674 → `"15.5 gal"`, a bottle → null |

### `tests/catalog-write-path.test.ts` — new `describe("one barcode, one product, in any written form")`

| Test | Asserts | Red first? |
|---|---|---|
| `a bottle linked as UPC-A resolves when read as EAN-13` | link `082000000013` → product A; `resolveBarcode("0082000000013")` → A | **[RED FIRST]** — returns null today |
| `…and when read as UPC-E` | `resolveBarcode("08200103", "upc_e")` → A | **[RED FIRST]** |
| `THE BUG: the same code cannot be linked to a second size` | link UPC-A → Smirnoff 750; link EAN-13 form → Smirnoff 200 **throws ConflictError**; Smirnoff 200 has no barcode rows | **[RED FIRST]** — succeeds today |
| `creating a new size with the same code is refused` | `createProduct(…, barcode: UPC-E + upc_e)` throws; **no product row was created** (transaction rolled back) | **[RED FIRST]** |
| `the refusal names the owner and its size` | message contains `Smirnoff 750 ml`; for a keg owner, `(Sixtel keg)` | **[RED FIRST]** — no size today |
| `the stored row holds the 14-digit form and the format` | after link with `upc_a`: row `barcode = 00082000000013`, `format = upc_a` | **[RED FIRST]** |
| `an unknown format is stored as null` | link with `format: "qr_code"` → `format IS NULL` | **[RED FIRST]** — stores `qr_code` today |
| `an 8-digit code with no format is stored as read` | link `08200103`, no format → row `08200103` | passes today (guards the "never guess" rule against regression) |
| `rapid scan finds a product whatever the reading` | link UPC-A; `scanCountLine` with the EAN-13 form → increments that product's line, no NotFound | **[RED FIRST]** |
| `two tenants may still hold the same code` | org A and org B both link `082000000013` (different forms) → both succeed | passes today (invariant 9 regression guard) |
| `cross-tenant lookup still returns nothing` | org B resolves org A's code in another form → null | passes today |

**Mutation check after green** (STATE.md's "checked for teeth" practice):
make `normalizeBarcode` return its input unchanged → the **[RED FIRST]**
tests fail again and nothing else does. Recorded in `00-status.md`.

### Browser verification (`scripts/verify-browser.mjs`)

| Check | Asserts |
|---|---|
| `the back-office catalog prints sizes the shared way` | the catalog table shows `1.75 L`-style and `… keg` sizes and no `\d+ml` string anywhere in its cells |
| `picking a search result does not link it` | after tapping a result, a confirm screen shows and the database holds no new barcode row |
| `the confirm screen shows the size largest` | the size text's computed font-size is the largest on the screen |
| `"It's a different size" prefills and preselects nothing` | name and category fields carry the picked product's values; no size is selected; Save is disabled; the excluded size cannot be picked |
| `a conflict offers to count the owner` | linking an owned code shows "Count Smirnoff 750 ml", and tapping it opens that product's entry screen |

How the harness reaches the enroll screen without a real barcode in front of a
camera is Least confident #6.

---

## Least confident decisions

1. **Stored formats limited to the six the scanner asks for.** A detector that
   reports something else (`itf`, `codabar`) gets `format = NULL` and its code
   stored as read. Safe, but it throws away information. Alternative: store
   any name from the `barcode-detector` package's own list.
2. **"Count Smirnoff 750 ml" re-resolves the barcode** instead of the server
   returning the owner's id in the error. Costs one extra indexed read on a
   rare screen, and keeps `ActionResult`'s error shape unchanged for every
   other caller. The alternative widens a contract used by every action.
3. **Size display — DECIDED by the owner 2026-11-05.** `1.75 L` rather than
   `1750 ml` (litres from 1,000 ml up), and kegs by their trade name —
   "Sixtel keg", "Quarter barrel keg", "Half barrel keg" — with gallons as a
   secondary line on the confirm screen. The message for a keg owner reads
   *"…already belongs to Blue Moon Sixtel (Sixtel keg)"*; the repetition is
   accepted rather than guessing whether a name already contains its size.
   **Applied everywhere a size is printed — owner, 2026-11-05: "so everything
   stays the same".** See "One size spelling, everywhere" below.

4. **"It's a different size" carries the bottle/case choice into the create
   form.** If a counter chose "Case carton" on a beer and then said "different
   size", the new product's barcode is linked as `case`. Alternative: always
   `each`, as `CreateNew` does today.
5. **No normalization in the Zod schemas.** Only the domain normalizes, so
   validation errors quote what the user scanned. The cost: a test of a schema
   alone does not prove normalization; the DB tests do.
6. **Browser-testing the enroll screens.** They are reachable only after a scan.
   Proposal: launch the harness's Chromium with a **fake camera** fed by a
   generated video of a barcode (`--use-fake-device-for-media-stream` with
   `--use-file-for-fake-video-capture`), so the real detector reads a real
   code and the whole path — scan → confirm → link — runs in a browser.
   Fallback if that proves flaky: verify these screens by hand on the phone
   and record it in `docs/phone-count-test.md`. This needs trying before
   promising it; it is the first thing Gate 4's tracer slice should prove.
7. **The barcode shown on screen stays the raw scan**, not the 14-digit form,
   matching what is printed on the bottle. The stored form only appears in the
   database.
