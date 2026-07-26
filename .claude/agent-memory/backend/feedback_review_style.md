---
name: feedback-review-style
description: How the coordinator reviews this backend's work and what that implies for how to write it — read before starting a new round of backend changes
metadata:
  type: feedback
---

The coordinator (via code-reviewer/security-reviewer subagents) does deep,
adversarial review of this backend, not a surface pass:
- Verified invariants "by enumeration" (walked every write path checking
  each one, not spot-checked).
- Found the count_line_write double-count flaw by mentally simulating an
  out-of-order retry (write A, ack lost, write B applies, A retries) — a
  scenario one level more adversarial than "does a simple retry work."
- Cares about actionable error messages specifically on scan-to-enroll,
  citing CLAUDE.md's 20-second budget as the reason a generic error there is
  a real product defect, not just a UX nit.
- Wants magnitude/bounds validation checked against the actual DB column
  precision (DECIMAL(10,4) etc.), not just shape validation.
- Asks for security/threat-model reasoning tied to the actual deployment
  context (a shared Android phone on a bar floor) rather than accepting a
  library default.

**How to apply:** when building or revising anything in this backend,
write the "why," including the specific adversarial scenario or threat
model, directly in code comments — the coordinator reads these closely and
will catch a design that's merely plausible-looking but not actually proven
against a concrete race/attack scenario. When the schema changes underneath
in-progress work, the coordinator flags exactly which comment/README to
re-read (e.g. "re-read db/schema.ts and db/README.md, the schema changed") —
always do that re-read before resuming, don't assume prior knowledge of the
schema is still current.

**How to apply (specific, recurring pattern):** when a data-integrity fix
changes a table's shape, check whether it creates a new asymmetry with a
sibling feature built earlier in the same file (e.g. the new
`setCountLineQuantities` ledger-writes but the pre-existing
`editCountLineFills` doesn't) — surface it explicitly rather than silently
leaving it inconsistent OR silently "fixing" it by inventing a new schema
convention unilaterally. The coordinator has been explicit elsewhere that
schema decisions are not this agent's to make alone; flag and wait.

See [[counts-increment-idempotency]] for the concrete case this pattern came from.
