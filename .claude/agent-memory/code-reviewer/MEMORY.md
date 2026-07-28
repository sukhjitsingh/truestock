# Code-reviewer memory — Truestock

- [Snapshot columns NOT NULL vs NULL catalog data](project_snapshot_columns_vs_null_catalog.md) — RESOLVED 2026-07-25: columns are nullable, valuation.ts/counts.ts/reports.ts all handle NULL correctly (excluded, never coerced to 0)
- [product.name has no unique index](project_product_name_not_unique.md) — RESOLVED 2026-07-25: uniqueIndex on (name, size_ml) added. Also notes a small open item: ER_DUP_ENTRY not caught in catalog.ts create/update (generic error instead of field message)
- [Backend layer review 2026-07-25](project_backend_layer_review_2026-07-25.md) — invariants 1/2/7/8 all verified sound across authz.ts/counts.ts/catalog.ts/reports.ts/valuation.ts; two open non-invariant gaps (async draft promotion, no sealed-qty correction path)
