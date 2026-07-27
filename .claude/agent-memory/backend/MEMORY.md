# Backend agent memory — Truestock

- [feedback-review-style](feedback_review_style.md) — how the coordinator reviews this backend (adversarial, race-scenario-driven) and what that implies for how to write code/comments here
- [project-architecture](project_architecture.md) — layout of lib/auth.ts, lib/authz.ts, lib/domain/*, app/actions/* after the first backend build
- [counts-increment-idempotency](counts_increment_idempotency.md) — count_line_write ledger design (2nd iteration) for scan-increment/correction idempotency; supersedes the removed client_line_id-on-count_line approach
- [valuation-nulls](valuation_nulls.md) — how nullable unit_cost_at_count/case_size_at_count are excluded (never coerced to 0) in valuation math
