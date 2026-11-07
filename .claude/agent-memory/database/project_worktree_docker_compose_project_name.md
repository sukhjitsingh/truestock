---
name: worktree-docker-compose-project-name
description: bun run test:docker fails with "service app is not running" from a git worktree because docker compose resolves the project name from cwd, not from which containers are actually up
metadata:
  type: project
---

Running `bun run test:docker` (or any bare `docker compose exec ...`) from inside
a git worktree directory (e.g.
`.claude/worktrees/phase-2.5-slice-1/`) fails with `service "app" is not
running`, even though `docker ps` clearly shows `truestock-app` and
`truestock-mariadb` as `Up`.

**Why:** `docker compose` derives the compose *project name* from the current
working directory by default. The actually-running containers were started
from the main worktree (`/Users/moni/Claude_Workspace/truestock`), so they
belong to compose project `truestock`. A worktree checkout has its own copy of
`docker-compose.yml` in a differently-named directory
(`.claude/worktrees/<slug>/`), so a bare `docker compose` invocation from
there resolves to a *different* (non-existent) project and legitimately sees
no running `app`/`db` service — `docker compose ps -a` from the worktree
returns empty, while `docker compose ls` shows project `truestock` pointing at
the main worktree's compose file.

**How to apply:** prefix the command with `COMPOSE_PROJECT_NAME=truestock`
when running docker compose from a worktree, e.g.:
```
COMPOSE_PROJECT_NAME=truestock docker compose exec -T -e DATABASE_URL=... app bun test
```
This is a docker-compose project-resolution quirk, not a bug in `test:docker`
itself — worth fixing properly (e.g. pinning `COMPOSE_PROJECT_NAME` in the
worktree's own `.env` or `docker-compose.yml`, or documenting it in
`db/README.md`) if worktrees become the normal way this project is worked in,
but out of scope for a single database-stage task to change project tooling.
A same-container-name workaround that also works for ad hoc inspection
(bypassing compose entirely): `docker exec truestock-mariadb mariadb -u... -p...`.

**CORRECTION (2026-08-15, Slice 2 delegation) — this workaround gets you INTO
the container, but the container's `app` code is still stale.** `truestock-app`
was started from and bind-mounts `/Users/moni/Claude_Workspace/truestock` (the
main checkout), confirmed via `docker inspect truestock-app --format
'{{range .Mounts}}...'`. A git worktree is a physically separate directory
tree that shares only `.git` — code written, edited, or even committed inside
`.claude/worktrees/<slug>/` is invisible to that container no matter what
`COMPOSE_PROJECT_NAME` resolves to. So `COMPOSE_PROJECT_NAME=truestock docker
compose exec app bun test` from a worktree successfully runs — against the
WRONG code — and a passing result proves nothing about the worktree's actual
changes. This is exactly how the database stage's self-reported "test:docker —
276 pass / 0 fail" went uncaught: it ran clean because it was silently testing
the main checkout, which doesn't have Slice 2's schema changes at all.

**The actually-correct way to run tests against a worktree's real code:**
bypass Docker entirely and run directly on the host, which has its own local
`bun` (`~/.bun/bin/bun`), its own `node_modules`, and reaches the same MariaDB
directly via its host port mapping (`127.0.0.1:3307`, see `docker-compose.yml`):
```
DATABASE_URL="mysql://truestock:truestock@127.0.0.1:3307/truestock_test" bash scripts/run-tests.sh
```
Note: `bash scripts/run-tests.sh`, not `bun run scripts/run-tests.sh` — it's a
bash script, and `bun run <path>` misparses its shell syntax. Also note the
database name must end in `_test` (`tests/helpers/test-db.ts`'s
`assertTestDatabase()` hard-refuses anything else, since these tests truncate
every table) — `truestock_test`, not `truestock`.
