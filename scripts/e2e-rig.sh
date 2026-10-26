#!/usr/bin/env bash
# The hermetic rig the Playwright e2e suite runs against (e2e/README.md).
#
#   E2E_ENV_FILE=/path/outside/repo/e2e.env bash scripts/e2e-rig.sh <command>
#
#   db     create `truestock_e2e` on the compose MariaDB, migrate it, seed the
#          catalog. Idempotent for the create and the migrate; the seed is the
#          repo's own `db:seed`, so read db/README.md before re-running it.
#   prod   build and serve THIS checkout in a throwaway container on
#          127.0.0.1:3101 (the production build: nonce CSP, real hydration).
#          This is what the suite should target. A build takes ~5 minutes.
#   dev    `next dev` on 127.0.0.1:3100. Faster feedback, but NOT what to trust:
#          dev skips the CSP and reloads the page when the network drops.
#   down   remove both throwaway containers.
#
# Why a throwaway container and not `docker compose up`: it runs the checkout you
# are standing in (a worktree, say) without touching the main stack, and it
# reuses that stack's node_modules volume READ-ONLY with `.next` on tmpfs, so it
# creates no volumes and writes almost nothing to the host disk.
#
# The env file holds secrets (BETTER_AUTH_SECRET, passwords). Keep it outside the
# repo; this script only passes its path to docker and never prints it.
set -euo pipefail

CMD="${1:-}"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

COMPOSE_PROJECT="${E2E_COMPOSE_PROJECT:-truestock}"   # the main stack's compose project name
NETWORK="${COMPOSE_PROJECT}_default"
MODULES_VOLUME="${COMPOSE_PROJECT}_truestock-node-modules"
E2E_DB="truestock_e2e"

need_env_file() {
  if [ -z "${E2E_ENV_FILE:-}" ] || [ ! -f "$E2E_ENV_FILE" ]; then
    echo "E2E_ENV_FILE must point at an existing env file (see .env.e2e.example)" >&2
    exit 2
  fi
}

# The invoice directory is bind-mounted at the SAME path inside and outside the
# container: the suite and the app resolve INVOICE_STORAGE_DIR independently, and
# a mismatch fails as phantom 404s on invoice files, not as an error.
invoice_dir() {
  grep -E '^INVOICE_STORAGE_DIR=' "$E2E_ENV_FILE" | head -1 | cut -d= -f2-
}

run_container() {
  local mode="$1" port name cmd inv
  name="truestock-e2e-$mode"
  if [ "$mode" = "prod" ]; then
    port=3101
    cmd='node scripts/copy-zxing-wasm.mjs && npx next build && npx next start -H 0.0.0.0'
  else
    port=3100
    cmd='npx next dev -H 0.0.0.0'
  fi
  inv="$(invoice_dir)"
  [ -n "$inv" ] || { echo "INVOICE_STORAGE_DIR is not set in E2E_ENV_FILE" >&2; exit 2; }
  mkdir -p "$inv"

  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --network "$NETWORK" \
    -v "$ROOT":/app \
    -v "$MODULES_VOLUME":/app/node_modules:ro \
    --tmpfs /app/.next:rw,size=2g,mode=1777 \
    --tmpfs /tmp:rw,size=256m,mode=1777 \
    -v "$inv":"$inv" \
    --env-file "$E2E_ENV_FILE" \
    -e "DATABASE_URL=mysql://truestock:truestock@db:3306/$E2E_DB" \
    -e "BETTER_AUTH_URL=http://localhost:$port" \
    -p "127.0.0.1:$port:3000" \
    truestock-app sh -c "$cmd" >/dev/null
  echo "started $name on 127.0.0.1:$port"
  if [ "$mode" = "prod" ]; then
    echo "the production build is running now; wait for it with:"
    echo "  until curl -fsS -o /dev/null http://127.0.0.1:$port/login; do sleep 3; done"
  fi
}

case "$CMD" in
  db)
    # `root`/`root` are the local-only compose credentials, already committed in
    # docker-compose.yml. They are needed once, to CREATE the database.
    # -p, because compose otherwise derives the project from this directory's
    # name, which from a worktree is not the stack that is actually running.
    docker compose -p "$COMPOSE_PROJECT" exec -T db mariadb -uroot -proot < docker/mariadb/init/02-e2e-database.sql
    export DATABASE_URL="mysql://truestock:truestock@127.0.0.1:3307/$E2E_DB"
    bun run db:migrate
    bun run db:seed
    echo "database $E2E_DB ready. Next: create the three accounts (e2e/README.md, 'Building the rig')."
    ;;
  prod | dev)
    need_env_file
    run_container "$CMD"
    ;;
  down)
    docker rm -f truestock-e2e-prod truestock-e2e-dev >/dev/null 2>&1 || true
    echo "removed truestock-e2e-prod and truestock-e2e-dev"
    ;;
  *)
    echo "usage: E2E_ENV_FILE=... bash scripts/e2e-rig.sh db|prod|dev|down" >&2
    exit 2
    ;;
esac
