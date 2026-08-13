# Security Reviewer — Memory Index (Truestock)

- [Baseline audit 2026-07](project_baseline_audit_2026-07.md) — pre-auth scaffold audit: secrets/gitignore clean, dependency findings (postcss vendored in next, dormant sharp CVE), authorization checklist held over for backend agent.
- [Backend auth deep-dive 2026-07](project_backend_auth_audit_2026-07.md) — authz/cost-gating verified correct against actual query code; two low-severity gaps: no session revocation on user deactivation, no explicit session expiry config.
- [Multi-tenant boundary audit 2026-07](project_multitenant_audit_2026-07.md) — one real cross-tenant IDOR: count-line writes never validate `locationId` against the caller's org. Everything else (product/count scoping, composite FKs, idempotency ledger, Better Auth additionalFields) verified correct.
- [Phase 1-1.5 slices audit 2026-08-12](project_phase1-1.5_slices_audit_2026-08-12.md) — locations CRUD, inline cost editing, dashboard reads, session sweep, docker guard: clean, no exploitable findings.
