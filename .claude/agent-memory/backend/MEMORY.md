# Backend agent memory — Truestock

- [feedback-review-style](feedback_review_style.md) — how the coordinator reviews this backend (adversarial, race-scenario-driven) and what that implies for how to write code/comments here
- [project-architecture](project_architecture.md) — layout of lib/auth.ts, lib/authz.ts, lib/domain/*, app/actions/* after the first backend build
- [counts-increment-idempotency](counts_increment_idempotency.md) — count_line_write ledger design (2nd iteration) for scan-increment/correction idempotency; supersedes the removed client_line_id-on-count_line approach
- [valuation-nulls](valuation_nulls.md) — how nullable unit_cost_at_count/case_size_at_count are excluded (never coerced to 0) in valuation math
- [testing-bun-rejects-needs-real-promise](testing_bun_rejects_needs_real_promise.md) — expect().rejects needs a real Promise; wrap bare Drizzle query builders in an async IIFE or the assertion misreports a working guard as broken
- [pdf-inspector-no-darwin-x64-binary](pdf_inspector_no_darwin_x64_binary.md) — `@firecrawl/pdf-inspector` has no Intel-Mac native binary; the host-test workaround can't run anything importing extraction-pipeline.ts — verify those in a throwaway Linux container instead
- [testing-parallel-worktree-docker-and-migration-race](testing_parallel_worktree_docker_and_migration_race.md) — isolate a worktree's Docker test stack from other running checkouts (standalone compose file, no port merge); pre-migrate once before `bun test` on a fresh DB to avoid a concurrent-DDL race
