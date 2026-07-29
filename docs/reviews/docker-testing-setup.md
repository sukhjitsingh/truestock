# Docker + MySQL for local testing — research and recommended setup

> **Superseded in one respect, 2026-07-28 — and it is the important one.** This
> document recommends pinning `mysql:8.4`, on the then-unverified assumption that
> Hostinger serves MySQL. It does not: `SELECT VERSION()` against the real host
> returns `11.8.8-MariaDB-log`. §2.7 of this document was right to refuse to guess
> the version and to specify a probe; the probe was run and the answer was MariaDB.
>
> **What shipped therefore pins `mariadb:11.8`**, not `mysql:8.4`. Everything else
> here — port 3307 to dodge the Homebrew MySQL, the TCP healthcheck, `down -v` as
> the real reset, the separate test database, Compose over Testcontainers because
> Testcontainers hangs under Bun, and the squash argument in §4 — carried over
> unchanged and was verified against MariaDB.
>
> One factual error to note, since it is repeated in a few places below:
> `utf8mb4_0900_ai_ci` is **not** MySQL-only. MariaDB 11.x accepts it as an alias
> for `utf8mb4_uca1400_ai_ci`, so the init script that was meant to "fail loudly on
> the wrong engine" would have passed silently. It was never a tripwire.

**Status: research only. Nothing in this document has been applied to the repo.**
No `docker-compose.yml` exists at the root, `package.json` is untouched, and no
script has been added. Every file below is written out in full so it can be
copied verbatim once approved.

*(That status line was accurate when written. The setup has since been
implemented and committed — see `docker-compose.yml` and `docker/`.)*

Written 2026-07-28, in response to: *"I want a properly structured, controlled
Docker + MySQL setup for local testing, and I'm looking into docker sandboxes.
I will not touch the Hostinger production database until I'm satisfied with the
Docker setup and its testing."*

That framing is the right one, and it changes what this document optimises for.
The Docker environment is **the gate before production**, not a convenience. So
the setup below is deliberately boring, reproducible, and checked into git —
the opposite of what happened on 2026-07-27, when a throwaway MySQL 8.0
container was stood up ad hoc, probed, and thrown away, leaving `db/README.md`
line 94 and `docs/open-items.md` item 1 asserting a verification that nobody
can now reproduce. Everything here is designed so that claim becomes
re-runnable by anyone, on any machine, with one command.

### How to read the confidence markers

- **[V]** — Verified in this session, either by running a command on this
  machine, reading the installed source in `node_modules/`, or fetching a
  primary source (Docker Hub API, npm registry, official docs, the actual
  GitHub issue).
- **[R]** — Reasoned from verified facts. Sound, but not directly executed.
- **[U]** — Unverified. Stated as unknown rather than guessed.

---

## 0. Facts measured on this machine

All **[V]**, from running the commands.

| Fact | Value | Why it matters |
|---|---|---|
| OS | macOS **13.7.8** Ventura (Darwin 22H730), **Intel x86_64** | Constrains which container runtime is even installable |
| Docker Desktop | **4.25.2**, engine **24.0.6**, Compose **v2.23.0** | Old (Nov 2023) but sufficient for everything below |
| Docker daemon | **not running** at time of check | Just needs starting |
| Homebrew MySQL | **8.0.12** installed, service **stopped**, LaunchAgent registered | A latent port-3306 collision — `brew services start mysql` would take it |
| Host `mysql` client | **broken** — `dyld: Library not loaded: libssl.1.0.0.dylib` | You cannot use the host CLI at all; must shell in via the container |
| Port 3306/3307/3308 | nothing listening right now | 3307 is free and safe |
| drizzle-kit | **0.31.10** | Commands: `generate migrate introspect push studio up check drop export`. **No `squash`.** |
| drizzle-orm | 0.45.2 · mysql2 **3.23.1** · better-auth **1.6.25** | |
| Migration chain | `0000` → `0001` → `0002`, journal version 7, 3 entries | `0002` is hand-edited on purpose |

Two of these are load-bearing and easy to miss:

1. **The host `mysql` binary does not run.** Homebrew MySQL 8.0.12 (a 2018
   build) links against OpenSSL 1.0.0, which is long gone from this machine.
   So every "just connect and check something" instinct has to go through
   `docker compose exec`. The setup below assumes that and provides the
   commands.
2. **Docker Desktop cannot be upgraded past ~4.47 on this Mac.** Docker's
   support policy is the current macOS release plus the two previous **[V,
   docs.docker.com]**; in July 2026 that is macOS 26 / 15 / 14, which excludes
   Ventura. The last Docker Desktop reported to run on macOS 13.7.8 is
   **4.47.0** **[V, secondary source]**. The installed 4.25.2 already does
   everything this document needs, so this is a "know your ceiling" note, not a
   blocker. It does, however, rule out one of the things in §1.

---

## 1. "Docker sandboxes" — what the phrase can mean, and which one you want

The term genuinely collided in 2026. Six distinct things now answer to it. Only
one of them is the problem you are trying to solve.

### The one you want

**Docker Compose dev environment** — a checked-in `docker-compose.yml` that
declares MySQL as a named service with a pinned image, a named volume, a
healthcheck, and a published port. Reproducible by definition (the file *is*
the environment), diffable in review, and identical on your Mac and on a CI
runner. **This is the recommendation.** §2 is the whole design.

### Adjacent — solves the *test* lifecycle, not the *dev* database

**Testcontainers (Node/TypeScript SDK).** `testcontainers` + `@testcontainers/mysql`,
both at **12.0.4, published 2026-06-29** **[V, npm registry]**. Real, current,
well-maintained. API is `new MySqlContainer("mysql:8.4").start()` then
`getConnectionUri()` **[V, node.testcontainers.org]**. It spins a fresh
container per test suite and tears it down after. It is a legitimate answer to
question 3 and is analysed properly in §3 — where it loses, for a reason
specific to this repo.

### Different problem — killed in one line each

- **Dev Containers (`devcontainer.json`)** — containerises your *editor and
  toolchain*, not your database. It would move `next dev`, `bun`, and Node into
  a container, which on Intel macOS means paying gRPC-FUSE bind-mount latency
  on every file save in a Next.js hot-reload loop. It adds nothing to MySQL
  reproducibility that Compose does not already give you. Skip.
- **Docker Hardened Images / seccomp / AppArmor / capability dropping** —
  supply-chain and container-escape hardening for images you ship to
  production. You ship a Next.js standalone bundle to Hostinger's managed Node
  runtime; you ship no containers at all. Irrelevant.
- **Rootless mode** — runs the Linux daemon as a non-root user. On macOS the
  daemon already lives inside a VM you don't share with anything. No-op here.
