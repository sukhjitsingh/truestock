# syntax=docker/dockerfile:1

# Development and test image for the Next.js app — backend and frontend both.
# NOT the production image: production ships the `output: 'standalone'` build
# through .github/workflows/deploy.yml to Hostinger's managed Node.js app, and
# never builds this file.
#
# Node 22, deliberately:
#   - CLAUDE.md's stack table says the host decides the runtime and the answer
#     is Node, not Bun or Deno.
#   - docs/deploy.md §1 records Hostinger's supported versions as
#     18.x / 20.x / 22.x / 24.x, so 22 is a supported LTS on the real target.
#   - The host machine runs node v22.13.1, so local and containerised runs
#     agree.
FROM node:22-bookworm-slim

# Bun is installed as the INSTALLER and TEST RUNNER only — never as the app
# runtime. That is exactly the split CLAUDE.md describes: "bun install is fine;
# run the app on Node." scripts/run-tests.sh execs `bun test`, so the suite
# needs it present.
#
# Pinned to match the host's bun (1.3.7) so bun.lock resolves identically
# inside and outside the container. An unpinned installer is how a lockfile
# quietly drifts between a developer's machine and CI.
ARG BUN_VERSION=1.3.7
ENV BUN_INSTALL=/usr/local

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      unzip \
      # A working mysql client inside the container. The host's client is
      # unreliable on this machine, and `docker compose exec app mysql ...`
      # is a useful second way in when the db container's own shell is busy.
      default-mysql-client \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && bun --version

WORKDIR /app

# Manifests first, so the dependency layer caches independently of source
# edits. Without this split, every touched .tsx file reinstalls the world.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# No `COPY . .` — docker-compose.yml bind-mounts the source so host edits are
# live. The install above still matters: it populates /app/node_modules in the
# image, and the named volume mounted over that path is seeded from it on
# first creation.

EXPOSE 3000

# `npm run`, not `bun run`, and the distinction is load-bearing. Both resolve
# `next` from node_modules/.bin, but bun prefers its own runtime for JS entry
# points, which would quietly run the dev server on Bun and defeat the reason
# this image is based on Node at all. npm respects the `#!/usr/bin/env node`
# shebang.
#
# -H 0.0.0.0 so the server is reachable from the host through the published
# port; the container's own loopback is not.
CMD ["npm", "run", "dev", "--", "-H", "0.0.0.0"]
