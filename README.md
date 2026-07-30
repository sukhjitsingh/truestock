# Truestock

Beverage and food inventory, costed from your supplier invoices. Counted, costed, and correct.

A manager walks the bar with a phone, scans each bottle's barcode, and records how much
is left. Out comes a valued inventory count, par-level reorder lists, and an audit-ready
record.

## Status

MVP foundation built: schema and migrations, auth, the counting app, the back office
(dashboard, counts, catalog, reorder), and a deploy pipeline. Not yet deployed — no
production database has been migrated.

The schema, the auth path and the count write path are verified against a real
MariaDB 11.8 in Docker, the last of those by a 17-test suite wired into CI. The
back office has been driven in a browser; **the counting screens have not** —
nobody has taken a phone through a real count, and the offline write queue is
still unexercised. That is the shortest path to a trustworthy first count.

- [`STATE.md`](STATE.md) — what is proven, what is merely built, what is next
- [`ROADMAP.md`](ROADMAP.md) — the phases after the MVP
- [`docs/go-live.md`](docs/go-live.md) — the pre-launch gate and what to verify
  after the first production release
- [`docs/spec.md`](docs/spec.md) — the full product spec
- [`docs/open-items.md`](docs/open-items.md) — every deliberate gap, with the
  trigger that makes it due

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

Then create an account to sign in with — there is no public signup, and no dev
bypass, deliberately (authorization is re-read from the database on every request;
see invariant 7):

```bash
docker compose exec -T app bun run create-user -- \
  --email owner@truestock.local --name "Local Owner" \
  --role owner --org truestock --password '<12+ chars>'
```

`--password` is only safe here because `exec -T` has no TTY and this is a
throwaway local database. Against production, omit it and use the hidden prompt.

The app is then on http://localhost:3000. `bun run docker:reset` wipes the volume
and rebuilds from empty; `bun run db:shell` opens a SQL prompt.

To run against the database without the app container, copy `.env.example` to
`.env.local` and point `DATABASE_URL` at `127.0.0.1:3307`.

### Counting from a real phone

The counting screens cannot be verified from this machine — they need a camera,
a bottle, and a dim room. `bun run docker:up:lan` republishes the dev server on
your LAN address (it is loopback-only by default), generates a self-signed
certificate naming that address, and starts a TLS proxy beside the app. It
prints two URLs:

- `https://192.168.x.x:3443` — **use this one.** The camera is only exposed to
  a secure context, so scanning works here and nowhere else. The certificate is
  self-signed, so accept the warning once per phone.
- `http://192.168.x.x:3000` — everything except the camera, with no setup.

It also widens the dev allowlists that would otherwise reject the phone:
Better Auth's `trustedOrigins`, whose absence shows up as "check your email and
password" on a correct password, and Next's `allowedDevOrigins`, whose absence
lets a page render and never hydrate.

Start at **`/count/preflight`** on the phone — it reports secure context,
camera, decoder, write-id path and IndexedDB before you walk anywhere. The full
protocol is in [`docs/phone-count-test.md`](docs/phone-count-test.md).

`bun run docker:down && bun run docker:up` stops the proxy and restores the
loopback-only binding.

## Working on this

`CLAUDE.md` holds the project conventions and the ten non-negotiable data invariants.
Read it before changing anything that touches counts or valuation.

Specialist agents live in `.claude/agents/`. Slash commands in `.claude/commands/`:

- `/invariants` — audit the codebase against the data invariants
- `/ship` — pre-deploy gate: review, security audit, typecheck, build
