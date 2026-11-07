---
name: testing-bun-rejects-needs-real-promise
description: bun:test's expect(...).rejects requires a genuine Promise instance, not a thenable drizzle query builder — wrap bare db.insert(...).values(...) in an async IIFE
metadata:
  type: feedback
---

`expect(someValue).rejects.toThrow()` / `.toBeInstanceOf(...)` in bun:test requires
`someValue` to be a real `Promise` instance. A bare Drizzle query builder
(`db.insert(table).values({...})`, `db.update(...).where(...)`, etc.) is thenable
— `await`-able — but is NOT a `Promise` instance, so passing it directly to
`expect().rejects` fails with a confusing "Expected promise / Received: <huge
dumped query-builder object>" error, even when the underlying query genuinely
rejects (e.g. a real FK constraint violation).

**Why:** Discovered while mutation-checking the composite tenant FK backstop for
`createInvoiceForUpload` (Truestock Phase 2.5 slice 1, 2026-08-14) — the FK was
firing correctly (confirmed via a standalone repro script and
`information_schema.KEY_COLUMN_USAGE`), but the test kept failing with an
unreadable error that looked like the assertion itself was broken, not the code
under test.

**How to apply:** Whenever asserting a Drizzle write should reject in a bun:test,
wrap it in an async IIFE first so the value handed to `expect()` is a genuine
`Promise`:

```ts
const attempt = (async () => {
  await db.insert(invoice).values({ ... });
})();
await expect(attempt).rejects.toThrow();
```

Never pass the bare `db.insert(...).values(...)` (or `.update()`, `.delete()`)
builder straight into `expect(...).rejects` — it will misreport a working guard
as broken. See also [[counts-increment-idempotency]] for other Drizzle-write test
patterns in this codebase.
