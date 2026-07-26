# Handlebar — Deploy runbook

Read `CLAUDE.md` and `docs/spec.md` §11 first if you haven't. This is the
operational half of that plan: what to click in hPanel once, what secrets
to add once, and what happens automatically after that.

**Scope note:** this document assumes the Hostinger Cloud Startup plan
already exists, per CLAUDE.md — it does not cover buying hosting.

---

## 1. The deploy-method decision

**Decision: build in GitHub Actions, ship the prebuilt `output: 'standalone'`
artifact to Hostinger's Node.js hosting via its archive-deploy API. Do not
use Hostinger's GitHub-integration auto-build.**

### What was actually investigated (not assumed)

Both of Hostinger's documented deploy paths were checked against their
current, live documentation and a real API definition — not against
training-data memory of what Hostinger's panel used to look like:

- **GitHub integration** ("connect a repo, auto-build on push"): confirmed,
  as of the current Hostinger help article ("How to add a Node.js Web App
  in Hostinger"), that the `npm` build commands run **on Hostinger's own
  infrastructure** on every push — this is the exact shared-compute risk
  spec §11 flags (`next build` spiking over 1GB against the 3GB pool shared
  with the restaurant site).
- **Hostinger's public API** (`hostinger/api`, currently in beta) exposes
  `POST /api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/builds/
  from-archive`. Its own documentation states the same thing — "the build
  process runs the install step automatically" — but the request schema
  (confirmed by reading the generated TypeScript SDK's actual client code,
  not just its docs) accepts override fields: `build_script`,
  `entry_file`, `root_directory`, `output_directory`, `node_version`,
  `package_manager`. Those overrides are the lever this decision relies on:
  ship the artifact that `next build` already produced in CI, and give
  Hostinger's own build step a no-op script to run instead of a second
  `next build`. Hostinger's install pass still runs (installing a handful of
  already-vendored production dependencies against a folder that already
  has them, per `output: 'standalone'`), but the actual multi-hundred-MB,
  1GB+-spiking compile step never touches the shared box.

### What was verified vs. what is assumed

**Verified by hitting real endpoints while writing this** (2026-07-26):
- The GitHub Security Advisory data for Next.js in §4 below (via
  `api.github.com/repos/vercel/next.js/security-advisories`).
- Hostinger's own current Node.js hosting article content (fetched live).
- The `createNodeJSBuildFromArchiveV1` request/response shape, straight from
  `hostinger/api-typescript-sdk`'s generated client — including the
  non-obvious fact that despite uploading a binary archive, the request body
  is `application/json` with the archive **base64-encoded inline**, not
  multipart form data.
- SSH access is available on Hostinger's Cloud hosting plans (Hostinger
  support: "How to connect to a hosting plan remotely using SSH").
- Node.js 22 satisfies both Next 16.2.11's `engines.node >=20.9.0` and
  Hostinger's supported Node versions (18.x/20.x/22.x/24.x).

