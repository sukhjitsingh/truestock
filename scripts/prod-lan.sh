#!/usr/bin/env bash
#
# Run the app in PRODUCTION mode on the LAN, so a real phone can test the
# offline write queue.
#
# Why this is not scripts/dev-lan.sh with a flag: the two differ in ways that
# fail silently if confused, and this project has already been bitten once by
# an incidental `docker:up` reverting a live LAN session (open item #24).
#
# What dev cannot do, and this can:
#
#   1. Survive the network dropping. `next dev`'s HMR client reconnects a dead
#      websocket 12 times and then calls window.location.reload(). There is no
#      service worker, so that reload hits the browser's offline error page and
#      the app is gone — along with the only UI the IndexedDB queue has. The
#      walk-in test is simply unrunnable against a dev server, and it looks
#      like an app bug when it happens.
#   2. Exercise the real CSP. Dev's policy adds 'unsafe-eval' and `ws: wss:`;
#      production drops both and has never once run (STATE.md). A CSP that
#      breaks hydration is this project's single worst historical failure, and
#      it is invisible to curl — verify in a browser, not a status code.
#
# What you lose: hot reload. Source edits do NOT appear — the build is baked
# at container start. Re-run this script after changing code.
#
# When you are done:  bun run docker:down && bun run docker:up:lan
set -euo pipefail

cd "$(dirname "$0")/.."

PORT=3000
TLS_PORT=3443

# Same interface probe as dev-lan.sh; see that script for why it is not
# `hostname -I` or a `route get` parse.
lan_ip=""
for iface in en0 en1 en2; do
  if lan_ip=$(ipconfig getifaddr "$iface" 2>/dev/null) && [ -n "$lan_ip" ]; then
    break
  fi
  lan_ip=""
done

if [ -z "$lan_ip" ]; then
  echo "error: no LAN address on en0/en1/en2 — is Wi-Fi connected?" >&2
  exit 1
fi

origin="http://${lan_ip}:${PORT}"
tls_origin="https://${lan_ip}:${TLS_PORT}"

# The certificate must name the IP in subjectAltName — a CN alone is rejected
# outright by every current browser, which reads as a server fault rather than
# a certificate one. Regenerated when the IP changes.
cert_dir="docker/tls/certs"
mkdir -p "$cert_dir"
if [ ! -f "$cert_dir/dev-cert.pem" ] || \
   ! openssl x509 -in "$cert_dir/dev-cert.pem" -noout -text 2>/dev/null | grep -q "IP Address:${lan_ip}"; then
  echo "Generating a self-signed certificate for ${lan_ip}"
  openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
    -keyout "$cert_dir/dev-key.pem" -out "$cert_dir/dev-cert.pem" \
    -subj "/CN=${lan_ip}" \
    -addext "subjectAltName=IP:${lan_ip},IP:127.0.0.1,DNS:localhost" \
    >/dev/null 2>&1
fi

export APP_BIND=0.0.0.0

# The https origin, because that is the one the phone uses and the only one
# where the camera exists. In production mode this is what makes sign-in work
# at all — see the long comment in docker-compose.prod.yml.
export PROD_LAN_ORIGIN="${tls_origin}"

# Deliberately empty. DEV_LAN_ORIGIN only ever widens dev-only allowlists, and
# in production NODE_ENV those code paths are skipped entirely. Exporting it
# here would imply it does something, which is worse than not setting it.
export DEV_LAN_ORIGIN=""

echo "Building and starting in PRODUCTION mode on ${tls_origin}"
echo "(the build runs inside the container and takes a minute or two)"

docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile tls up -d

# Not `--wait`: the app container runs `next build` before it serves anything,
# which is far longer than any sensible healthcheck start period. Poll the
# thing we actually care about instead — a real 200 through the TLS proxy.
echo -n "Waiting for the production server"
for _ in $(seq 1 120); do
  if curl -sk -o /dev/null -w '%{http_code}' "${tls_origin}/login" 2>/dev/null | grep -q '^200$'; then
    echo " — up."
    break
  fi
  echo -n "."
  sleep 5
done

cat <<EOF

  PRODUCTION MODE. Hot reload is OFF — edits need this script re-run.

  USE THIS, AND ONLY THIS:   ${tls_origin}/count/preflight

  ${origin} still serves pages, but YOU CANNOT SIGN IN THERE in production
  mode — it returns 403 and the login form says "check your email and
  password", so it reads as a wrong password rather than a wrong URL. In dev
  both origins work, because DEV_LAN_ORIGIN lists both; production trusts only
  BETTER_AUTH_URL, which is the https one. Verified, not assumed: http origin
  403, https origin 401 (i.e. reached the password check).

  Two things differ from dev, and both are the point:

    * The HMR websocket is gone, so dropping the network no longer reloads
      the page out from under you. This is what makes the offline queue
      testable at all.
    * The CSP is the strict production policy — no 'unsafe-eval', no
      websocket. It still allows 'wasm-unsafe-eval', so the barcode scanner
      works. If a page renders but nothing responds to taps, that is the CSP
      and it is exactly the failure this project has hit before. A 200 proves
      nothing; open it in a browser.

  When you are done:  bun run docker:down && bun run docker:up:lan
                      (back to dev, with hot reload)

EOF
