#!/usr/bin/env bash
# Applies pending migrations to production over an SSH tunnel, then closes
# it. Never runs on app boot (CLAUDE.md; open-items.md #6) — this script is
# the one explicit, gated place migrations get applied, called from
# deploy.yml's `migrate` job before the `deploy` job ships new code.
#
# Deliberately tunnels through SSH rather than opening MySQL to the public
# internet: Cloud Startup's MySQL is shared with the restaurant website's
# database on the same 100-connection cap (CLAUDE.md), and GitHub Actions
# runner IP ranges are broad and change often — allow-listing them for a
# direct remote MySQL connection would mean leaving that port open to most
# of GitHub's IP space indefinitely. SSH access is already available and
# already gated by a key (Hostinger support: SSH is available on Cloud
# hosting plans), so tunneling through it adds no new exposed surface.
#
# Requires these environment variables (set as GitHub Actions secrets — see
# docs/deploy.md):
#   HOSTINGER_SSH_HOST, HOSTINGER_SSH_PORT, HOSTINGER_SSH_USER,
#   HOSTINGER_SSH_PRIVATE_KEY (the private key text itself)
#   HOSTINGER_DB_USER, HOSTINGER_DB_PASSWORD, HOSTINGER_DB_NAME
set -euo pipefail

: "${HOSTINGER_SSH_HOST:?}"
: "${HOSTINGER_SSH_PORT:?}"
: "${HOSTINGER_SSH_USER:?}"
: "${HOSTINGER_SSH_PRIVATE_KEY:?}"
: "${HOSTINGER_DB_USER:?}"
: "${HOSTINGER_DB_PASSWORD:?}"
: "${HOSTINGER_DB_NAME:?}"

LOCAL_PORT="${LOCAL_TUNNEL_PORT:-13306}"
SSH_DIR="$(mktemp -d)"
trap 'kill "$TUNNEL_PID" 2>/dev/null || true; rm -rf "$SSH_DIR"' EXIT

KEY_PATH="$SSH_DIR/id_deploy"
# Secrets arrive without a trailing newline sometimes; ssh-keygen/ssh are
# picky about key file formatting, so write it verbatim and let ssh itself
# be the judge.
printf '%s\n' "$HOSTINGER_SSH_PRIVATE_KEY" > "$KEY_PATH"
chmod 600 "$KEY_PATH"

KNOWN_HOSTS="$SSH_DIR/known_hosts"
ssh-keyscan -p "$HOSTINGER_SSH_PORT" "$HOSTINGER_SSH_HOST" > "$KNOWN_HOSTS" 2>/dev/null

echo "hostinger-migrate: opening tunnel to ${HOSTINGER_SSH_HOST}:${HOSTINGER_SSH_PORT}..."
ssh -i "$KEY_PATH" -o UserKnownHostsFile="$KNOWN_HOSTS" \
  -p "$HOSTINGER_SSH_PORT" -f -N \
  -L "${LOCAL_PORT}:127.0.0.1:3306" \
  "${HOSTINGER_SSH_USER}@${HOSTINGER_SSH_HOST}"

# `ssh -f` backgrounds itself after auth, so we recover its PID from the
# process list rather than `$!` (which would be the (already-exited)
# foreground launcher).
TUNNEL_PID="$(pgrep -f "L ${LOCAL_PORT}:127.0.0.1:3306" | head -n1)"

# Give the tunnel a moment before the first connection attempt.
for _ in $(seq 1 10); do
  if (exec 3<>"/dev/tcp/127.0.0.1/${LOCAL_PORT}") 2>/dev/null; then
    exec 3>&- 3<&-
    break
  fi
  sleep 1
done

export DATABASE_URL="mysql://${HOSTINGER_DB_USER}:${HOSTINGER_DB_PASSWORD}@127.0.0.1:${LOCAL_PORT}/${HOSTINGER_DB_NAME}"
echo "hostinger-migrate: running drizzle-kit migrate..."
bunx drizzle-kit migrate

echo "hostinger-migrate: done."
