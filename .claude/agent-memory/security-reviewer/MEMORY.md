# Security Reviewer — Memory Index (Handlebar)

- [Baseline audit 2026-07](project_baseline_audit_2026-07.md) — pre-auth scaffold audit: secrets/gitignore clean, dependency findings (postcss vendored in next, dormant sharp CVE), authorization checklist held over for backend agent.
- [Backend auth deep-dive 2026-07](project_backend_auth_audit_2026-07.md) — authz/cost-gating verified correct against actual query code; two low-severity gaps: no session revocation on user deactivation, no explicit session expiry config.
