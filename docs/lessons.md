# Truestock — lessons behind the rules

`AGENTS.md` states each rule in a line or two, because it is loaded into every
session. This file holds the **why**: the incident, the failure mode, and the
reasoning that makes each rule non-negotiable. Moved here verbatim from
`AGENTS.md` on 2026-11-08 (see `docs/sdlc-playbook-map.md`, Tier 1.1) — nothing
was deleted, only relocated. Headings match the rule names in `AGENTS.md`.

**Read the relevant section before changing anything a rule touches**, and before
arguing that a rule is unnecessary: most of them exist because the "obvious"
alternative already shipped once and was wrong.

When a new lesson is learned: put the one-line rule in `AGENTS.md`, and the story
here under a matching heading. The playbook's rule of thumb — *when Claude makes the
same mistake twice, the correction goes into CLAUDE.md* — applies to the one-liner;
the narrative belongs here.

---

## The CSP lives in middleware, with a nonce

**The CSP is served from `middleware.ts` with a per-request nonce, and must
never move back into `next.config.ts`'s `headers()`.** Next's App Router
delivers the request id (`self.__next_r`) and the streamed RSC payload
(`self.__next_f.push`) as *inline* `<script>` tags. A static header cannot
carry a nonce, so `script-src 'self'` blocks both and **nothing on any page
hydrates**. Setting it in both places is worse than either alone: browsers
intersect multiple CSP headers, so the nonce-less one keeps blocking.
This is not hypothetical — it shipped in and was caught only by opening a
browser (2026-07-28). The failure is silent by construction: the server
renders correctly and returns 200, so `curl`, `next build`, the `/ship` gate
and every status-code check pass against a completely inert app. **A 200 is
not evidence that a page works.** Note also that Chrome reports CSP
violations through a channel the devtools console API does not carry, so the
absence of a "Refused to execute inline script" message proves nothing.

> **Observed 2026-11-08, Next 16.4.3.** With a static `Content-Security-Policy`
> added to `next.config.ts` `headers()` *alongside* the middleware's, only **one**
> CSP header was served — the middleware's — and every page hydrated. So on this
> Next version "both places" does not intersect; the middleware's header wins.
> The rule is unchanged: a static CSP *alone* (middleware removed or bypassed) is
> still the 2026-07-28 break, and nothing guarantees the precedence holds across
> Next upgrades. What does reproduce the break today is a nonce-less `script-src`
> in `lib/csp.ts`; the CI `e2e-smoke` job was mutation-checked against exactly
> that and fails with `"form" never hydrated`.

## The database is MariaDB, not MySQL

**The database is MariaDB, not MySQL — corrected 2026-07-28.** hPanel's menu says
"MySQL Databases" and every document in this repo took that at face value.
`SELECT VERSION()` against the real host returns `11.8.8-MariaDB-log`. Local
development runs `mariadb:11.8` in Docker (`docker-compose.yml`) so the gate
tests the engine production actually runs.

What does **not** change, and should not be "fixed": the driver stays `mysql2`,
drizzle's dialect stays `"mysql"`, and `DATABASE_URL` keeps the `mysql://`
scheme. All three are correct for MariaDB — it speaks the MySQL wire protocol.

The schema was re-verified on MariaDB 11.8 and is portable: migrations apply
clean from empty, the `product_par` generated column still rejects a second
overall par (1062), composite tenant foreign keys still reject a cross-tenant
id (1452), and `DECIMAL(10,4)` round-trips exactly.

One real difference to keep in mind: **MariaDB has no native JSON type** —
`JSON` is an alias for `longtext`. `partial_fills` still comes back as a parsed
array because mysql2 parses it, and drizzle has no `mapFromDriverValue` of its
own for MySQL JSON. That makes the guarantee a *driver* one, not a schema one,
so it must be covered by a test rather than assumed after a driver bump.

## Two decisions that changed the shape of this, 2026-07-27

**This is going to be sold, so it is multi-tenant** \(invariant 9\). Done before
the first migration ever ran, because tenant isolation is the one thing that is
cheap now and a data migration plus a full invariant re-audit later. What is NOT
built: a user belonging to more than one organization, an org switcher, billing,
signup, or per-tenant subdomains. One org per user, seeded by hand. All of that
is additive.

