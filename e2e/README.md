# Truestock e2e suite

Playwright **test-runner** specs that drive a *running production build* in a
real browser. They exist because a 200 is not evidence a page works: the CSP
hydration break and the login credential leak were both invisible to status
codes. The older `scripts/verify-browser*.mjs` scripts are untouched and still
the way to do exploratory, one-off checks; this suite is the repeatable one.

## Run it

The suite needs an app and a database that already exist (it does not start
them), then:

```sh
E2E_ENV_FILE=/path/outside/the/repo/e2e.env bun run e2e          # desktop + mobile, one run
E2E_ENV_FILE=... bun run e2e:desktop                             # desktop only
E2E_ENV_FILE=... bun run e2e:mobile                              # emulated Pixel 7 in local Chromium
E2E_ENV_FILE=... bun run e2e:phone                               # REAL phone over CDP (below); dev/QA only, never CI
E2E_ENV_FILE=... bun run e2e:desktop -- office-catalog           # one spec
bun run e2e:report                                               # open the last HTML report
```

**CI** (`.github/workflows/ci.yml`, job `e2e-smoke`) runs the same two commands
the developer does, as two steps: the whole `desktop` project, then the whole
`mobile` project. There is no spec list in CI; a new spec runs there as soon as
it lands, in whichever projects `playwright.config.ts` allows it. The `phone`
project is a development and QA run only: CI never sets `E2E_PHONE_CDP`, and
`bun run e2e:phone` refuses to start when `CI` is set.

`bun run e2e` is `playwright test` (the 1.49.1 runner bundled in `playwright`;
`@playwright/test` is not a dependency). Without `bun`, use
`node node_modules/playwright/cli.js test`.

Configuration is environment variables; names only here, values never in the repo
(see `.env.e2e.example`):

| Name | Meaning |
|---|---|
| `E2E_ENV_FILE` | optional path to a file of `NAME=value` lines, loaded before anything else; real environment wins |
| `E2E_BASE_URL` | app under test, loopback only; default `http://localhost:3101` |
| `E2E_DATABASE_URL` or `DATABASE_URL` | the database that app writes to (`E2E_` wins) |
| `E2E_OWNER_EMAIL` / `E2E_OWNER_PASSWORD` | one account per role, likewise `E2E_MANAGER_*`, `E2E_STAFF_*` |
| `E2E_PHONE_CDP` | optional: DevTools endpoint of a real Android Chrome (`http://127.0.0.1:9333`); when set, a third project `phone` exists. `bun run e2e:phone` defaults it |
| `E2E_CHANNEL` | optional: `chrome` to use installed Chrome instead of bundled Chromium |

A role with no credentials is not a failure and not silent: its specs skip with a
`NOT VERIFIED: <role> credentials absent` line. **Skipped means unverified, never
passed.** A skipped spec in the report is a hole, so the suite never uses skip for
"does not apply" (those are excluded per project in `playwright.config.ts`).
Under `CI` or `E2E_REQUIRE_ALL=1` the same condition fails global setup instead,
so a pipeline with no secrets cannot go green with every role-gated spec skipped.

## The phone project (real device)

`bun run e2e:phone` runs the mobile specs in the Chrome of a real Android phone
attached over adb (`bun run phone:rig up` makes the DevTools forward on 9333).
The project exists only while `E2E_PHONE_CDP` is set, so plain runs and CI never
need a device (do not export it in your shell profile: a bare `bun run e2e`
would then include the phone). Its `browser` fixture
(`e2e/support/fixtures.ts`) connects with `connectOverCDP` and only disconnects
at the end (the phone's Chrome stays open). Android refuses
`Browser.setWindowBounds`, so contexts use `viewport: null` and the phone's own
screen. Its `context` fixture sets `navigator.virtualKeyboard.overlaysContent`
so the soft keyboard draws over the page instead of panning the visual
viewport; without it, Playwright's click after a `fill` lands off target (the
login specs time out). The app must be served to the phone against the e2e database; the full
procedure is in `docs/phone-count-test.md`, "Playwright on the phone".

## Building the rig

The compose stack (`docker compose up -d`) must already be running; the rig
borrows its network and its `node_modules` volume. From the checkout you want to
test:

```sh
cp .env.e2e.example /path/outside/the/repo/e2e.env   # fill it in; keep it out of git

export E2E_ENV_FILE=/path/outside/the/repo/e2e.env
bash scripts/e2e-rig.sh db      # create truestock_e2e, migrate, seed the catalog
```

Then create the three accounts yourself (the script never handles passwords);
each prompts for the password, and the same passwords go in the env file:

```sh
export DATABASE_URL=mysql://truestock:truestock@127.0.0.1:3307/truestock_e2e
bun run create-user -- --email owner@example.test   --name "E2E Owner"   --org truestock --role owner
bun run create-user -- --email manager@example.test --name "E2E Manager" --org truestock --role manager
bun run create-user -- --email staff@example.test   --name "E2E Staff"   --org truestock --role staff
```

```sh
# optional: one invoice with a stored file, so the roles spec's owner check
# runs instead of skipping (same INVOICE_STORAGE_DIR the app container uses)
INVOICE_STORAGE_DIR=/abs/path/from/your/e2e.env node scripts/e2e-seed-invoice.mjs
bash scripts/e2e-rig.sh prod    # ~5 min build; then wait for /login to answer 200
bun run e2e
bash scripts/e2e-rig.sh down    # remove the throwaway containers
```