- **Docker Sandboxes (the 2026 Docker product)** — per-agent **microVMs** for
  running coding agents unattended, "YOLO mode, safely" **[V, docker.com]**.
  Supports Claude Code, Codex, Gemini, cagent. This protects *your host from an
  agent*; it does nothing for MySQL reproducibility. And practically: it
  requires a current Docker Desktop, which macOS 13.7.8 cannot install **[R,
  from the version ceiling in §0]**. Not available to you, and not the problem.
- **Claude Code's own sandboxing** — Seatbelt/bubblewrap plus a network proxy
  for the bash tool, with cloud sessions in microVMs **[V]**. Already native,
  already on, unrelated to databases.

### And the sloppy meaning

"Docker sandbox" is also just casual shorthand for *a throwaway container I
started by hand and deleted*. That is precisely what happened on 2026-07-27 and
precisely what this document exists to replace. The distinction that matters is
not container-vs-sandbox; it is **declared and committed** versus **typed once
into a terminal**.

---

## 2. Recommended setup for this repo

### 2.1 `docker-compose.yml` (repo root)

```yaml
# Local MySQL for Truestock. This file IS the local database definition —
# there is no "and then run this one command I typed once."
#
# Deliberate choices, each with a reason:
#   - port 3307, not 3306: Homebrew MySQL 8.0.12 is installed on this machine
#     with a registered LaunchAgent. It is stopped today; `brew services start
#     mysql` would silently take 3306 and you would spend an afternoon
#     debugging a schema mismatch against a 2018 server.
#   - explicit charset/collation server flags: db/README.md requires the
#     database be utf8mb4 / utf8mb4_0900_ai_ci (schema audit F3). Nothing in
#     db/schema.ts or drizzle/*.sql declares a charset, so every table inherits
#     the database's. Setting it at the server makes CREATE DATABASE correct by
#     construction rather than by remembering.
#   - --max-connections=100: mirrors Hostinger Cloud Startup's cap (spec §11).
#     If a pool or query pattern is going to exhaust connections in production,
#     it should exhaust them here first.
#   - --default-time-zone=+00:00: every `timestamp` column in db/schema.ts uses
#     defaultNow(). A container defaulting to SYSTEM time zone and a shared host
#     defaulting to something else produce quietly different `started_at`
#     values. Pin it; then compare against production (§5.7).
#   - healthcheck pings over TCP (-h 127.0.0.1), not the socket: the MySQL
#     entrypoint runs a TEMPORARY server with --skip-networking while it
#     initialises. A socket ping passes against that temp server, so
#     `depends_on: service_healthy` fires before the database actually exists.
#     TCP cannot reach the temp server, so it only goes green for the real one.

services:
  db:
    image: mysql:8.4
    container_name: truestock-mysql
    restart: unless-stopped
    command:
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_0900_ai_ci
      - --default-time-zone=+00:00
      - --max-connections=100
      - --innodb-buffer-pool-size=256M
      - --local-infile=0
      # Uncomment to claw back ~150-250MB of RSS. Costs you nothing for
      # correctness testing; costs you EXPLAIN/statement instrumentation if
      # you later want to profile a query.
      # - --performance-schema=OFF
    environment:
      # Local-only credentials. Keep them alphanumeric: they end up inside a
      # DATABASE_URL, and anything needing percent-encoding there is a trap.
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: truestock
      MYSQL_USER: truestock
      MYSQL_PASSWORD: truestock
    ports:
      # host:container — 3307 on the host, standard 3306 inside.
      - "127.0.0.1:3307:3306"
    volumes:
      - truestock-mysql-data:/var/lib/mysql
      # Runs ONCE, on a fresh volume, after the entrypoint has created the
      # database and granted the app user.
      - ./docker/mysql/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test:
        - CMD-SHELL
        - 'mysqladmin ping -h 127.0.0.1 -u root -p"$$MYSQL_ROOT_PASSWORD" --silent'
      interval: 5s
      timeout: 5s
      retries: 20
      # First boot has to initialise the data directory. Without this, the
      # retries burn out before the server is ever up.
      start_period: 40s

volumes:
  truestock-mysql-data:
```

Notes on the file:

- **No `version:` key.** Obsolete in Compose v2 and warns on 2.23 **[R]**.
- **No `platform:` flag.** This is an Intel Mac, so `linux/amd64` is native —
  the whole Rosetta/`--platform` discussion in most macOS Docker guides applies
  to Apple Silicon and is a no-op here **[V, arch confirmed in §0]**.
- **`127.0.0.1:3307`**, not bare `3307`. Binding to loopback keeps the database
  off your LAN. Docker publishes to `0.0.0.0` by default, which on a café WiFi
  means a root-password-`root` MySQL is reachable by anyone on the network.

### 2.2 `docker/mysql/init/00-charset.sql`

```sql
-- Runs once, on an empty data volume, after the entrypoint has created
-- `truestock` and granted the app user.
--
-- The server flags in docker-compose.yml already make this the default, so
-- this statement is belt-and-braces on the charset. Its real job is to FAIL
-- LOUDLY on the wrong engine: utf8mb4_0900_ai_ci does not exist in MariaDB.
-- If Hostinger turns out to serve MariaDB rather than MySQL (see §2.5), this
-- one line is the difference between finding out now and finding out during
-- a production migration.
--
-- Requirement source: db/README.md "Set up a database", schema audit F3.
ALTER DATABASE `truestock`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
```

### 2.3 `docker/mysql/init/01-test-database.sql`

```sql
-- A SECOND database, for automated tests only (see §3).
--
-- Tests must never run against `truestock`: the reset-to-zero they need
-- (TRUNCATE, or a drop-and-remigrate) would wipe the costs, pars, and barcodes
-- you entered by hand through the back office — the exact data db/README.md's
-- seeding section goes out of its way to protect from a re-seed. Separate
-- database, same server, same container, same charset.
CREATE DATABASE IF NOT EXISTS `truestock_test`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

GRANT ALL PRIVILEGES ON `truestock_test`.* TO 'truestock'@'%';
FLUSH PRIVILEGES;
```

### 2.4 Environment — pointing `DATABASE_URL` at it

`.env.example` is **not touched**. It documents the production shape
(`@localhost:3306`, per `docs/deploy.md` §2.4) and should keep doing exactly
that. Local overrides go in `.env.local`, which `.gitignore` already excludes
(`.env*` with a `!.env.example` exception) **[V]** and which
`drizzle.config.ts` explicitly loads **[V, line 5]**.

`.env.local` — create/replace:

```dotenv
# Local Docker MySQL (docker-compose.yml). Port 3307, not 3306 — see the
# comment in that file about the Homebrew MySQL 8.0.12 on this machine.
#
# 127.0.0.1, NOT localhost: on macOS `localhost` resolves to ::1 first, and
# the container publishes on IPv4 loopback. Using the literal IPv4 address
# removes a whole class of "connection refused, but the container is running"
# confusion.
DATABASE_URL="mysql://truestock:truestock@127.0.0.1:3307/truestock"

