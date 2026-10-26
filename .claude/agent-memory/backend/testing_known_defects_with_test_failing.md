---
name: testing-known-defects-with-test-failing
description: How to encode a confirmed-but-unfixed defect as a green bun test (test.failing), how to prove it fails for the right reason, and the bun typing gotchas (test.todo needs a body)
metadata:
  type: reference
---

Technique used for tests/known-defects.test.ts (2026-10-26, test-hardening pass):

- Write the body to assert the CORRECT behaviour and mark it `test.failing` (or `test.failing.each`). Bun 1.4 reports a throwing body as pass and a passing body as a failure, so the suite is green today and goes red the moment someone fixes the defect, which is the prompt to delete the `.failing`.
- Always pair each defect group with a CONTROL test (same setup, a case the code already handles). A `.failing` test whose setup is broken also "passes", so the control is what proves the setup is sound.
- Prove a `.failing` fails for the intended reason: `sed 's/test\.failing/test/'` into a throwaway `tests/zz-scratch-*.test.ts`, run it, read the assertion messages, then delete it with `/bin/rm -f` (plain `rm` is aliased interactive and silently does nothing in this shell).
- `test.todo(name)` with no function is a runtime-fine but a tsc error here (bun-types declares `todo: Test<T>`, which wants a body). Pass a body that throws so `bun test --todo` keeps it a todo rather than flagging a passing todo.
- `test.skip` chosen by a ternary (`const t = cond ? test : test.skip`) typechecks fine.

**Why:** known defects must not be fixed inside a test-only task, and a skipped or commented-out test rots invisibly; `.failing` keeps them executed.
**How to apply:** any time a review or test-writing task finds real domain bugs but the brief forbids touching `lib/`. See [[testing-bun-rejects-needs-real-promise]] for the other bun-typing/behaviour trap.

Defects it currently encodes (check the file, they may have been fixed): product.active not enforced on the count write path (inv 6), deriveUnitCost accepting blank/zero/negative rawNet, wasteFactor schema max 9.999, createProduct not defaulting kegs to 0.100, last-owner guard race in setUserActive/setUserRole.
