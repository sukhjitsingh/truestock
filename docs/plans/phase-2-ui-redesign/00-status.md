# Status: Phase 2 — UI redesign · mobile layout and design flow

Covers ROADMAP.md Phase 2. **Shipped 2026-08-14 as PR #13 (merge `9cbf64b`) —
ten commits: the Gate 1 approval (`43f2927`, the five planning documents in this
directory) and nine implementation commits.**

- Gate 1 — Product: APPROVED 2026-08-13 (`gate-1-product.md`)
- Gate 2 — Architecture: **deliberately skipped** — see `gate-1-product.md`,
  "Why this phase skips Gate 2/3/4". No schema, no endpoints, no business logic.
- Gate 3 — Program Design: **deliberately skipped**, same reason
- Gate 4 — Slice plan: **deliberately skipped**, same reason. `ui-spec-mobile.md`
  and `ui-spec-web.md` carry the architecture-equivalent decisions (data shapes
  consumed, component contracts, token additions) as checklists instead.

The skip is the unusual thing about this phase, so it is worth being able to
judge it in hindsight: it held. Nothing in the phase needed a migration, a route,
or a domain function, and every commit was reviewable in one sitting. The cost of
the skip showed up somewhere else — with no slice plan, "done" was decided
per-commit rather than against a list, and the criteria audit below is the first
time anyone checked the phase against its own Gate 1 in one pass. Two criteria
turned out to be partial. Neither would have been news at the time if a slice
plan had existed.

---

## Commits

| | |
|---|---|
| `1f93278` | Foundation: tokens, 16 component specs, `components/ui` primitives, the mobile counting surface, prototypes regenerated. Committed as a checkpoint mid-workflow (session limit), with the parts its author never verified named in the message |
| `dd9fda4` | Back office completed: `PageHeader` across five screens, counts-list and count-summary onto the shared Table primitives, `NullValue` vocabulary, prototypes' P1.2/P1.4/P2.7 findings closed, 11 new browser checks, 3 new test files |
| `f1f09d9` | Three review findings — the bare `focus:outline-none` on catalog search, the account menu not moving focus in, dishonest `hover:bg-muted` on non-interactive rows — **plus the harness defect that hid the first one** |
| `57df8b4` | The catalog "hang" was Drizzle in the client bundle (`db/enums.ts` extracted); the office got its 64 px left icon rail |
| `b5433ed` | Two-level catalog filters, type-ahead search, cost display precision, sticky/persistent rail, the count leg's floating bottom bar |
| `585d2b6` | The browser harness can now run against a production build (CSP-safe hydration polling) and gained a real `skip()` |
| `51cab9a` | The catalog search field had no `name`, so a pre-hydration Enter lost the query |
| `ca5c899` | Agent memory: why `db/enums.ts` must stay Drizzle-free |
| `db30826` | The rail's collapse toggle was in the bottom-left corner of the viewport, where the browser's own UI intercepts clicks |

---

## Gate 1 success criteria, checked one at a time

Gate 1 listed seven things this phase could claim done at completion (as opposed
to the four bets it deferred to 2.9). Five are met in full; two are partial, and
the partial ones are stated as partial rather than rounded up.

### ✅ 1. TanStack Table adopted for the catalog, with per-role `columns` built at call time

Met, and browser-checked. The `columns` array is built per role at call time —
never `columnVisibility` filtering, per `library-comparison.md`. The committed
check asserts a **manager's rendered DOM contains no `Unit cost for` string and
zero cost inputs**, with an **owner positive control** that must find it, so the
check cannot pass by the page failing to render. A third check confirms a
manager can still edit case size, which would catch the page rendering as an
empty shell.

### ✅ 2. Chart series palette re-derived, or explicitly owed with no chart drawn

Met by the escape clause, correctly. `--chart-1` is real; `--chart-2..5` are left
**empty** in both `:root` and `.dark` — not a placeholder hex, so an accidental
consumer breaks visibly rather than rendering a looks-fine-but-wrong colour. No
chart is drawn anywhere in the app. Carried forward as **open item #28**, due at
the first chart in Phase 4, with the four-part computation method recorded there.

`grep -rn "chart-[2-5]" app components` returns hits in `app/globals.css` (the
two token blocks and their `@theme` aliases) and **one comment** in
`components/ui/meter.tsx` explaining why the meter does not reach for them.
Nothing consumes an empty custom property — verified 2026-08-14.

### ✅ 3. `prototypes/*.html` regenerated from `app/globals.css`

