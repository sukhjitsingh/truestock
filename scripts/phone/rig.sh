#!/usr/bin/env bash
#
# A real phone against THIS checkout's production build, with no Docker.
#
#   bun run phone:rig up            build must exist; serves it, tunnels it, opens it
#   bun run phone:rig server-down   stop the server only (the "server unreachable" drill)
#   bun run phone:rig server-up     start it again
#   bun run phone:rig status
#   bun run phone:rig down          stop the server, remove the tunnels
#
# Why this exists beside scripts/prod-lan.sh: that script rebuilds the Docker
# app container from the main checkout. This one serves whatever `bun run build`
# last produced HERE (a worktree, a branch under test) and leaves Docker alone.
#
# How the phone reaches it: `adb reverse`, not the LAN. The phone opens
# http://localhost:PORT and adb carries it to 127.0.0.1:PORT on this laptop.
#   - localhost is a secure context, so the camera and IndexedDB work without a
#     certificate or the self-signed warning;
#   - nothing listens on the LAN, so the macOS firewall never prompts and
#     Chrome's "Nearby devices" (local network) permission is not involved;
#   - BETTER_AUTH_URL is exactly the origin the phone uses, so sign-in works in
#     production mode (prod-lan.sh explains why a mismatched origin 403s).
# The cost: the tunnel rides wireless debugging. Turning the phone's Wi-Fi off
# drops adb too, and Android asks to allow wireless debugging again on a NEW
# port when it returns — run `up` again then. For "online but the server is
# unreachable" (open item #46, F3) use server-down / server-up instead: the
# phone stays online and only the server goes away.
#
# Production, not `next dev`: dev's HMR reloads the page when the network
# drops, which makes the offline queue untestable (docs/phone-count-test.md).
#
# Env: PORT (3204), CDP_PORT (9333), ENV_FILE (.env.local — its DATABASE_URL
# decides which database the phone writes to), ADB_SERIAL (auto).
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT="${PORT:-3204}"
CDP_PORT="${CDP_PORT:-9333}"
ENV_FILE="${ENV_FILE:-.env.local}"
STATE_DIR=".phone-sessions"
PID_FILE="$STATE_DIR/rig-server-$PORT.pid"
LOG_FILE="$STATE_DIR/rig-server-$PORT.log"
mkdir -p "$STATE_DIR"

die() { echo "error: $*" >&2; exit 1; }

# Pick a device in state "device". If the only one is offline (Wi-Fi dropped,
# port changed), restart adb and try every port mDNS has seen, newest first —
# its cache keeps stale ports, so a blind `adb connect` to the first is wrong.
ensure_device() {
  if [ -n "${ADB_SERIAL:-}" ]; then echo "$ADB_SERIAL"; return; fi
  local serial
  serial=$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')
  if [ -z "$serial" ]; then
    echo "No adb device online — restarting adb and searching mDNS…" >&2
    adb kill-server >/dev/null 2>&1 || true
    adb start-server >/dev/null 2>&1
    sleep 2
    for addr in $(adb mdns services | awk '/_adb-tls-connect/ {print $3}' | awk '!seen[$0]++' | tail -r); do
      if adb connect "$addr" 2>/dev/null | grep -q "^connected"; then serial="$addr"; break; fi
    done
  fi
  [ -n "$serial" ] || die "no phone. On the phone: Developer options → Wireless debugging ON (same Wi-Fi), then re-run."
  echo "$serial"
}

server_pid() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null && cat "$PID_FILE"; }

server_up() {
  [ -f .next/BUILD_ID ] || die "no production build here — run: bun run build && git checkout -- AGENTS.md"
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found"
  if server_pid >/dev/null; then echo "server already running (pid $(server_pid))"; return; fi
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then die "port $PORT is taken by something else"; fi
  BETTER_AUTH_URL="http://localhost:$PORT" NODE_ENV=production \
    nohup node --env-file="$ENV_FILE" node_modules/next/dist/bin/next start -p "$PORT" -H 127.0.0.1 \
    >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/login" 2>/dev/null && { echo "server up on 127.0.0.1:$PORT (pid $(cat "$PID_FILE"), log $LOG_FILE)"; return; }
    sleep 1
  done
  die "server did not answer; see $LOG_FILE"
}

server_down() {
  local pid
  if pid=$(server_pid); then kill "$pid"; rm -f "$PID_FILE"; echo "server stopped (pid $pid)"; else echo "server not running"; fi
}

case "${1:-status}" in
  up)
    server_up
    serial=$(ensure_device)
    adb -s "$serial" reverse "tcp:$PORT" "tcp:$PORT" >/dev/null
    adb -s "$serial" forward "tcp:$CDP_PORT" localabstract:chrome_devtools_remote >/dev/null
    adb -s "$serial" shell input keyevent KEYCODE_WAKEUP
    adb -s "$serial" shell am start -a android.intent.action.VIEW -d "http://localhost:$PORT/login" -p com.android.chrome >/dev/null
    db=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tr -d "\"'" | sed -E 's#.*/([^/?]+).*#\1#')
    cat <<EOF

  Phone:     $serial
  Open:      http://localhost:$PORT  (Chrome on the phone; already opened)
  Database:  $db  (from $ENV_FILE)
  DevTools:  http://127.0.0.1:$CDP_PORT  (bun run phone:a11y / phone:observe use it)
  Watch:     bun run phone:observe -- --origin http://localhost:$PORT --cdp http://127.0.0.1:$CDP_PORT

EOF
    ;;
  server-down) server_down ;;
  server-up) server_up ;;
  status)
    if pid=$(server_pid); then echo "server: up (pid $pid, port $PORT)"; else echo "server: down"; fi
    adb devices -l | sed 1d | sed '/^$/d' | sed 's/^/adb:    /'
    adb reverse --list 2>/dev/null | sed '/^$/d' | sed 's/^/reverse: /' || true
    ;;
  down)
    server_down
    adb reverse --remove "tcp:$PORT" 2>/dev/null || true
    adb forward --remove "tcp:$CDP_PORT" 2>/dev/null || true
    echo "tunnels removed"
    ;;
  *) die "usage: $0 up|server-down|server-up|status|down" ;;
esac
