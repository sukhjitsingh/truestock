# Database agent memory — Truestock

- [Better Auth owns user/session/account/verification](project_better_auth_owns_user_tables.md) — resolved; real config key is `advanced.database.generateId: "serial"`, not `useNumberId` — backend agent must set it or auth writes break
- [Migration regenerated in place pre-launch](project_migration_regenerated_pre_launch.md) — RESOLVED 2026-08-12: real seeded dev DB now exists, migrations stack normally (0000-0003 applied), no more regen-in-place
- [count_line_write idempotency ledger](project_count_line_write_idempotency_ledger.md) — replaced the broken single-column client_line_id on count_line; lib/domain/counts.ts needed a matching update (out of database agent's scope)
- [Worktree docker compose project name](project_worktree_docker_compose_project_name.md) — `bun run test:docker` from a worktree silently tests the MAIN checkout's stale code (bind-mount, not a project-name issue); run `DATABASE_URL=... bash scripts/run-tests.sh` on the host instead
- [Phase 2.5 Slice 3 — vendor_alias schema](project_phase25_slice3_vendor_alias.md) — table name is `vendor_alias` (not `vendor_item_alias`); tenant-FK asymmetry (vendor_id composite, product_id bare) is deliberate, don't "fix" it
- [MariaDB composite index survives column drop](mariadb-composite-index-survives-column-drop.md) — `DROP COLUMN` narrows a multi-column index instead of dropping it; migration reversal SQL needs an explicit `DROP INDEX` first