**Invoice automation is built in Phase 2.5** — it requires AI \(OCR\) and
file storage \(two-year retention, spec §10\). The xtraCHEF subscription is not
used; costs are captured from supplier invoices through the pipeline built in
Phase 2.5. It covers secure upload and archive, pdf-inspector for text PDFs,
Claude Vision for scanned/mixed documents, arithmetic checks, human review,
vendor-alias matching, atomic cost posting, and the limited audit export named
above. Deposits are never folded into product cost. Auto-approval stays off
until about 100 real invoices provide correction data. The full Phase 2.5
product metric — 20–25 real invoices reviewed in under 30 minutes — is still a
field measurement, not a claim made by the implementation alone.

## A plausible-but-wrong default

**A plausible-but-wrong default is more dangerous than an obviously broken
one, and this is not hypothetical — see "Draft beer" below.** The enroll
form's keg size once defaulted to 750 ml, which is absurd on sight and
self-correcting: nobody ships a keg count that small. It was changed to
58674 (a half barrel), which looks like a real keg and is wrong for 7 of the
9 kegs this bar actually stocks — and the whole point of a preselected
default on a 20-second enroll form is that the counter is not expected to
check it. The fix is not "pick a better guess"; it is deriving the default
from the seed catalog and asserting it in a test, so the default and the
catalog cannot drift apart silently again.

## Invariant 6 — `active = false` on the write path

**And `active = false` must be enforced on the WRITE path, not only excluded
from reads.** Excluding a row from a list query does not stop writes to it: a
client that loaded the row before it was deactivated still holds a valid id,
and its next write succeeds silently. This shipped for locations on 2026-08-12
and was caught in review — retiring a location removed it from the scan picker
on a *fresh fetch*, but the scan screen fetches locations once and holds them
per leg by design, so a counter mid-session kept writing into a retired
location with no error anywhere. The `active` check belongs in the write path,
**above** any existing-row lookup so it runs on every write and not just the
insert. A "refuses retirement while in use" guard is not a substitute — a
client that has loaded the row but not yet written leaves nothing to detect.

