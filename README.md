# Truestock

Beverage and food inventory, costed from your supplier invoices. Counted, costed, and correct.

A manager walks the bar with a phone, scans each bottle's barcode, and records how much
is left. Out comes a valued inventory count, par-level reorder lists, and an audit-ready
record.

## Status

MVP foundation built: schema and migrations, auth, the counting app, the back office,
and a deploy pipeline. Not yet deployed — no production database has been migrated.
See [`docs/spec.md`](docs/spec.md) for the full product spec and
[`docs/open-items.md`](docs/open-items.md) for what is deliberately unfinished.

## Stack

Next.js 16 (App Router) · TypeScript · MariaDB · Drizzle · Better Auth · Tailwind ·
shadcn/ui · deployed on Hostinger Cloud Startup.

The database is MariaDB 11.8 — Hostinger labels it "MySQL" in hPanel, but
`SELECT VERSION()` says otherwise. The `mysql2` driver, drizzle's `"mysql"` dialect
and the `mysql://` URL scheme are all still correct: MariaDB speaks the MySQL wire
protocol.

## MVP scope

**In:** catalog, locations, barcode scan, fill level in tenths, quantity input, count
sessions, valuation, reorder lists, three-role auth.

**Deferred:** AI fill estimation, photos, invoice OCR, Toast POS variance, compliance
packet.

## Getting started

Everything runs in Docker — a MariaDB matching production, and a Node 22 app
container:

```bash
bun run docker:up        # MariaDB + app, waits until genuinely ready
bun run docker:migrate   # apply migrations
bun run docker:seed      # load the 97-product catalog
```

The app is then on http://localhost:3000. `bun run docker:reset` wipes the volume
and rebuilds from empty; `bun run db:shell` opens a SQL prompt.

To run against the database without the app container, copy `.env.example` to
`.env.local` and point `DATABASE_URL` at `127.0.0.1:3307`.

## Working on this

`CLAUDE.md` holds the project conventions and the ten non-negotiable data invariants.
Read it before changing anything that touches counts or valuation.

Specialist agents live in `.claude/agents/`. Slash commands in `.claude/commands/`:

- `/invariants` — audit the codebase against the data invariants
- `/ship` — pre-deploy gate: review, security audit, typecheck, build
