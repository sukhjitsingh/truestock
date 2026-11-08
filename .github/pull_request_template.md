## What and why

<!-- One or two sentences. Link the plan slice (docs/plans/<slug>/04-slices.md),
     ROADMAP phase or open-item this belongs to. -->

## Proof

<!-- Evidence, not claims. Paste the tail of each output. -->

- [ ] `bun run typecheck`
- [ ] `bun run lint` (0 errors)
- [ ] `bun run test` against a `_test` database — pass/fail counts:
- [ ] UI change: driven in a browser (`bun run e2e`, or say what was checked by hand)
- [ ] Behaviour change: the new test fails without the change (mutation-checked)

## Invariants touched

<!-- Which of the 11 in AGENTS.md this changes or relies on, or "none". -->

## Not yet proven

<!-- What this PR builds but has not seen working — e.g. "not tried on a phone".
     If something moves between "built" and "proven", update STATE.md. -->
