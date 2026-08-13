#!/usr/bin/env bash
#
# Wraps `docker compose up -d --wait` and refuses when a LAN session (dev or
# production) looks live — open item #24.
#
# Why this exists: `bun run docker:up` used to be a bare `docker compose up`.
# Run it while `bun run docker:up:lan` or `bun run docker:up:prod` is
# publishing the app to a real phone mid-count, and it silently reverts
# APP_BIND to 127.0.0.1 and DEV_LAN_ORIGIN to empty — the phone drops off the
# network with nothing in this terminal saying why. That is this project's
# worst failure mode (AGENTS.md: "a plausible-but-wrong default is more
# dangerous than an obviously broken one") applied to infrastructure instead
# of data: the command reports success and the failure is discovered by the
# person holding the bottle, not by whoever ran `docker:up`.
#
# Gate 2 originally proposed a gitignored state file
# (.truestock-lan-state.json) written by dev-lan.sh/prod-lan.sh. Gate 3
# objected (Amendment 3, 02-architecture.md, 2026-08-12): the file's only
# failure mode is staleness, and this guard has to reconcile against real
# container state regardless of what the file says — so the file adds no
# information `docker inspect` doesn't already have, while introducing a
# false-refusal risk that doesn't exist without a file to go stale. This
# script inspects the running containers directly. No state file, no
# .gitignore entry.
#
# Detection, in order of how directly it is observable:
#
#   1. The `tls` proxy container (truestock-tls) is running. Both
#      dev-lan.sh and prod-lan.sh start it via `--profile tls`; a plain
#      `docker compose up` (this script's own fallback) never does. This is
#      the single clearest signal and covers both dev and prod LAN sessions
#      with one check.
#   2. The app container's DEV_LAN_ORIGIN env var (read via `docker inspect`
#      .Config.Env) is non-empty — set only by dev-lan.sh.
#   3. The app container's published port for 3000/tcp is NOT bound to
#      127.0.0.1 (read via `docker inspect` .NetworkSettings.Ports) — this is
#      the observable effect of APP_BIND=0.0.0.0, set by BOTH dev-lan.sh and
#      prod-lan.sh. APP_BIND itself is a host-side `docker compose`
#      interpolation variable for the `ports:` mapping, not a container
#      environment variable (docker-compose.yml's `environment:` block does
#      not list it) — so its EFFECTIVE value is only observable through the
#      resulting port binding, which `docker inspect` exposes directly. This
#      is what makes an already-live prod-lan session detectable even though
#      prod-lan.sh explicitly sets DEV_LAN_ORIGIN="" (see that script).
#
# Any one of the three is treated as "a LAN session looks live."
set -euo pipefail

cd "$(dirname "$0")/.."

APP_CONTAINER="truestock-app"
TLS_CONTAINER="truestock-tls"

# If the Docker daemon itself is unreachable, this guard has nothing to
# inspect — fall through to the real command, which will fail with Docker's
# own (clear) error rather than a misleading guard message.
if ! docker info >/dev/null 2>&1; then
  exec docker compose up -d --wait
fi

# `docker inspect` on a container that does not exist exits non-zero and
# prints to stderr; that is exactly "not running" for this guard's purposes,
# so failures below are swallowed via `|| true` / `2>/dev/null` rather than
# tripping `set -e`.

tls_running="false"
if state="$(docker inspect -f '{{.State.Running}}' "$TLS_CONTAINER" 2>/dev/null)"; then
  tls_running="$state"
fi

dev_lan_origin=""
app_bind_host_ip=""
node_env=""
if app_env_running="$(docker inspect -f '{{.State.Running}}' "$APP_CONTAINER" 2>/dev/null)" \
   && [ "$app_env_running" = "true" ]; then
  # .Config.Env is a flat list of "KEY=VALUE" strings — grep the one line we
  # want rather than trying to template a lookup in Go's text/template.
  dev_lan_origin="$(
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$APP_CONTAINER" 2>/dev/null \
      | grep '^DEV_LAN_ORIGIN=' | head -1 | cut -d= -f2- || true
  )"
  node_env="$(
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$APP_CONTAINER" 2>/dev/null \
      | grep '^NODE_ENV=' | head -1 | cut -d= -f2- || true
  )"
  app_bind_host_ip="$(
    docker inspect -f '{{(index (index .NetworkSettings.Ports "3000/tcp") 0).HostIp}}' \
      "$APP_CONTAINER" 2>/dev/null || true
  )"
fi

lan_live="false"
if [ "$tls_running" = "true" ]; then
  lan_live="true"
fi
if [ -n "$dev_lan_origin" ]; then
  lan_live="true"
fi
if [ -n "$app_bind_host_ip" ] && [ "$app_bind_host_ip" != "127.0.0.1" ]; then
  lan_live="true"
fi

if [ "$lan_live" = "true" ]; then
  if [ "$node_env" = "production" ]; then
    running_as="docker:up:prod"
  else
    running_as="docker:up:lan"
  fi
  cat >&2 <<EOF
error: refusing to run — a LAN session looks live.

  ${running_as} is what's running (tls proxy running: ${tls_running};
  DEV_LAN_ORIGIN: "${dev_lan_origin}"; app port 3000 bound to:
  ${app_bind_host_ip:-<not published>}).

  Running 'docker compose up' now would silently revert APP_BIND and
  DEV_LAN_ORIGIN to their loopback-only defaults, dropping any phone
  connected to this session mid-count with nothing on screen explaining why.

  Fix:  bun run docker:down
        (then re-run 'bun run docker:up')
EOF
  exit 1
fi

exec docker compose up -d --wait
