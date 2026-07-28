# Truestock

Beverage and food inventory, costed from your supplier invoices. Counted, costed, and correct.

A manager walks the bar with a phone, scans each bottle's barcode, and records how much
is left. Out comes a valued inventory count, par-level reorder lists, and an audit-ready
record.

## Status

Planning complete, implementation not started. See [`docs/spec.md`](docs/spec.md) for the
full product spec — scope, data model, compliance requirements, and the reasoning behind
each decision.

## Stack

Next.js 16 (App Router) · TypeScript · MySQL · Drizzle · Better Auth · Tailwind ·
shadcn/ui · deployed on Hostinger Cloud Startup.

## MVP scope

**In:** catalog, locations, barcode scan, fill level in tenths, quantity input, count
sessions, valuation, reorder lists, three-role auth.

**Deferred:** AI fill estimation, photos, invoice OCR, Toast POS variance, compliance
packet.

## Getting started

```bash
bun install
cp .env.example .env.local   # fill in DATABASE_URL and auth secrets
bun run db:migrate
bun run dev
```

## Working on this

`CLAUDE.md` holds the project conventions and the eight non-negotiable data invariants.
Read it before changing anything that touches counts or valuation.

Specialist agents live in `.claude/agents/`. Slash commands in `.claude/commands/`:

- `/invariants` — audit the codebase against the data invariants
- `/ship` — pre-deploy gate: review, security audit, typecheck, build
