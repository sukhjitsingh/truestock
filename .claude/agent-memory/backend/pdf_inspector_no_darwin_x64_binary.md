Discovered 2026-08-15, Phase 2.5 Slice 2 (invoice extraction pipeline). `@firecrawl/pdf-inspector`
(the native napi-rs PDF classifier `lib/domain/extraction-pipeline.ts` imports at module scope)
publishes prebuilt binaries for exactly these target triples, per its own `optionalDependencies`:

```
linux-x64-gnu, linux-x64-musl, linux-arm64-gnu, linux-arm64-musl, darwin-arm64, win32-x64-msvc
```

**`darwin-x64` (Intel Mac) is not among them.** On this project's Intel Mac host, importing
`lib/domain/extraction-pipeline.ts` — or anything that imports it, including `instrumentation.ts`
— throws `Cannot find native binding` at module load. This is upstream's gap, not a local
`bun install` problem; there is no published binary to install.

**Consequence for the established host-test workaround** (`DATABASE_URL=... bash
scripts/run-tests.sh`, from [[project_worktree_docker_compose_project_name]] in the database
agent's memory): that workaround runs `bun test` directly on the host, so it works for every test
file EXCEPT ones that import `extraction-pipeline.ts` (directly or transitively) — those need a
Linux runtime. `tests/extraction-pipeline.test.ts` is the first such file.

**How it was actually verified** (2026-08-15): a throwaway, isolated Linux container —
`node:22-bookworm-slim` (matches `docker/app/Dockerfile`'s base), source bind-mounted from the
worktree, `node_modules` as an anonymous volume (so `bun install` never touches the host's own
darwin-x64 `node_modules`), `DATABASE_URL` pointed at `host.docker.internal:<published mariadb
port>/truestock_test`. `bun install --frozen-lockfile && bun test` inside it gets a real
`linux-x64-gnu` binary and a correct result. `--rm` cleans up both the container and the
anonymous volume automatically; nothing shared (the running `truestock-app` container, its named
`truestock-node-modules` volume, the main checkout) is touched.

Do NOT reach for the existing `truestock-node-modules` named volume as a shortcut — it's seeded
from whichever checkout last built the image and will be stale for a worktree branch's new
dependencies (confirmed empty for `@firecrawl/pdf-inspector`/`@anthropic-ai/sdk` on this branch
at the time this was written) until that image is rebuilt.

This does NOT affect the deployed app: dev and prod both run inside Linux containers
(`docker-compose.yml`'s `app` service, Hostinger's managed Node runtime), where the correct
binary resolves normally. It only blocks the host-side test shortcut for this one dependency.