# Same server, separate database — used only by the test suite.
TEST_DATABASE_URL="mysql://truestock:truestock@127.0.0.1:3307/truestock_test"

# Better Auth — generate with: openssl rand -base64 32
BETTER_AUTH_SECRET="<paste 32 random bytes here>"
BETTER_AUTH_URL="http://localhost:3000"
```

`db/index.ts` needs no change: it reads `DATABASE_URL` lazily at first query,
already pins `charset: "utf8mb4"` client-side, and already sets
`dateStrings: ["DATE"]` **[V]**. The container is just another URL to it.

### 2.5 Scripts to add to `package.json`

**Not applied.** Copy into the existing `"scripts"` block:

```json
    "db:up": "docker compose up -d --wait",
    "db:down": "docker compose down",
    "db:reset": "docker compose down -v && docker compose up -d --wait && bun run db:migrate && bun run db:seed",
    "db:shell": "docker compose exec db mysql -utruestock -ptruestock truestock",
    "db:logs": "docker compose logs -f db",
    "db:verify-chain": "bash scripts/verify-migration-chain.sh"
```

`--wait` blocks until the healthcheck goes green, so `db:reset` is a single
sequential command with no `sleep` in it. Requires Compose ≥ 2.17; you have
2.23 **[V]**.

`db:shell` matters more than it looks: the host `mysql` client on this machine
is broken (§0), so this is your only interactive SQL prompt.

### 2.6 Seeding and reset-to-zero

Normal flow, from cold:

```bash
bun run db:up          # container up, healthy, database created utf8mb4
bun run db:migrate     # drizzle-kit migrate: 0000 -> 0001 -> 0002
bun run db:seed        # 5 locations, 97 products, 9 keg costs, 1 organization
bun run create-user    # owner account (Better Auth credential)
```

**Recommendation: reset by dropping the volume (`docker compose down -v`), not
by dropping the schema.** The reasons are specific, not stylistic:

1. **It re-runs `docker-entrypoint-initdb.d`.** Dropping the *schema* leaves
   the server up, so `00-charset.sql` and `01-test-database.sql` never fire
   again, and you have to remember to re-issue `CREATE DATABASE ... COLLATE
   utf8mb4_0900_ai_ci` by hand. That is the exact step `db/README.md` says
   people get wrong, and it fails silently — accented product names
   (Cointreau, Château, Jägermeister, Añejo) mojibake rather than erroring.
2. **It resets server state, not just data.** `AUTO_INCREMENT` counters, the
   InnoDB data dictionary, and `__drizzle_migrations` all go back to genuinely
   zero. A schema drop leaves you reasoning about which of those survived.
3. **It is honest about what "from empty" means.** The whole point of this
   environment is proving the migration chain applies to a database that has
   never seen it. A recycled server is not that.

The cost is ~40 seconds of re-initialisation. That is the right trade for a
gate.

Use `TRUNCATE`-style resets only *inside* the test suite, against
`truestock_test`, where you are resetting between test files and not between
sessions (§3.4).

### 2.7 MySQL version pinning — and what Hostinger actually runs

**Pinning matters here, more than in a typical project.** Three reasons:

- `utf8mb4_0900_ai_ci` is a MySQL collation. It **does not exist in MariaDB**
  **[V]**. If Hostinger serves MariaDB, `db/README.md`'s required
  `CREATE DATABASE` statement fails outright and the charset story needs
  rewriting.
- **MySQL 8.0 reached end of life 30 April 2026** **[V]**. It is under Oracle
  Sustaining Support only; the recommended path is 8.4 LTS or 9.7 LTS.
  `mysql:8.0` is still pullable and resolves to **8.0.44, last pushed
  2026-05-05** **[V, Docker Hub API]** — i.e. frozen, unpatched.
- The **official image's current tags** are **[V, Docker Hub API, 2026-07-28]**:
  `8.4.11` (`8.4`, `8`), `9.7.2` (`9.7`, `9`, **`lts`**), and `26.7.0`
  (`26.7`, `26`, **`innovation`**, **`latest`**). Both amd64 and arm64. Note
  that `latest` is now the innovation series — never use it.
- **MySQL 8.4 disables `mysql_native_password` by default; MySQL 9.0 removed
  it entirely** **[V]**. New accounts get `caching_sha2_password`. This is fine
  for mysql2 (§5.2) but will bite anything older.

**What version does Hostinger give you? Not stated anywhere in the repo.**
`docs/deploy.md` §2.1 says only "create a database named `truestock`"; a grep
across `docs/*.md` and `db/README.md` finds no MySQL version, no MariaDB
mention, no engine claim **[V]**. This is genuinely unknown **[U]** and I am
not going to guess it.

**This is the one thing worth a read-only probe of production before you are
"satisfied."** It writes nothing, creates nothing, and touches no table:

```bash
# Reuses the SSH-tunnel pattern scripts/hostinger-migrate.sh already implements.
ssh -i <deploy-key> -p <port> -f -N -L 13306:127.0.0.1:3306 <user>@<host>

docker compose exec -T db mysql \
  -h host.docker.internal -P 13306 \
  -u <db-user> -p<db-password> -e "
    SELECT VERSION() AS version,
           @@version_comment AS flavour,
           @@collation_server AS collation_server,
           @@character_set_server AS charset_server,
           @@sql_mode AS sql_mode,
           @@global.time_zone AS tz,
           @@max_connections AS max_conn,
           @@max_user_connections AS max_user_conn\G"
```

Until that returns, **`mysql:8.4` is the right default** **[R]**: it is the
oldest still-supported LTS, it is what a managed shared host is most likely to
have moved to now that 8.0 is EOL, and every 8.0 behaviour this schema depends
on (generated STORED columns, composite foreign keys, JSON, `utf8mb4_0900_ai_ci`)
is unchanged in it. Changing the pin later is a one-line edit plus a
`bun run db:reset`.

If you want true byte-reproducibility rather than "latest 8.4 patch", pin the
digest instead of the tag:

```yaml
    image: mysql:8.4.11@sha256:<digest from `docker buildx imagetools inspect mysql:8.4.11`>
```

Tradeoff, stated plainly: a floating `8.4` silently picks up security patches
and could in principle change behaviour under you; a pinned digest never
changes and never gets patched. For a *local test gate*, floating `8.4` is the
better default — you want to find out about a patch-level behaviour change here
rather than in production.

### 2.8 macOS-on-Intel specifics

- **Architecture: nothing to do.** amd64 is native on this machine. No
  `platform:` key, no Rosetta, no QEMU emulation, none of the arm64 caveats
  that dominate current macOS Docker writing **[V]**.
- **Runtime choice is narrower than the internet suggests:**
  - **Docker Desktop** — installed, works, and is the only one of the three
    that supports macOS 13. Ceiling is ~4.47.0 (§0). **Use this.**
  - **OrbStack** — supports Intel Macs, but **requires macOS 14.0+; macOS 13
    support was dropped** **[V, orbstack.dev]**. Not installable here. It is
    genuinely faster and much lighter (roughly 4.5× less idle RAM than Docker
    Desktop **[V, secondary]**), so it is the thing to revisit *if* you ever
    move to Sonoma or later — and $96/yr for commercial use.
  - **Colima** — free, MIT, macOS+Linux, no macOS-13 exclusion found **[R —
    I did not verify Colima's minimum macOS]**. A reasonable fallback if
    Docker Desktop misbehaves, at the cost of no GUI and more VM fiddling.
    Not worth switching to preemptively.
- **Memory.** 16 GB total. Docker Desktop's VM will want 2–4 GB; set it to
  **4 GB** in Settings → Resources (2 GB is tight once `next build` and a
  browser are also running). The MySQL container itself, with
  `--innodb-buffer-pool-size=256M`, lands around **400–600 MB RSS** **[R]**;
  uncommenting `--performance-schema=OFF` takes roughly 150–250 MB off that
  **[R]**. One MySQL container is not the thing that will hurt on this
  machine — a Testcontainers run that starts three of them plus a Ryuk reaper
  might be, which is one more small mark against §3's alternative.
- **Disk.** Give Docker Desktop at least 20 GB of virtual disk. The mysql:8.4
  image is ~600 MB and each `down -v` / `up` cycle churns the volume.

---

## 3. Testcontainers vs Compose for the automated test story

### 3.1 The state of play

This repo has **zero tests**. `scripts/run-tests.sh` finds no
`*.test.ts(x)`/`*.spec.ts` anywhere and exits 0 with a message, deferring to
`bun test` the moment one exists **[V]**. CI runs `bun run test` on every PR
and on main, and `deploy.yml`'s `verify` job runs it again before shipping
**[V]**. So the harness is already wired; only the tests are missing.

The open items that need closing are all database-dependent **[V,
docs/open-items.md]**:

- **#1** — the replay rollback in `applyIncrement`, `count_line_write` → `count_line`
  cascade, Better Auth under `generateId: "serial"`, the inactive-user session
  hook, `scripts/create-user.ts`, `partial_fills` JSON round-trip, mysql2's real
  `ER_DUP_ENTRY` shape, `DECIMAL(10,4)` precision through drizzle's string mode.
- **#8** — `listCounts`'s double `user` alias, `previousCountComparison`'s
  `lt()` against a nullable `closed_at`, `getCountTotals` vs `closeCount`
  agreeing on unpriced lines.
- **#9** — the offline write queue. Browser-side; needs a real server behind it.

None of these are unit tests. Every one is "run the real query against real
InnoDB and look at what comes back."

### 3.2 The decisive fact

**Testcontainers does not reliably work under Bun** **[V]**. `oven-sh/bun`
issue #21342: the script logs "starting container" and hangs forever; the
container itself starts fine (Postgres logs "ready to accept connections") but
the readiness promise never resolves. Node/tsx runs the identical code
correctly. The issue is closed with the workaround "use Node instead of Bun."
There are further open reports (bun#9661, testcontainers-node discussion #1115)
of the same class of failure. Testcontainers' own position is that Bun is not
officially supported.

This repo is Bun end-to-end for tooling: `bun install --frozen-lockfile`,
`bun run typecheck`, `bun run lint`, `bun run test`, `bun run build` in both
workflows; `bunx drizzle-kit migrate` in `scripts/hostinger-migrate.sh`
**[V]**. `run-tests.sh` literally `exec bun test`.

So choosing Testcontainers means either (a) betting that the Bun incompatibility
does not hit you, on a machine and CI runner you would then be debugging
container-startup hangs on, or (b) introducing a second test runner on Node
purely to accommodate the test-database library — a whole parallel toolchain to
solve a problem Compose does not have.

### 3.3 Recommendation: **Compose, in both places**

Use **one long-lived Compose database**, and run **the same `docker-compose.yml`
in CI**. Not GitHub Actions' `services:` block — the actual file.

```yaml
# .github/workflows/ci.yml — insert after "Install dependencies",
# before "Typecheck". Ubuntu runners ship Docker and Compose v2. [R]
      - name: Start MySQL
        run: docker compose up -d --wait

      - name: Migrate test database
        env:
          DATABASE_URL: mysql://truestock:truestock@127.0.0.1:3307/truestock_test
        run: bunx drizzle-kit migrate

      # ... existing Typecheck / Lint steps ...

      - name: Test
        env:
          DATABASE_URL: mysql://truestock:truestock@127.0.0.1:3307/truestock_test
        run: bun run test
```

Why the file and not `services:`:

- **Zero drift.** The `services:` block cannot pass server `command:` flags, so
  the charset, collation, time zone and `max-connections` settings from §2.1
  would have to be re-expressed as a separate post-start `ALTER DATABASE` step
  — a second definition of the same thing, guaranteed to fall out of sync with
  the first one that matters.
- **One artefact to reason about.** "Does CI test the same database I do?"
  becomes a `git diff` rather than a comparison of two YAML dialects.
- **The healthcheck already exists** and `--wait` already blocks on it.

For completeness, if you ever do need `services:` (e.g. a runner without
Compose), it looks like this and needs the charset fixup:

```yaml
    services:
      mysql:
        image: mysql:8.4
        env:
          MYSQL_ROOT_PASSWORD: root
          MYSQL_DATABASE: truestock_test
          MYSQL_USER: truestock
          MYSQL_PASSWORD: truestock
        ports: ["3307:3306"]
        options: >-
          --health-cmd="mysqladmin ping -h 127.0.0.1 -u root -proot --silent"
          --health-interval=5s --health-timeout=5s
          --health-retries=20 --health-start-period=40s
    # ...then, as a step, because `services:` cannot set server flags:
    #   mysql -h 127.0.0.1 -P 3307 -uroot -proot -e \
    #     "ALTER DATABASE truestock_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
```

### 3.4 Test isolation without per-suite containers

The usual argument for Testcontainers is isolation. This app hands you a better
mechanism for free: **it is multi-tenant, and every read filters on
`organization_id` while every write stamps it** (invariant 9).

So the pattern is: **each test file creates its own `organization` row and works
entirely inside it.** Tests are then isolated from each other by the same
mechanism that isolates paying customers from each other — which means the test
suite *exercises invariant 9 continuously* rather than merely asserting it in
one dedicated test. Cross-contamination between test files becomes a genuine
tenancy bug, surfacing as a failure, which is exactly what you want.

Concretely:

- One `beforeAll` in a shared helper runs `drizzle-kit migrate` against
  `TEST_DATABASE_URL` (or CI does it once, as above). Migrations run once per
  suite run, not once per file.
- Each file's `beforeAll` inserts an organization with a unique slug
  (`test-${crypto.randomUUID()}`) and derives an `Actor` from it.
- Each file's `afterAll` deletes that organization; the existing FK cascade
  ordering documented in `db/README.md` handles the rest.
- One `afterAll` at the top level calls `closePool()` from `db/index.ts` —
  **without this `bun test` will hang on the open pool** (§5.1).
- The handful of tests that genuinely need a virgin database (a full
  `0000 → 0002` application, §4.4) use `scripts/verify-migration-chain.sh`
  against a throwaway database name instead of the shared one.

### 3.5 The honest cost of choosing Compose

- **Tests are order-sensitive if you get lazy.** Nothing physically stops a
  test from querying without an organization filter and seeing another test's
  rows. Testcontainers would make that impossible. The counter-argument: a
  query that ignores `organization_id` is a **production security bug** under
  invariant 9, and a test suite that surfaces it is doing its job.
- **A wedged database persists.** `docker compose down -v && bun run db:up`
  fixes it; a Testcontainers run would have thrown the container away for you.
- **You must remember `--wait`.** Without it, the first test race-loses to the
  40-second init on a cold volume.

None of those outweigh "the runtime we use for every other command hangs
indefinitely on the alternative."

---

## 4. Migration testing and the squash question

### 4.1 The concern, restated precisely

You do not want `0000 → 0001 → 0002` — where `0002` exists only because
`drizzle-kit generate` produced an **unrunnable** file that had to be hand-edited
to drop, modify, and re-add foreign keys around a `BIGINT` widening (MySQL
`ERROR 3780`) **[V, drizzle/0002_wet_abomination.sql header]** — to be the thing
that runs against the first real production database.

That concern is correct, and the reason is sharper than "it's untidy":

**A fresh baseline generated from empty contains no `MODIFY COLUMN` at all.**
The `BIGINT` columns are simply `bigint` in the `CREATE TABLE`. The entire
class of bug that forced the hand-edit — width changes under existing foreign
keys — cannot arise when there is nothing existing. The one file drizzle-kit
did not write, and the one file that could fail in a way nobody has a rehearsal
for, disappears. **[R, but a direct consequence of what 3780 is]**

### 4.2 What drizzle-kit 0.31.10 actually supports

**[V, `drizzle-kit --help` on the installed binary]** Commands: `generate`,
`migrate`, `introspect`, `push`, `studio`, `up`, `check`, `drop`, `export`.

- **There is no `squash` command.** The feature request
  (drizzle-orm issue #4897, opened 2025-09-02) is **open, unassigned, no PR**
  **[V, fetched the issue]**.
- **`drizzle-kit export --sql`** — "Generate diff between current state and
  empty state in specified formats: sql" **[V, `export --help`]**. This is the
  squash primitive: it prints the complete DDL for `db/schema.ts` from nothing.
  It does *not* write a migration file or a journal entry — it is a cross-check,
  not the mechanism.
- **`drizzle-kit drop`** removes a migration from the journal interactively.
- **`drizzle-kit check`** validates the migration folder for collisions and
  race conditions — worth adding to CI regardless of what you decide here.
- Migration bookkeeping lives in a table named **`__drizzle_migrations`** inside
  the connected database **[V, `node_modules/drizzle-orm/mysql-core/dialect.js:30`]**.

### 4.3 The two options

#### Option A — keep the chain

Do nothing. Production's first `drizzle-kit migrate` replays all three files in
order.

- **For:** zero process change; the CI immutability check stays untouched; the
  chain has already been applied end-to-end against MySQL 8.0 (2026-07-27), and
  `db/README.md`, `docs/open-items.md` #1 and `docs/reviews/schema-scalability-audit.md`
  all cite `0001`/`0002` by filename as where findings B1/F1/F2/F4 were fixed —
  that provenance stays intact.
- **Against:** the hand-edited `0002` runs against production exactly once,
  ever, and its drop/modify/re-add FK sequence is the least-rehearsed code in
  the repo. You carry a permanent record of local iteration into the production
  migration history for no operational benefit.

#### Option B — squash to a clean baseline (**recommended**)

- **For:**
  - **No production database exists.** `db/README.md` line 93 says so
    explicitly: *"Nothing has yet been applied to a production database"*
    **[V]**. The immutability rule's own stated rationale — a migration on
    `main` is "a record of what actually ran (or will run) against a database
    that matters" — is *factually not yet true*. This is the last moment it
    costs nothing.
  - **The hand-edited file evaporates.** §4.1.
  - **No `__drizzle_migrations` fixups anywhere.** The standard, painful part
    of squashing — hand-inserting rows into the migrations table so existing
    environments don't re-run DDL that is already applied — **does not apply
    to you at all**, because there is no environment to reconcile. You are in
    the single narrow window where a squash is genuinely free.
  - Production's first migrate becomes one `CREATE TABLE` script, which is the
    easiest possible thing to review, dry-run, and reason about at 2am.
- **Against:**
  - **CI blocks it** (§4.5).
  - **Provenance loss.** `db/README.md`'s Migrations section, `open-items.md`
    #6, and `schema-scalability-audit.md` §0 all reference `0001_strong_daimon_hellstrom.sql`
    and `0002_wet_abomination.sql` by name **[V]**. After a squash those are
    dangling references. Mitigation: one paragraph in `db/README.md` recording
    that the baseline already incorporates findings B1/F1/F2/F4 and that the
    files that introduced them were collapsed pre-launch. Cheap, and arguably
    more useful than the filenames.
  - **You must re-prove equivalence.** §4.4 makes this mechanical.
  - **`0002`'s hand-edit was a real lesson.** `db/README.md` keeps it as the
    documented pattern for hitting 3780 on a future width change. Keep that
    paragraph even after the file is gone.

**Verdict: squash, once, before the first deploy, with the §4.4 diff as
proof.** The window closes the moment `hostinger-migrate.sh` runs for real.

#### How to squash, concretely

```bash
# 1. Snapshot the schema the CURRENT chain produces (see §4.4).
bun run db:up
bash scripts/verify-migration-chain.sh chain_old > /tmp/schema-chain.sql

# 2. Collapse. drizzle-kit has no `squash`, so this is the mechanism:
#    remove the files and regenerate from db/schema.ts, which is and always
#    was the source of truth.
rm drizzle/0000_*.sql drizzle/0001_*.sql drizzle/0002_*.sql
rm -rf drizzle/meta
bun run db:generate           # writes a single fresh 0000_*.sql + meta/

# 3. Snapshot what the NEW baseline produces.
bash scripts/verify-migration-chain.sh chain_new > /tmp/schema-squashed.sql

# 4. Prove they are the same database.
diff -u /tmp/schema-chain.sql /tmp/schema-squashed.sql && echo "IDENTICAL"

# 5. Independent cross-check from a different code path.
bunx drizzle-kit export --sql > /tmp/schema-export.sql
```

Step 4 is the whole argument. If the diff is empty, the squash is provably
safe; if it is not, the diff tells you exactly which finding did not survive
the round trip (watch specifically for the `location_scope` generated STORED
column, the organization-first composite indexes from `0002`/F2, and the
composite tenant foreign keys from `0001`/B1 **[V, all three present in the
current SQL]**).

### 4.4 `scripts/verify-migration-chain.sh`

**Not created.** This is the thing that makes "the migration chain applies
cleanly from empty" a command instead of a memory:

```bash
#!/usr/bin/env bash
# Applies drizzle/ to a THROWAWAY database inside the local Docker MySQL and
# prints the resulting schema, normalised for diffing.
#
# Two jobs:
#   1. Prove the chain applies cleanly from genuinely empty. This is what was
#      done by hand on 2026-07-27 and never written down; db/README.md and
#      open-items.md #1 both assert it, and until now nobody could re-run it.
#   2. Prove a squashed baseline produces a byte-identical schema to the chain
#      it replaces (docs/reviews/docker-testing-setup.md §4.3).
#
# NEVER touches `truestock` or `truestock_test`.
#
# Usage: scripts/verify-migration-chain.sh [database-name]
set -euo pipefail

DB="${1:-truestock_chain_check}"
HOST=127.0.0.1
PORT=3307
ROOT_PASS=root

case "$DB" in
  truestock|truestock_test)
    echo "refusing to use '$DB' — pick a throwaway name." >&2
    exit 1
    ;;
esac

echo "verify-migration-chain: recreating '$DB' ..."
docker compose exec -T db mysql -uroot -p"$ROOT_PASS" -e "
  DROP DATABASE IF EXISTS \`$DB\`;
  CREATE DATABASE \`$DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
  GRANT ALL PRIVILEGES ON \`$DB\`.* TO 'truestock'@'%';
  FLUSH PRIVILEGES;"

echo "verify-migration-chain: applying drizzle/ from empty ..." >&2
DATABASE_URL="mysql://root:${ROOT_PASS}@${HOST}:${PORT}/${DB}" bunx drizzle-kit migrate

echo "verify-migration-chain: dumping schema ..." >&2
# --no-data: structure only. AUTO_INCREMENT counters are stripped because they
# legitimately differ between two runs and say nothing about schema shape.
docker compose exec -T db mysqldump \
  -uroot -p"$ROOT_PASS" \
  --no-data --skip-comments --skip-dump-date \
  --set-gtid-purged=OFF \
  "$DB" \
  | sed -E 's/ AUTO_INCREMENT=[0-9]+//g'
```

Worth wiring into CI once it exists, as a step after `docker compose up
--wait`: it turns "the chain applies from empty" from a claim in a markdown
file into a gate.

### 4.5 Exactly what has to change in `scripts/check-migrations-immutable.sh`

The script diffs `drizzle/*.sql` between `merge-base(origin/main, HEAD)` and
`HEAD`. Status `A` (added) passes; **`M`, `D`, and `R` all fail** **[V, the
`case` block]**. A squash deletes three files and adds one, so it produces
three `D` entries and **fails**.

It runs in **two** places — `ci.yml`'s `verify` job and `deploy.yml`'s `verify`
job, both as `bun run check:migrations-immutable` **[V]** — so anything you do
has to cover both.

The minimal honest change is an explicit, named, opt-in escape hatch. Insert
immediately after the `BASE_REF` assignment:

```bash
# One-time pre-launch escape hatch. Migrations are append-only BECAUSE a
# landed migration is a record of what ran against a database that matters
# (open-items.md #6) — and before the first deploy that premise is simply
# false: db/README.md records that nothing has ever been applied to a
# production database. Collapsing 0000..0002 into one clean baseline is the
# last cheap moment to remove the hand-edited 0002 from the history that will
# run in production.
#
# This must be set explicitly on the workflow step, in the squash PR only, and
# removed in the same PR that follows. See docs/reviews/docker-testing-setup.md §4.
if [ "${ALLOW_MIGRATION_SQUASH:-0}" = "1" ]; then
  echo "check-migrations-immutable: SKIPPED — ALLOW_MIGRATION_SQUASH=1 (pre-launch baseline squash)."
  exit 0
fi
```

and, in the squash PR only, on **both** workflows:

```yaml
      - name: Migrations are append-only
        env:
          ALLOW_MIGRATION_SQUASH: "1"   # REMOVE in the next PR. See docs/reviews/docker-testing-setup.md §4.5
        run: bun run check:migrations-immutable
```

Two properties this deliberately keeps:

- **The escape hatch is itself a reviewable diff.** Editing the guard script
  and setting the env var both show up in the PR. That is strictly better than
  the alternative of deleting the CI step, which is easy to forget to restore.
- **Nothing changes about the default.** With the env var unset — which is
  every other PR forever — behaviour is byte-identical to today.

Also update, in the same PR: `db/README.md`'s Migrations section (the
`0000`/`0001`/`0002` bullets, lines ~50 and ~73–96), `docs/open-items.md` #6
(add a line recording the one-time exception), and `docs/reviews/schema-scalability-audit.md`
§0's "Where" column.

**If you choose Option A instead**, change nothing in the script — and add
`bunx drizzle-kit check` to CI so at least the journal's internal consistency
is gated.

---

## 5. Risks and gotchas specific to this stack

### 5.1 mysql2 pool against a container

- `db/index.ts` sets `connectionLimit: 10`, `waitForConnections: true`,
  `queueLimit: 50` **[V]**. The container's `--max-connections=100` in §2.1
  mirrors Hostinger's cap, so a pool that misbehaves fails here the way it
  would fail there.
- **`bun test` will hang at the end of a run unless something calls
  `closePool()`.** The pool is long-lived by design and cached on `globalThis`
  in non-production **[V]**. `db/seed.ts` already does this correctly in a
  `.finally()` **[V]** — copy that shape into the test harness's top-level
  teardown.
- The `globalThis.__truestockPool` cache is keyed on nothing but existence. If
  a test helper ever wants a second connection to `truestock_test` with
  different credentials, it must build its own `mysql.createPool`, not reuse
  `db`.
- `queueLimit: 50` means an overloaded test run **rejects** rather than
  queueing. That is the designed behaviour (schema audit F5) but it looks like
  a flaky test. If you see `Queue limit reached`, the cause is leaked
  connections in tests, not the pool setting.

### 5.2 Authentication — `caching_sha2_password`

MySQL 8.4 disables `mysql_native_password`; 9.0 removed it **[V]**. Your
container's `truestock` user will be `caching_sha2_password`.

**mysql2 3.23.1 handles this over a plain TCP connection with no extra
options** — I read the installed plugin: on `PERFORM_FULL_AUTHENTICATION` over
an insecure connection it sends `REQUEST_SERVER_KEY_PACKET` and RSA-encrypts
the password with the returned public key **[V,
`node_modules/mysql2/lib/auth_plugins/caching_sha2_password.js`]**. No
`allowPublicKeyRetrieval` equivalent is needed — that flag is a JDBC concern.

If you ever *do* need the legacy plugin (some old client, not this app), on 8.4
it is `--mysql-native-password=ON`; on 9.x and later there is no such option
**[V]**.

### 5.3 Better Auth's tables

`db/README.md` is emphatic and correct: Better Auth **must** be constructed with

```ts
advanced: { database: { generateId: "serial" } }
```

because `user`/`session`/`account`/`verification` all use `int AUTO_INCREMENT`
primary keys, and Better Auth otherwise generates string ids client-side
**[V]**. Without it, "inserts through Better Auth will either fail against
these int columns or fall back to the adapter's unreliable best-effort row
matching."

This has **never been run against a real database** (`open-items.md` #1). It is
the single highest-value thing to test the hour the container is up, because a
misconfiguration here means *every auth write fails* — and it fails at sign-up
and sign-in, not somewhere subtle. Test it before anything else.

Related: `user.email` is deliberately globally unique, not per-tenant (invariant
9's stated exception, because Better Auth resolves sign-in by email with no
tenant in hand) **[V]**. A test suite that creates a fresh organization per file
must therefore still use **globally unique emails** — `owner@test.local` in two
files will collide with a duplicate-key error that looks like a tenancy bug and
isn't.

### 5.4 `drizzle-kit migrate` against the container

- `drizzle.config.ts` loads `.env.local` explicitly **[V]**, so
  `bun run db:migrate` picks up the container URL with no extra flags.
- To migrate the *test* database instead, pass the URL inline —
  `DATABASE_URL=... bunx drizzle-kit migrate` — because dotenv will not
  override an already-set environment variable.
- `drizzle-kit migrate` creates and maintains `__drizzle_migrations` **in the
  connected database** **[V]**. Dropping the schema without dropping the volume
  therefore leaves migration bookkeeping in an interesting state; another
  reason §2.6 recommends `down -v`.
- `strict: true` and `verbose: true` are set in the config **[V]** — you will
  get a confirmation prompt on destructive statements. Fine interactively;
  in CI, prefer the throwaway-database script (§4.4) over anything that could
  block on a prompt.
- **A migration that fails halfway leaves you halfway.** MySQL auto-commits DDL
  per statement — `docs/deploy.md` §5 already says this. In the container that
  is a `down -v` away from irrelevant, which is precisely the value of
  rehearsing here.

### 5.5 JSON column round-tripping

`partial_fills` and `partial_fills_delta` are `json NOT NULL DEFAULT ('[]')`,
typed `$type<number[]>()` **[V]**.

I read drizzle's MySQL JSON column implementation: it defines
**`mapToDriverValue` (`JSON.stringify`) but no `mapFromDriverValue`** **[V,
`node_modules/drizzle-orm/mysql-core/columns/json.js`]**. So writes are
stringified by drizzle, and **reads return whatever mysql2 hands back
unmodified**. mysql2 parses JSON-typed columns into JS values by default, so
`partialFills` should come back as a real `number[]` **[R — the parse behaviour
is mysql2's documented default, not something I executed]**.

The consequence worth knowing: this contract depends on mysql2's `jsonStrings`
option staying `false` and on the JSON type flag surviving whichever protocol
path a query takes. `open-items.md` #1 already lists "`partial_fills` JSON
round-tripping" as unverified — **test it explicitly with a non-trivial array
(`[0.3, 0.8, 0.15]`), assert `Array.isArray()`, and assert element order.**
Order matters: the whole reason spec §283 chose a JSON array over a rollup is
that it records what was actually observed, bottle by bottle.

### 5.6 DECIMAL precision

Schema decimals **[V]**: `current_unit_cost`/`unit_cost_at_count`
`DECIMAL(10,4)`, `waste_factor` `DECIMAL(4,3)`, `par_level`/`reorder_point`
`DECIMAL(10,2)`, `total_value` `DECIMAL(12,2)`, weights `DECIMAL(8,2)`.

- No `mode` is set on any of them, so drizzle returns **strings** **[R]**. That
  is the right default — it is what prevents float drift — and `db/seed.ts`
  already writes `wholesaleCost.toFixed(4)` in keeping with it **[V]**.
- The risk is not the round trip; it is **JS arithmetic on those strings**.
  Anything that does `Number(unitCostAtCount) * qty` and sums in float is
  reintroducing exactly the error `DECIMAL` exists to avoid. `CLAUDE.md` names
  plausible-but-wrong numbers as this app's worst failure mode; a valuation
  test should assert an exact string, not `toBeCloseTo`.
- `waste_factor` `DECIMAL(4,3)` holds `0.100` for kegs. Round-trip that
  specific value and assert `"0.100"`, not `0.1` — invariant 10's gross-up
  divides by `1 - waste_factor`.
- **Never coerce a NULL cost to 0** (`db/README.md` is explicit). A test that
  counts an unpriced product and asserts it is *excluded* from `total_value`
  rather than summed as zero is worth writing early.

### 5.7 MySQL 8.x container defaults vs a shared host

This is where a green local test can still lie to you. The container gives you
a pristine, root-owned, single-tenant server. Hostinger gives you a
constrained user on a shared box. Differences to check once, via the read-only
probe in §2.7:

| Setting | Container (as configured) | Shared host | Why it bites |
|---|---|---|---|
| `sql_mode` | MySQL 8 default (`STRICT_TRANS_TABLES`, `ONLY_FULL_GROUP_BY`, …) | often relaxed | A relaxed mode silently truncates instead of erroring. Prod *quieter* than local is the dangerous direction here — a `DECIMAL(4,3)` overflow becomes a clamp instead of a failure. |
| `time_zone` | pinned `+00:00` (§2.1) | unknown **[U]** | Every `timestamp` uses `defaultNow()`. `started_at`/`closed_at` shifting by hours changes which count is "previous" in `previousCountComparison`. |
| `collation_server` | `utf8mb4_0900_ai_ci` | unknown **[U]** | If it is MariaDB, that collation does not exist and `db/README.md`'s `CREATE DATABASE` fails. §2.3's `ALTER DATABASE` is the canary. |
| `max_connections` | 100 (mirrors spec §11) | 100, **shared with the restaurant website** | Local exhaustion only starves you; prod exhaustion starves the other site too. |
| `max_user_connections` | 0 (unlimited) | possibly capped below 100 **[U]** | A per-user cap below the pool's 10 would break the app at idle. |
| Privileges | root; can `CREATE DATABASE`, `SET GLOBAL` | app user, almost certainly cannot | Nothing in `drizzle/*.sql` needs elevated privileges **[V — no `SET GLOBAL`, no `CREATE TRIGGER`, no `SUPER`]**, but keep it that way. Generated columns and composite FKs need no special grant. |
| `lower_case_table_names` | 0 (Linux) | 0 (Linux) | Not an issue — both sides are Linux. It would be if you ever ran MySQL natively on macOS. |
| `innodb_buffer_pool_size` | 256M | larger, shared | Purely performance; does not change correctness. Do not draw timing conclusions from the container. |

Two more, container-specific:

- **The `truestock` container user has `DROP DATABASE`.** Production's will not.
  That is fine and desirable locally, but it means a script that works here can
  fail in production on privilege alone. `verify-migration-chain.sh` uses root
  deliberately and refuses to touch the real databases (§4.4).
- **`local-infile` is off** in §2.1. It is off by default in MySQL 8 anyway;
  making it explicit means a future CSV-import feature that quietly depends on
  `LOAD DATA LOCAL INFILE` fails locally rather than discovering the host
  disallows it.

### 5.8 Two things that will look like Docker bugs and are not

- **"Connection refused" while the container is clearly running.** Almost
  always `localhost` resolving to `::1` on macOS. Use `127.0.0.1` in
  `DATABASE_URL` (§2.4).
- **Tests pass on a warm database and fail on a cold one.** `--wait` blocks on
  the healthcheck; the healthcheck must ping over TCP or it goes green against
  the entrypoint's temporary `--skip-networking` server (§2.1). If you copy a
  healthcheck from elsewhere, copy that detail.

---

## 6. Suggested order of operations

1. Start Docker Desktop. Optionally raise its VM to 4 GB.
2. Land `docker-compose.yml`, the two `docker/mysql/init/*.sql` files, the
   `package.json` scripts, and `scripts/verify-migration-chain.sh`.
3. `bun run db:up && bun run db:migrate && bun run db:seed && bun run create-user`.
4. **Close `open-items.md` #1's application half.** Better Auth's
   `generateId: "serial"` first (§5.3), then the `applyIncrement` replay
   rollback, then `partial_fills` and `DECIMAL` round-trips. These are the
   tests that justify the whole environment.
5. Run `scripts/verify-migration-chain.sh` and confirm the chain applies from
   empty — replacing the unreproducible 2026-07-27 claim with a command.
6. **Decide the squash question** (§4.3) and, if yes, do it now with the §4.4
   diff as proof.
7. Add the Compose steps to `ci.yml` (§3.3) so CI tests against the same
   database definition you do.
8. Only then run the read-only production probe (§2.7) and compare its output
   against the container's — the last honest gate before `hostinger-migrate.sh`
   runs for real.

---

## Sources

- [Docker Desktop install requirements (Mac)](https://docs.docker.com/desktop/setup/install/mac-install/)
- [Docker Desktop release notes](https://docs.docker.com/desktop/release-notes/)
- [Docker Sandboxes — Docker Docs](https://docs.docker.com/ai/sandboxes/)
- [Docker Sandboxes: Run Agents in YOLO Mode, Safely](https://www.docker.com/blog/docker-sandboxes-run-agents-in-yolo-mode-safely/)
- [Docker Sandboxes isolation layers](https://docs.docker.com/ai/sandboxes/security/isolation/)
- [OrbStack FAQ / system requirements](https://orbstack.dev/docs/faq)
- [OrbStack — macOS Ventura (13.x) support issue #2398](https://github.com/orbstack/orbstack/issues/2398)
- [Docker on macOS Ventura — Docker Desktop 4.47.0 on 13.7.8](https://elvisciotti.medium.com/docker-on-mac-os-ventura-apple-silicon-1072e562625f)
- [MySQL official Docker image](https://hub.docker.com/_/mysql) (tags verified via the Docker Hub v2 API, 2026-07-28)
- [MySQL Product Support EOL announcements](https://www.mysql.com/support/eol-notice.html)
- [MySQL 8.0 End of Life — Atlas](https://atlasgo.io/blog/2026/05/05/mysql-8-eol)
- [MySQL 8.4 Reference Manual — Native Pluggable Authentication](https://dev.mysql.com/doc/refman/8.4/en/native-pluggable-authentication.html)
- [What Is New in MySQL 8.4 since MySQL 8.0](https://dev.mysql.com/doc/refman/8.4/en/mysql-nutshell.html)
- [Testcontainers for Node.js](https://node.testcontainers.org/)
- [Testcontainers MySQL module](https://node.testcontainers.org/modules/mysql/)
- [`@testcontainers/mysql` on npm](https://www.npmjs.com/package/@testcontainers/mysql) (12.0.4 confirmed via the npm registry API)
- [bun#21342 — Bun does not work with testcontainers](https://github.com/oven-sh/bun/issues/21342)
- [testcontainers-node discussion #1115 — works in Node, not Bun](https://github.com/testcontainers/testcontainers-node/discussions/1115)
- [drizzle-orm#4897 — \[FEATURE\]: Migration Squashing](https://github.com/drizzle-team/drizzle-orm/issues/4897)
- [Drizzle Kit overview](https://orm.drizzle.team/docs/kit-overview)
- [Collapsing Drizzle SQL migrations](https://scarabcoder.com/collapsing-drizzle-sql-migrations/)

In-repo, read directly: `CLAUDE.md`, `db/README.md`, `db/index.ts`,
`db/schema.ts`, `db/seed.ts`, `drizzle.config.ts`, `drizzle/0000_elite_nightmare.sql`,
`drizzle/0002_wet_abomination.sql`, `drizzle/meta/_journal.json`, `package.json`,
`.env.example`, `.gitignore`, `scripts/run-tests.sh`,
`scripts/check-migrations-immutable.sh`, `scripts/hostinger-migrate.sh`,
`lib/domain/db-errors.ts`, `docs/deploy.md`, `docs/open-items.md`,
`docs/reviews/schema-scalability-audit.md`, and the installed
`node_modules/{drizzle-kit,drizzle-orm,mysql2}`.