**Assumed, not tested against a live account** (no Hostinger credentials
were available while building this pipeline):
- That Hostinger's automatic install pass against an already-populated
  `node_modules` is meaningfully cheaper than a real `next build`. This is
  almost certainly true (installing already-resolved production deps is a
  different order of magnitude of work than running Next's compiler), but
  the actual memory/time cost on Hostinger's shared box has not been
  measured. **Watch the per-app Resource Usage graph in the Node.js
  dashboard after the first real deploy.**
- That Hostinger's framework auto-detection still recognizes the shipped
  archive as a Next.js app (it still contains `.next/`, and `next`/`react`
  in `package.json`, just not a top-level `next.config.ts` or `app/`
  source tree). `scripts/hostinger-deploy-archive.py` deliberately leaves
  `app_type`/`output_directory`/`root_directory` on auto-detect rather than
  guessing an enum value that isn't documented anywhere; if the first real
  deploy's build logs show it guessed wrong, add the override there.
- The exact JSON shape of the "list builds" pagination envelope
  (`scripts/hostinger-poll-build.py` tries both a bare array and a `data`
  key).
- The 50MB archive size limit is checked by the packaging script before
  upload, but the actual size of this app's standalone bundle has not been
  measured against a live build (the working tree has an unrelated,
  in-progress typecheck error from a parallel track, so a full `next build`
  couldn't be run here — see the CI job for the first real measurement).

### The tradeoff, stated plainly

This is more moving parts than clicking "Connect GitHub" in hPanel: three
GitHub Actions jobs, an SSH tunnel for migrations, and a beta API whose
edge cases haven't been exercised. The alternative — letting Hostinger
build from source on every push — is genuinely simpler to set up and is a
supported, documented path if the shared-box build spike turns out not to
matter in practice for an app this size. If the archive-deploy pipeline
below causes more operational pain than the resource risk it's avoiding,
switching to plain GitHub integration is a one-time hPanel change (Connect
GitHub on the Node.js app) and deleting `.github/workflows/deploy.yml` —
not a rewrite.

---

## 2. One-time hPanel setup (you do this by hand — no API for it)

I have no Hostinger credentials and shouldn't try to get any. Everything in
this section is a UI click-path, not something the deploy pipeline can do
for you.

1. **Create the MySQL database.**
   hPanel → *Databases → MySQL Databases* → create a database named
   `handlebar` and a database user with a generated password. Note the
   database name, username, and password — you'll need all three twice
   (once for the app's own `DATABASE_URL`, once for the migration secrets
   in §3).

2. **Create the Node.js Web App entry.**
   hPanel → *Websites* → *Add Website* → *Deploy Web App*. Pick **any**
   initial source just to create the app record (a throwaway file upload,
   or connect GitHub once and disconnect it afterward) — the ongoing
   deploy pipeline talks to this app via its API, not through whatever
   source method you pick here. Framework type: Next.js (or "Other" if
   auto-detect doesn't offer it; if so, set entry file to `server.js`).
   Node.js version: **22.x**.

3. **Point the subdomain at it.**
   During or after app creation, set the domain to `handlebar.<yourdomain>`.
   SSL auto-provisions on Hostinger Cloud plans — confirm the padlock shows
   up after the first successful deploy; camera/barcode APIs refuse to run
   without it.

4. **Set the app's environment variables.**
   Node.js app dashboard → *Environment Variables*. Add:
   | Key | Value | Why |
   |---|---|---|
   | `DATABASE_URL` | `mysql://<user>:<password>@localhost:3306/handlebar` | Read lazily by `db/index.ts` — never at build time |
   | `BETTER_AUTH_SECRET` | output of `openssl rand -base64 32` | Session signing |
   | `BETTER_AUTH_URL` | `https://handlebar.<yourdomain>` | Better Auth's own base URL |
   | `NODE_ENV` | `production` | Standalone's `server.js` does not set this itself |

5. **Enable SSH and add a deploy key.**
   hPanel → *Advanced → SSH Access* → enable it, note the host/port/username
   it gives you. Then add a **dedicated** SSH keypair (don't reuse your
   personal one) generated just for CI:
   ```
   ssh-keygen -t ed25519 -f handlebar-deploy-key -C "handlebar-ci"
   ```
   Add `handlebar-deploy-key.pub` in hPanel's SSH Keys section. The private
   key (`handlebar-deploy-key`, no passphrase — CI can't type one) becomes
   the `HOSTINGER_SSH_PRIVATE_KEY` GitHub secret in §3. This key only ever
   needs to open a local port-forward to `127.0.0.1:3306` on the box — it
   does not need to do anything else, so don't reuse it elsewhere.

6. **Generate a Hostinger API token.**
   hPanel → profile icon → *API* (or `hpanel.hostinger.com/profile/api`).
   Create a token scoped to this account. This becomes `HOSTINGER_API_TOKEN`.

---

## 3. GitHub repository setup

### Secrets (Settings → Secrets and variables → Actions)

| Secret | Value | Used by |
|---|---|---|
| `HOSTINGER_API_TOKEN` | token from §2.6 | deploy, rollback |
| `HOSTINGER_USERNAME` | Hostinger account username (the `{username}` in the API path — same string SSH login uses) | deploy, rollback |
| `HOSTINGER_DOMAIN` | `handlebar.<yourdomain>` | deploy, rollback |
| `HOSTINGER_SSH_HOST` | host from §2.5 | migrate |
| `HOSTINGER_SSH_PORT` | port from §2.5 (often a non-default port like `65002`) | migrate |
| `HOSTINGER_SSH_USER` | SSH username from §2.5 | migrate |
| `HOSTINGER_SSH_PRIVATE_KEY` | the private key file contents from §2.5 | migrate |
| `HOSTINGER_DB_USER` | MySQL user from §2.1 | migrate |
| `HOSTINGER_DB_PASSWORD` | MySQL password from §2.1 | migrate |
| `HOSTINGER_DB_NAME` | `handlebar` | migrate |

None of these are read by the app itself — the app's own env vars live in
hPanel (§2.4). These are exclusively for the pipeline.

### Workflows (already committed)

- `.github/workflows/ci.yml` — every push and PR: `bun install`, typecheck,
  lint, test, the migrations-immutable check, `next build`. Must be green.
- `.github/workflows/deploy.yml` — push to `main` only: `verify` →
  `migrate` → `build-and-deploy`, each gated on the last.
- `.github/workflows/rollback.yml` — manual (`workflow_dispatch`), redeploys
  a previously-published build artifact with no rebuild.

---

## 4. First deploy — bootstrap order

The automated pipeline **only ever runs `drizzle-kit migrate`**. Seeding the
catalog and creating the first owner account are one-time, deliberate,
human-run actions — `scripts/create-user.ts` says so in its own header
("run from a trusted machine/shell only... never expose this as a route
handler or server action"), and it prompts interactively for a password,
which has no sane place in an unattended pipeline. Automating it would
undercut the exact safety property that script is built around.

Do this once, from your own machine, after §2 and §3 are done:

1. **Open a tunnel to production MySQL** (same pattern as
   `scripts/hostinger-migrate.sh`, run by hand instead of by CI):
   ```bash
   ssh -i handlebar-deploy-key -p <HOSTINGER_SSH_PORT> \
     -L 13306:127.0.0.1:3306 <HOSTINGER_SSH_USER>@<HOSTINGER_SSH_HOST>
   ```
   Leave that running in one terminal.

2. **In another terminal, point at it and migrate, seed, create the owner:**
   ```bash
   export DATABASE_URL="mysql://<db-user>:<db-password>@127.0.0.1:13306/handlebar"
   bun run db:migrate
   bun run db:seed
   bun run create-user -- --email you@yourbar.com --name "Your Name" --role owner
   ```
   `create-user` will prompt for a password (hidden input) unless you pass
   `--password`, which you shouldn't — it lands in shell history.

3. **Push to `main`.** From here on, every push runs the full
   `verify → migrate → build-and-deploy` pipeline with no manual steps.

---

## 5. Ongoing deploys

Push to `main` → GitHub Actions:
1. **`verify`** — typecheck, lint, test, migrations-immutable check. Any
   failure stops here; nothing else runs.
2. **`migrate`** — tunnels over SSH, runs `drizzle-kit migrate` against
   production. Only applies migration files that haven't run yet
   (drizzle-kit tracks this itself via `drizzle/meta/_journal.json`).
3. **`build-and-deploy`** — `next build`, packages the standalone output,
   uploads it to Hostinger via the archive API, polls until the build
   finishes, restarts the app, and publishes the artifact as a GitHub
   Release (`deploy-<short-sha>`) for rollback.

### What breaks if the deploy fails halfway

- **`verify` fails:** nothing happens. The site keeps serving whatever was
  last deployed successfully. Safest failure mode.
- **`migrate` fails partway through a single migration file:** this is the
  one genuinely dangerous case. MySQL auto-commits DDL per statement — it
  does not support the same transactional-DDL rollback you'd get with some
  other databases — so a migration file with multiple statements that fails
  on, say, its third `ALTER TABLE` leaves the schema in a state that
  matches **none** of your migration files. The **app is not yet
  redeployed** at this point (that's the next job), so the previously
  running code is still live against a half-migrated schema — which may or
  may not be compatible, depending on what the migration was doing. This is
  exactly why migrations should stay small and single-purpose (one
  additive change per file) — the blast radius of a partial failure is
  bounded by how much one file does. Recovery is manual: inspect what
  actually applied (`SHOW CREATE TABLE ...`), and hand-write a follow-up
  migration that reconciles it — never edit the failed file in place
  (open-items.md #6).
- **`build-and-deploy` fails at the Hostinger API/build step:** the previous
  build stays live — Hostinger's build-state model (pending/running/
  completed/failed) is designed around exactly this; a failed build is not
  documented to interrupt a currently-running one. (Noted as assumed rather
  than independently verified against a real failure — see §1.) The
  database has already migrated, though, which is safe exactly because
  migrations in this project are meant to be backward-compatible additions
  the *previous* app version can tolerate running against (the standard
  "expand" half of an expand/contract migration discipline) — don't ship a
  migration that the currently-deployed code can't survive sitting next to
  for a few minutes.
- **The restart call fails:** per Hostinger's own docs, a completed build
  already restarts the server; the explicit restart step here is a
  safety net for picking up env var changes, not a required step. If it
  fails, the new build is very likely already serving.

### Security patching — ongoing, not one-time

CLAUDE.md is explicit that patching is on us; there's no platform-side
mitigation on self-hosted Hostinger. Two standing duties, not closed items:
- Re-run the check in §6 (or just re-fetch
  `api.github.com/repos/vercel/next.js/security-advisories`) whenever you
  bump `next` in `package.json`, and before any bump, not just after.
- `images: { unoptimized: true }` is load-bearing for a second reason beyond
  hosting footprint: it's what keeps `sharp`'s libvips CVEs dormant, since
  disabling Next's built-in optimizer means `sharp` is never invoked as an
  image processor. Don't flip it back on without re-auditing that
  dependency first (open-items.md #5).

---

## 6. Next.js version — advisory finding (open-items.md #5)

**Finding: `next@16.2.11` (currently pinned exactly in `package.json`) is
already patched against every advisory in the July 2026 batch.**

Verified 2026-07-26 directly against `api.github.com/repos/vercel/next.js/
security-advisories` (not assumed from memory of the npm `latest` tag):

| Advisory | Severity | Fixed in |
|---|---|---|
| GHSA-p9j2 — SSRF in rewrites via attacker-controlled hostname | High | 16.2.11 |
| GHSA-89xv — SSRF in Server Actions on custom servers | High | 16.2.11 |
| GHSA-6gpp — Middleware/Proxy bypass (Turbopack, single locale) | High | 16.2.11 |
| GHSA-m99w — DoS in Server Actions | High | 16.2.11 |
| GHSA-4c39 — Unbounded Server Action payload (Edge runtime) | Medium | 16.2.11 |
| GHSA-68g3 / GHSA-4633 — Response-body cache confusion (2 advisories) | Medium | 16.2.11 |
| GHSA-955p — Unauthenticated disclosure of internal Server Function endpoints | Medium | 16.2.11 |
| GHSA-q8wf — DoS in Image Optimization API via SVGs | Medium | 16.2.11 (also moot here — `images.unoptimized: true`) |

All nine were published 2026-07-21 with the fix landing in the same
version, `16.2.11` — which is exactly what's installed. There is a newer
`16.2.12` on npm's `latest` tag (released 2026-07-25), but its changelog is
docs/TypeScript-7-support backports only, no security content — not
required.

**No action needed right now.** This is a point-in-time finding, not a
standing guarantee — re-check on every future bump, per §5.

---

## 7. Connection pool — confirmed, not changed

`db/index.ts` sets `connectionLimit: 10` explicitly (`POOL_CONNECTION_LIMIT`
constant, top of the `createPool` function), at the top of spec §11's 5–10
range, with a comment explaining why it's explicit rather than left at the
driver default. `db/README.md`'s "Connection pool" section already documents
the 100-connection shared ceiling and the "don't raise this, question the
query pattern instead" rule. Nothing here needed changing — this section
exists to record that it was checked, not to change it.

---

## 8. Rollback

```bash
gh release list --limit 20   # find a deploy-<sha> tag from before the bad deploy
gh workflow run rollback.yml -f sha=<short-sha>
```

One command, per the brief. It redeploys that exact previously-built
archive — no rebuild, so it works even if the old commit's dependencies
wouldn't install cleanly today. It rolls back **application code only**;
see the caution in `.github/workflows/rollback.yml`'s header about why a
schema rollback isn't part of this and isn't safe to automate the same way.