`INVOICE_STORAGE_DIR` is bind-mounted at the same path inside and outside the
container; if the suite and the app disagree about it, invoice-file specs fail as
phantom 404s rather than as an error. Sign-in is rate limited, so a run that signs
in repeatedly (the older `scripts/verify-browser*.mjs` do) can hit 429; this suite
signs in once per role.

## Rig assumptions

- A production-mode container (nonce CSP, real hydration) on `localhost:3101`,
  backed by MariaDB on `127.0.0.1:3307`, database `truestock_e2e`, seeded with the
  catalog (100 products) and one owner, manager and staff account.
- The Docker rig, not `next dev`: dev reloads the page when the network drops and
  skips the CSP, so it would test a different app.
- Chromium only (the phone project is Chrome on Android), `workers: 1`, no retries. Specs share one database and
  `resetCounts()` deletes every count in it, so parallel workers would delete each
  other's fixtures.

## Safety guards (mandatory, not configurable)

Run in global setup **and** again whenever the DB pool is built
(`e2e/support/guard.ts`). The suite refuses to start unless all hold:

1. the app URL host is loopback;
2. the database host is loopback;
3. the database **name ends in `_e2e`**.

Those three check the two URLs separately. They cannot show that the app at
`E2E_BASE_URL` writes to that database (a loopback dev server on the real
`truestock` database passes all three), so global setup also requires every
sign-in to add a `session` row to the `_e2e` database and refuses to continue
otherwise.

Errors carry host, port and database name only, never credentials. There is no
flag to skip this: `resetCounts()` is destructive by design.

## Layout

```
playwright.config.ts      projects: mobile (Pixel 7, 390x844, touch), desktop (1280x800), and phone (real device over CDP, only when E2E_PHONE_CDP is set)
e2e/global-setup.ts       guards, then signs each role in ONCE -> e2e/.auth/<role>.json
e2e/support/              env, guard, db (raw SQL ground truth), fixtures, problems,
                          hydration, auth, count (UI drivers + fake camera)
e2e/specs/*.e2e.ts        the specs
```

**Why `.e2e.ts` and not `.spec.ts`.** `bun test` and `scripts/run-tests.sh` pick
up `*.test.ts` / `*.spec.ts`; a Playwright file loaded by bun's runner fails at
import. The distinct suffix keeps the two runners apart (`bun test e2e` finds no
tests).

## Specs

| Spec | Project | What it proves |
|---|---|---|
| `smoke` | all | login form is a hydrating POST form; wrong password is generic; owner signs in; signed-out access redirects; every office page loads without console/CSP errors |
| `roles` | all | staff and manager receive no cost data in HTML or the RSC payload (invariant 8), with an owner-side positive control for each; invoice-file route is 401 / 403 / 200-or-404 (invariant 7) |
| `count-flow` | mobile, phone | start, pick a section, search, enter quantity, save: one line, one ledger row; same bottle again increments (invariants 3 and 5); SET states its consequence; tenths location takes Half |
| `phone-round2` | mobile, phone | the three phone-test fixes. Proven to fail when the code is reverted: no stale hub after Back (production build), enroll form says why Save is off. Pins the contract with **no proven teeth**: Save stays disabled once tapped, the in-app Back links (see `docs/open-items.md` item 41) |
| `office-catalog` | desktop | TanStack table paging and sorting; owner inline cost edit reaches the database and survives reload; known-defect probe |
| `vendors-retire` | desktop | retire and reactivate a vendor in two taps (#49); a retired vendor's name is refused with the reactivate message; the invoice-upload picker omits it |

CI runs every spec in its desktop and mobile projects; `phone` is run by hand (dev/QA).

Ground truth for count specs is the database, never the same screen under test:
an optimistic card on screen proves nothing about invariants 3 and 5.

## How the specs fail on purpose

- Most regression tests carry a comment naming the source change that makes them
  fail. Where that was actually run, the comment says so; where it is by analysis
  only, it says that instead; some tests (parts of `smoke` and `count-flow`) name
  none. `docs/open-items.md` item 41 lists which mutations were really run.
- Console errors, `pageerror` and CSP violations fail the test unless the spec
  allow-lists them (`problems.allow`). Sign-in tests allow 401/429 because Chrome
  logs failed responses as console errors.
- `page.waitForFunction` is not used (the production CSP has no `unsafe-eval`);
  waits poll with `page.evaluate` instead.
- Sign-in is rate limited (3 per 10 s), hence one sign-in per role in global setup.

## Known defects the suite records

- `office-catalog` has a KNOWN DEFECT probe: the inline cost cell never shows its
  "Saved" confirmation (the cell remounts after `patchRow`). The value persists;
  only the confirmation is lost. The probe first proves the save reached the
  database, then asserts "Saved" does not appear. It deliberately does not use
  `test.fail()`, which would also swallow a broken selector or a setup error. When
  the cell is fixed, its last assertion fails; flip it to `toBe(true)`.

## Generated files (all gitignored)

`e2e/.auth/` (session cookies; treat as secrets), `test-results/`,
`playwright-report/`. Traces are retained only on failure. Delete them after a run
on a shared machine.