> **2026-11-08:** the same gap for *products* (`docs/known-defects.md` #1) was
> closed in `lib/domain/counts.ts` `upsertCountLineRow` — `PRODUCT_RETIRED`,
> checked beside the retired-location check, above the existing-line lookup.

## Invariant 9 — tenant scoping

**Every query is scoped to one organization.** `organization` is the tenant
boundary. `Actor.organizationId` comes from `requireSession`, re-read from the
database on every call and never from client input. Every domain read filters on
it; every write stamps it. A cross-tenant lookup returns `NotFound`, never an
answer that confirms the row is real.
Client-supplied ids (`productId`, `locationId`, `countId`, `countLineId`) are
**ownership-checked, not just existence-checked** — a foreign key proves a row
exists, not whose it is. That gap was a real finding in review: an unchecked
`locationId` leaked another tenant's location name.
Two constraints are deliberately NOT per-tenant, and both should stay that way:
`user.email` (Better Auth resolves sign-in by email with no tenant in hand) and
`count_line_write.client_line_id` (a v4 UUID that *is* the idempotency
mechanism — scoping it would make the guarantee depend on the retry carrying a
matching org).

## Invariant 10 — the waste factor

**Draft depletion is grossed up by the waste factor.** A 16 oz pour draws
`16 / (1 - waste_factor)` ≈ 17.8 oz from the keg. Theoretical usage that ignores this
makes every keg look ~10% short and turns the variance report into false positives.
Applies to *theoretical depletion only* — never to counted inventory, which is measured
as it actually is.

The column, as it was specified before the schema existed (formerly "Schema delta
not yet in docs/spec.md §8" in `AGENTS.md`; it is now in spec §8 and `db/schema.ts`):

```
waste_factor   DECIMAL(4,3)   NOT NULL DEFAULT 0.000
```

Draft products get `0.100`. Bottles and wine stay `0.000`. Theoretical depletion then
computes as `pour_ml / (1 - waste_factor)`. One column now versus a migration and a
recount later. Update §8 of the spec when you touch it.

## Invariant 11 — deactivation revokes sessions

**Deactivating a user revokes their sessions in the same transaction.** Setting
`active = false` and deleting that user's `session` rows happen inside one
`db.transaction` — never one without the other. `lib/authz.ts` already re-reads
`active` on every request and refuses an inactive account, so this is defence in
depth: it closes the window where a session row minted before deactivation is still
a valid Better Auth credential. Enforced in `lib/domain/users.ts` and covered by
`tests/user-write-path.test.ts` against a real MariaDB (mutation-checked: removing
the session delete fails exactly the revocation test). The mirror of invariant 6 —
users, like products, are deactivated, never hard-deleted; history references them.

## `case_size` is for bottled beer, not liquor

**`case_size` applies to bottled beer, not liquor.** Liquor is counted as bottles —
eaches and partial fills — so `case_size` stays NULL for all 62 spirits, the 2 liqueurs,
5 wines and 3 NA, and that is correct rather than missing data. Only the **16 bottled
beers** are counted both ways and need a case size. Draft kegs don't either: a keg is one
unit measured in tenths.
This matters because `computeLineUnits` only treats a NULL `case_size` as indeterminate
when `sealed_case_qty > 0` — "zero cases of an unknown size" is unambiguously zero. So a
NULL case size on liquor never excludes a line. Do not "fix" the catalog by backfilling
case sizes onto spirits; that would invent a pack level the bar doesn't use.

## The active location is locked per leg

**The active location is locked per leg, with an escape hatch.** A count covers all five
locations, but scanning is scoped to one at a time: pick a location, count it, tap
*Finish section*, move on. A separate "count something elsewhere" action records a stray
bottle into another location and returns you to the current leg — it never silently
changes which leg you are in.
Why it is locked: a wrong active location fails *silently*. Every scan lands on a real,
legitimate line in the wrong place; the count total stays correct and only the
distribution is wrong, so nothing looks broken until a reorder list is nonsense weeks
later. Locking also makes the input-mode switch explicit — Speed Rail and Back Bar are
tenths, Storeroom is quantities only, and that is driven entirely by location.
Note: `prototypes/count-scan.html` predates this decision and still shows a free-switch
dropdown. Do not copy that part of it.

> *(The bar has six locations as of 2026-11; "five" above is as originally written.)*

## A quantity SET shows its before/after

**A quantity SET shows its before/after on the button, live.** `ADD` and `SET` take the
same input in the same box, and afterward the line just reads `3 ea` either way — a SET
the user meant as an ADD loses bottles with nothing on screen looking wrong. So the
submit button states the consequence as they type: `SET TO 3 EA / was 12 ea · −9`, or
`ADD 3 EA / 12 → 15`. No modal — a confirmation dialog on a control used 150 times a
count gets clicked through blind inside a week, which is worse than no guard because it
feels like one. The `count_line_write` ledger records the delta either way, so this is
about the human noticing at the time, not about recovering afterward.

## One fresh `client_line_id` per write attempt

**One fresh `client_line_id` UUID per write attempt — never one per count line.**
Idempotency lives in the append-only `count_line_write` ledger, whose unique index on
`client_line_id` makes a replayed write roll back and return success. Reuse an id only
when literally resending the same failed request. Reusing one id per line instead would
make every legitimate second scan of a bottle a silently swallowed no-op — the count
comes out short with no error anywhere, which is quieter and worse than the
double-count this ledger replaced.

## Row-level edit is a real button

**Row-level edit is a real `<button>`, never an `onClick` on the `<tr>`.** Both
the locations and vendors tables shipped with the row itself as the edit
affordance and were fixed on 2026-08-12. Three defects at once: it is
unreachable by keyboard and invisible to a screen reader (`tabIndex: -1`, no
role) while every other control on the screen is a button; nothing on screen
says the row is clickable; and because the inline form opens *above* the table,
every row below it reflows, so a click aimed at one row lands on another. That
last one put a real location — Speed Rail — into the edit form, one confirm from
a renamed location and a changed `count_mode`, with nothing looking wrong
afterwards. **The fix is an explicit Edit button with the row's `onClick`
removed**, not a `role`/`tabIndex` bolted onto the `<tr>` — that fixes the
accessibility third and leaves the wrong-target hazard. Any edit form must also
name its subject in the heading (`Edit Speed Rail`, not `Edit location`).

## Barcodes go through `normalizeBarcode`

**A barcode is only ever stored or looked up through `normalizeBarcode`
(`lib/barcode.ts`).** One bottle's code can arrive as UPC-A, as EAN-13 with a
leading zero (how the ZXing reader reports a UPC-A), or as an 8-digit UPC-E;
the database's unique index only refuses an *identical* string. Comparing or
inserting a raw scan anywhere is how one barcode ended up on two sizes
(2026-11-05, docs/plans/barcode-integrity). The standard form is the 14-digit
GTIN; an 8-digit code is converted only when the camera reported its format,
never guessed, because the only dangerous mistake is merging two different
codes. A test fixture that inserts a barcode row must insert the standard
form, or a lookup will miss it and a "refused" assertion can pass for the
wrong reason.

## The scanner's engine loads from this origin

**The scanner's fallback reader loads its engine from this app's origin**
(`/zxing/zxing_reader.wasm`, copied out of `node_modules` by
`scripts/copy-zxing-wasm.mjs` before every `dev` and `build`). Do not let it
fall back to a CDN: the CSP's `connect-src 'self'` refuses that, and the
camera then opens and silently decodes nothing.

## JS-submitted forms carry `method="post"`

**Any form whose submit is handled in JavaScript carries `method="post"`.**
`preventDefault()` only runs once React has attached; before that — or if
hydration fails outright — the browser submits natively, and a form with no
method defaults to **GET**, serializing every field into the query string.
On the login form that put a plaintext password into the server access log,
the user's history, and the `Referer` of any later outbound link. POST
degrades to a bare 405 instead, which leaks nothing. Gating the submit
button on a hydrated flag is the complement, not the substitute: the flag
handles the ordinary race, the method handles hydration never happening.

> The one deliberate exception is the catalog search form
> (`components/office/catalog-table.tsx`), which carries `method="get"` with a
> comment explaining why: a search query is meant to be in the URL. The edit
> guard (`.claude/hooks/guard-edits.mjs`) only warns when `method` is absent.

## Verify UI work in a browser

**Verify UI work in a browser, not with `curl`.** Server-rendered HTML and a
200 prove the server ran, nothing more. Every client-side failure this
project has hit — the CSP hydration break, the credential leak — was
invisible to status codes and obvious on first page load.

## Planning workflow — the two things easy to get backwards

- **Authority split.** `STATE.md` / `ROADMAP.md` / `docs/open-items.md` stay
  authoritative for *what* the project is doing and *when* — status, phase
  sequencing, deferred-item triggers. Unchanged by this workflow.
  `docs/plans/<slug>/` is authoritative for *how* one non-trivial feature gets
  built, for that feature's lifetime only. A feature's Gate 1 doc should cite
  the relevant ROADMAP phase or open-item rather than re-deriving it; when the
  feature ships, the history log (`docs/history/state-log.md`) gets its usual
  one-line entry.
- **Gate 4 vs. the subagent sequence above — they compose, not compete.** Gate 4
  slices are the *unit of work* (tracer bullet → real logic → one capability
  per slice). The `database → backend → frontend/ui-design →
  code-reviewer/security-reviewer → devops` order is *how each slice gets
  built* — schema first, then business logic, then UI (frontend/ui-design
  sequential, never parallel, per the rule above), then the two read-only
  reviewers in parallel, then devops only once ship-ready.

## CodeGraph

This repo is indexed by CodeGraph — a `.codegraph/` directory holds a regenerable
SQLite knowledge graph of every symbol, edge, and file (not source, not checked in).
Reach for it BEFORE grep/find or reading files when you need to understand or locate
code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in
  one call — the relevant symbols' verbatim source plus the call paths between them,
  including dynamic-dispatch hops grep can't follow. Name a file or symbol in the
  query to read its current line-numbered source.
- **Shell**: `codegraph explore "<symbol names or question>"` prints the same output.

**The index is local-only.** `.codegraph/` is gitignored, so a fresh clone — every
cloud session, CI, a new worktree — has no index and no `codegraph` binary. If
`.codegraph/` does not exist, skip this section and use grep/glob; do not try to
install or build the index unless the user asks.
