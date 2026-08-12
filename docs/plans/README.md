# Planning workflow: the 4-gate process

This directory holds per-feature planning docs for non-trivial work — schema
changes, new endpoints, anything with a diff the user would hate to review
all at once (roughly 100+ lines). It follows the **software-factory** skill
(Dex Horthy/HumanLayer's 4-gate workflow): make every important decision
before implementation code exists, where changing it costs a sentence instead
of a rewrite. See `AGENTS.md`'s "Planning workflow" section for how this
relates to the project's other living docs (STATE.md / ROADMAP.md /
docs/open-items.md) and to the existing subagent sequence.

## When to use it

Run the full workflow for a real feature: multiple files, a new endpoint,
table, or screen, or a diff the user would hate to review all at once.

Skip it entirely — just do the task — when any of these hold:

- Trivial tweak: rename, typo, copy change, small config edit.
- The user explicitly says to skip the process ("just vibe it," "quick and
  dirty," "no process").
- The code is throwaway or pure prototyping.

If unsure, ask once: "This looks big enough for the 4-gate workflow — run
it, or do you want the fast version?" Respect the answer.

## Layout

Each feature gets its own slug directory:

```
docs/plans/<feature-slug>/
  00-status.md          state file: gate approvals + slice checklist
  01-product.md
  mockups/              Gate 1 screen mockups — plain HTML, one file per screen
  02-architecture.md
  03-program-design.md
  04-slices.md
```

Create `00-status.md` first, before Gate 1, and update it at every gate
approval and every slice completion:

```markdown
# Status: <feature name>

- Gate 1 — Product: pending | in progress | APPROVED <date>
- Gate 2 — Architecture: pending | in progress | APPROVED <date>
- Gate 3 — Program Design: pending | in progress | APPROVED <date>
- Gate 4 — Slice plan: pending | in progress | APPROVED <date>

## Slices
- [ ] Slice 1 — tracer bullet: <one line>
- [ ] Slice 2 — <one line>

## Notes for a fresh session
<anything decided in chat that a new session must know>
```

**Resume rule:** at the start of any session, if a feature's
`00-status.md` exists, read every doc in that folder first, then continue
from the first unapproved gate or first unchecked slice. Never redo an
approved gate unless the user asks for it or a later gate invalidated it.

## The approval protocol (run at every gate)

1. Write the gate doc to disk.
2. Present a summary to the user: at most 5–10 bullet decisions, plus the
   doc path. Do not paste the whole doc into chat.
3. Ask exactly: **"Approve Gate N, or what should change?"**
4. Approval means the user clearly says yes / approve / continue. Anything
   else means: revise the doc to address their answer, then re-ask.
5. On approval, mark the gate APPROVED in `00-status.md` and move on.
6. **Backtracking:** if work at a later gate reveals an earlier approved
   decision is wrong, stop, update the earlier doc, set that gate back to
   "in progress" in `00-status.md`, and get re-approval before continuing.

## Gate 1 — Product (no tech talk)

`01-product.md`: Problem (in the end-user's words), Success metric (one real
number and how it's measured), Announcement (3–6 sentences announcing the
feature — if you can't write it, you're building the wrong thing), Screens
(one line per `mockups/` file, or "no UI").

Banned at this stage: databases, schemas, endpoints, architecture, file
names — that's Gate 2. For anything with a UI, produce one plain HTML file
per screen in `mockups/` — no framework, no build step, throwaway by design.
Iterate with the user until they say "yes, that."

## Gate 2 — Architecture

Read the relevant existing code first — never design against an imagined
codebase. `02-architecture.md`: Fit (which existing modules this touches),
Endpoints (route + verb + purpose, or "none"), Data (new/changed tables with
outlines of the queries that will hit them), Flow (end-to-end call order for
the main path), External (third-party APIs, env var *names* never values,
webhooks, or "none").

## Gate 3 — Program Design (the step everyone skips)

The decisions the agent would otherwise make silently mid-implementation.
`03-program-design.md`: Files (every file created/changed, one line each on
why it lives there), Types & signatures (code blocks — types and method
signatures only, **no implementation bodies**, so a human can read them in
seconds and say "right" or "wrong"), Call stack (what calls what, top to
bottom, per main flow), Test plan (test case names and what each asserts —
before any of them exist), Least confident decisions (numbered list of the
calls most worth challenging now, while changing them is free).

## Gate 4 — Vertical Slices (tracer bullets)

Write `04-slices.md` first — one line per slice, in build order — and get it
approved before building anything. Then build one slice at a time:

- **Slice 1 is the tracer bullet:** a mocked/hardcoded endpoint and a
  stubbed UI (or curl-able response), wired end to end. It does almost
  nothing — but it runs, and the user can see it.
- **Slice 2:** replace mocks with the real logic for the single happy path.
- **Slice 3+:** one capability per slice — a business rule, error handling,
  an edge case, polish — each ending in a working, testable state.
- **Banned:** horizontal building (all of the database, then all services,
  then all API, then all frontend, with nothing testable until the end).

After every slice: prove it works (run it, curl it, or browser-test it, and
show the user), check it off in `00-status.md`, then ask "Continue to slice
N+1, or re-steer?"

## Standing rules

- **Compact at every boundary.** At the end of every gate and every slice,
  make sure the docs contain everything decided — nothing important may
  exist only in chat. A new session must be able to continue from the docs
  alone (see the resume rule above).
- **Keep diffs reviewable.** Small slices. If the user hasn't looked at code
  in a long stretch, nudge them at a slice boundary.
- **Real tests only.** Never write a test that passes against the
  pre-change code — a test that can't fail tests nothing. Never comment
  out, skip, or weaken a test to get to green.

## ADRs — created lazily, not scaffolded here

`docs/adr/` does not exist yet and is **not** pre-created by this scaffold.
When a gate produces a decision that outlives one feature, offer to record
it as an ADR in `docs/adr/NNNN-<slug>.md` (context, decision, consequences;
never rewrite old ADRs — supersede them). Create the directory the first
time it's actually needed. This repo already has an informal equivalent for
most durable decisions — STATE.md's dated history log, and the append-only
correction blockquotes in `docs/reviews/*.md` — so reach for a real ADR only
when a decision doesn't fit either of those.

Record anything that lives outside the repo but that an agent needs to know
exists (env var names, third-party dashboards, test accounts) in
`docs/external/`, created the same way — lazily, on first need.
