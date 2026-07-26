# Database agent memory — Handlebar

- [Better Auth owns user/session/account/verification](project_better_auth_owns_user_tables.md) — resolved; real config key is `advanced.database.generateId: "serial"`, not `useNumberId` — backend agent must set it or auth writes break
- [Migration regenerated in place pre-launch](project_migration_regenerated_pre_launch.md) — no DB has ever been applied to; 0000_* migration is regenerated fresh on schema review changes rather than stacked, until first real apply
- [count_line_write idempotency ledger](project_count_line_write_idempotency_ledger.md) — replaced the broken single-column client_line_id on count_line; lib/domain/counts.ts needed a matching update (out of database agent's scope)