Met. All 11 prototypes link the generated `tokens.css` (`grep -L` returns
nothing); six of them previously carried their own drifted `:root` block. The
generator is `prototypes/generate-tokens.mjs` and reproduces byte-for-byte from
`app/globals.css`. The audit's P1.2 and P1.4 findings were closed in the same
pass — 9 tables, 54 `<th>`, 54 scoped, 9 captions, where the audit had found zero
of each.

### ✅ 4. Role-gated value contract holds for every new or touched component

Met, and enforced in the primitive rather than by convention. `stock-cell.tsx`
makes no-par-no-bar structural; `null-value.tsx` gives an absent value a typed
reason (`not-applicable` / `not-entered` / `role-gated`) instead of `$0.00` or a
reserved blank track. Both have their own test files
(`tests/stock-cell.test.ts`, `tests/null-value.test.ts`), and the browser check
"a product with no par level renders NO stock bar" reports 15 rows showing a unit
count and **0 meter bars**.

### ✅ 5. One capitalization convention

Met. Stated in `docs/design-system.md`, and the sentence-case violations in
`prototypes/count-scan.html` were fixed as part of `dd9fda4`.

### ⚠️ 6. Accessibility floor on **every** screen, checked in a real browser — PARTIAL

**What is fully met:** zero `outline: none` without a substitute. Six elements
carry `focus:outline-none`; three pair it with `focus:ring-*` on the element and
three use this codebase's house pattern of a `focus-within:` ring on the wrapper.
The harness was taught to credit the wrapper pattern, because the element-only
check read those as bare. Contrast needed no new computation: this phase added
spacing and layout tokens (`--spacing-row-office`, safe-area insets, `.num`) and
no new colour token, so §2's existing computed ratios still cover everything.

**What is partial:** the assertions run on **one screen**. `assertFocusVisible`,
`assertNoHeadingSkips` and the icon-button-name check are each invoked once, for
`/office/catalog`. The other office screens were opened in a browser and looked
at; they were not walked for tab stops, heading order, or unlabelled icon
controls. The counting screens got neither — `verify:browser` drives `/count`
only far enough to confirm it loads and that locations are server-rendered.

**Why this is worth writing down rather than quietly rounding up.** The one
screen that *was* walked is the screen where the bare focus ring was found — and
it was found only after the harness itself was fixed. `assertFocusVisible` had
been resuming its tab walk from wherever the previous assertion's click left
focus, deep inside the table, and reported "25 tab stops, none bare" having never
visited the bare control sitting above its starting point. So the evidence we
have says: when this check is actually run on a screen, it finds something. It
has been run on one of about a dozen.

**How to close it:** extend `assertFocusVisible(path, mustReach)` over the
remaining office routes — it already takes a path and a `mustReach` pattern, so
this is a loop, not new machinery. The counting screens are phone work and belong
with open item #20.

Carried as **open item #29**, trigger: the next time any office screen is opened
for another reason, and before Phase 3 go-live for the counting screens.

### ⚠️ 7. Zero rows or cards carry a whole-row click, and the shared table discipline extends everywhere — PARTIAL

**What is fully met:** the whole-row-click hazard itself is gone. No `<tr>` in
the codebase carries an `onClick`; the browser check "clicking a non-interactive
table cell does not navigate" passes on the catalog. Hover honesty was fixed too
— `TableRow` takes `interactive` (default `true`) and the rows that hold no
row-level control pass `interactive={false}`, so `hover:bg-muted` no longer
advertises an affordance that is not there.

**What is partial:** three of the seven table surfaces still hand-roll `<table>`
instead of using the shared primitives — `vendors-list.tsx`,
`locations-table.tsx` and `users-list.tsx`. Concretely, and each is small:

- `users-list.tsx` has **no `scope="col"` on any header** and no `<caption>`.
  The other two have `scope="col"` (5 each) but no caption.
- `vendors-list.tsx` renders three ad-hoc `"—"` strings for null contact, order
  method and lead time instead of `<NullValue>`. That is the same null-value
  drift `dd9fda4` removed from counts-list, surviving on a screen that commit
  did not touch.

None of this is a hazard — it is the migration being four-sevenths done. Carried
as **open item #30**, trigger: the next time any of those three screens is opened
for another reason. It is not worth a dedicated pass.

---

## The bets deferred to 2.9 — where they went

Gate 1 required that the four decisions this phase made about *where count time
goes* each get an entry in `docs/phone-count-test.md` before the phase closed.
They are **§6 of that file**, added 2026-08-14, with the permitted fix for each
one stated in advance (two of them explicitly rule a fix out — no free-text
enroll field, no confirmation modal on SET/ADD) and a verdict line for each in
the §3 recording template.

