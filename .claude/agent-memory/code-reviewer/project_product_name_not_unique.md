---
name: project-product-name-not-unique
description: RESOLVED 2026-07-25 — product now has uniqueIndex("product_name_size_ml_unique") on (name, size_ml), the real natural key (handles the 750ml/1.75L handle case). Kept for history/context only.
metadata:
  type: project
---

**RESOLVED as of the backend-layer review on 2026-07-25.** `db/schema.ts`'s `product`
table now carries `uniqueIndex("product_name_size_ml_unique").on(table.name, table.sizeMl)`,
with a comment explicitly calling it "the real natural key" and citing the handle-size
case this note originally raised. Confirmed no further gap here.

**New, smaller finding from the same review (not worth its own memory file, noted here
since it's adjacent):** `lib/domain/catalog.ts`'s `createProduct`/`updateProduct` don't
catch `ER_DUP_ENTRY` the way `lib/domain/counts.ts`'s `applyIncrement` does — a collision
on `product_name_size_ml_unique` or `product_barcode_barcode_unique` falls through
`lib/action-result.ts`'s generic catch-all ("Something went wrong. Please try again.")
instead of a field-level "a product with this name/size already exists" message. Low
severity (the unique index still prevents the bad row; this is UX/error-clarity only) but
worth fixing given scan-to-enroll's 20-second budget — a duplicate-enrollment attempt
should redirect to the existing product, not show a generic failure. `lib/domain/errors.ts`
already defines `ConflictError` for exactly this and it is currently unused anywhere in the
codebase — wire it up here rather than adding a new error type.

---

Original finding (2026-07-24, first DB-layer commit — kept for context):

Found 2026-07-24 reviewing the first DB-layer commit.

`db/seed.ts`'s `seedProducts()` looks up existing rows by `eq(product.name, name)`
before deciding insert vs. update, and its file banner explicitly calls
`product.name` a "natural key." `db/schema.ts`'s `location` table backs the
same pattern with a real `uniqueIndex("location_name_unique")` — but the
`product` table has no equivalent unique index on `name`. Only
`vendor_id`/`active`/`category` are indexed.

**Why this matters:** catalog integrity is the thing CLAUDE.md is most
worried about ("if it gets slow, the catalog decays and the whole system
dies"). Right now nothing at the database layer prevents two rows named
identically — a re-run race, a future manual insert, or (per CLAUDE.md's own
example) a 1.75L handle variant added with the same base name as its 750ml
sibling would either silently collide with seed.ts's upsert logic (overwriting
the wrong row) or create a confusing duplicate that the search-picker surfaces
twice. Current catalog (`docs/catalog/products.csv`, 97 rows) has zero name
collisions today, so this hasn't bitten yet.

**How to apply:** before/while the backend agent builds scan-to-enroll and the
catalog back office, get a decision on the real natural key for `product`
(name alone? name+size_ml? something else, given the documented 750ml/1.75L
handle case) and either add the matching unique index or explicitly design
product creation to tolerate same-name rows. Re-check `db/schema.ts`'s
`product` table and `docs/catalog/products.csv` for handle-size duplicates
before re-flagging — this describes state as of the initial commit.