---

## Gate at close

Re-run independently rather than taken from the implementing agents' reports:

| | |
|---|---|
| `bun run typecheck` | clean |
| `bun run lint` | 0 errors, 2 known warnings (the pre-existing TanStack `incompatible-library` one) |
| `bun run build` | exit 0 |
| `bun run test:docker` | **210 pass / 0 fail / 612 assertions / 21 files / 31.7s** against MariaDB 11.8 (was 173 at phase start) |
| `bun run verify:browser` | **44 of 45 against dev**, 2026-08-14. Of the 44, **two are skips** the script labels *Not a pass* (no vendor row; no par level). The 1 failure is a `Performance.measure` negative-timestamp `TypeError` from Next's **dev** instrumentation, not app code |
| `bun run verify:browser` (production build) | **44/44**, recorded in `585d2b6`. Not re-run since |

**Read the browser number carefully** — "44 passed" is 42 checks that executed.
The skips are printed under NOT VERIFIED on every run precisely so they cannot be
mistaken for coverage.

---

## Notes for a fresh session

**The single most important fact about this phase: the back office was verified
screen by screen in a real browser and the counting surface was never opened on a
phone.** The counting app got the larger rebuild of the two. Every phone-verified
fact in `STATE.md` — the fill pad, the two camera enrolments, the offline sync
chip — predates it. Those remain good evidence about the mechanisms underneath,
which this phase did not touch (no schema, no write path, no leg model), and they
are **not** evidence about the screens that ship today.

**Four defects in this phase were found by looking at the running app, and three
of the four would have passed any conceivable server-side check.** They are worth
knowing as a set because they are all the same shape:

1. **A control the browser's own UI was eating.** The rail's collapse toggle was
   pinned to the bottom-left corner of the viewport by a `flex-1` spacer. Nothing
   about its state was wrong — it hydrated, `aria-expanded` was correct, the
   cookie write was correct — but Next's dev-tools portal parks in that corner
   and intercepts pointer events, and Chrome paints its link-hover bubble there
   in production. Because it could never expand, the rail read as icon-only with
   no way out, which presents identically to a broken cookie. **The diagnostic
   that separates them: run the same click three ways** — real click (fails),
   `force: true` (also fails, because force skips actionability checks, not
   browser hit-testing), `dispatchEvent` (works). If only the third works, the
   control is fine and something is sitting on top of it.
2. **A `const` from a `"use client"` module, read on the server.** `RAIL_COOKIE`
   was exported from a client module, so `cookies().get(RAIL_COOKIE)` in the
   server layout was looking up a client-reference proxy and returning
   `undefined` every request. Indistinguishable from the cookie never being set:
   the write succeeds, the browser sends it, `getAll()` lists it by name, only
   `.get()` comes back empty. Fixed by moving the constant to
   `lib/ui-cookies.ts`.
3. **A `method="get"` form field with no `name`.** Pre-hydration Enter navigated
   to a bare `?` and lost the query, so search read as broken rather than as not
   yet loaded. The mirror image of the `method="post"` rule in `AGENTS.md` —
   same class of defect, silent wrong result instead of a leak.
4. **A harness that could not see the thing it was checking.** Covered under
   criterion 6 above. The lesson generalises: a check that reports coverage
   ("25 tab stops") without asserting *which* elements it reached will
   eventually report coverage it does not have. `mustReach` exists now for
   exactly that.

**And one about the harness itself:** `waitForHydration` used
`page.waitForFunction`, which evaluates a string in the page. The production CSP
has no `'unsafe-eval'` — that is the point of it — so the call died with
`EvalError`, but only in the **second and later** browser contexts, because the
first rides on Playwright's pre-installed script which bypasses CSP. So the login
check at the top of the file passed while the role loop three hundred lines down
threw, against the same server and the same policy. Polling `page.evaluate` from
Node is CSP-safe everywhere. This mattered more than any single UI fix: the
harness exists to catch the CSP hydration break, this project's worst historical
failure, and until `585d2b6` it could not run against a production build at all.

**Do not read "standalone" in `585d2b6`'s commit message literally.** It says the
harness runs "end to end against the standalone build". What it ran against was
`docker-compose.prod.yml`, which runs `npm run build && npm run start` and whose
own header comment says it is not the real production image. The CSP that run
exercised is real and the 44/44 stands; `node .next/standalone/server.js` — what
Hostinger actually executes — has still never been started. That is a Phase 3 /
`docs/go-live.md` item.
