#!/usr/bin/env bash
#
# Publish the dev server on the LAN so a real phone can run a real count.
#
# This exists because the counting app is the one part of Truestock that
# cannot be verified from this machine. Scanning a barcode needs a camera, a
# bottle, and a dim room; the sub-20-minute target the whole design is
# justified by needs a stopwatch and a bar. STATE.md calls this the biggest
# unknown in the project.
#
# Three things have to line up, and each fails in a way that looks like
# something else:
#
#   1. The published port. docker-compose.yml binds 127.0.0.1 by default, so
#      the phone sees a dead host. That one at least fails honestly.
#   2. Better Auth's trustedOrigins. Missing origin -> 403 -> the login form's
#      deliberately generic "check your email and password". You will blame
#      the password. See the long comment in lib/auth.ts.
#   3. A secure context. navigator.mediaDevices simply does not exist on a
#      plain-http origin, so the scanner reports a camera problem when the
#      actual problem is the URL. That one is on the phone, not here — see
#      the chrome://flags step printed at the end.
#
# Nothing here touches production. APP_BIND and DEV_LAN_ORIGIN are read only
# by docker-compose.yml, and DEV_LAN_ORIGIN only ever widens dev-only
# allowlists that are skipped entirely when NODE_ENV=production.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT=3000

# en0 is wired on most Macs and Wi-Fi on laptops; en1 covers the other case.
# Deliberately not `hostname -I` (Linux-only) or a `route get` parse — this
# script only ever runs on the developer's Mac.
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

TLS_PORT=3443

origin="http://${lan_ip}:${PORT}"
tls_origin="https://${lan_ip}:${TLS_PORT}"

# A self-signed certificate that NAMES THE IP. A CN alone is not enough —
# every current browser requires the address in subjectAltName and rejects the
# certificate outright without it, which looks like a server fault rather than
# a certificate one. Regenerated whenever the IP changes, since the old cert
# names an address the phone is no longer using.
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

# Exported so `docker compose` interpolates them into docker-compose.yml.
# Changing them is what makes Compose recreate the app container, which is
# also what picks up the next.config.ts change — `next dev` reads its config
# once at boot.
#
# BOTH origins are trusted: the plain-http one for counting without any phone
# setup, and the https one for the camera. Scheme and port each make a
# distinct origin, so Better Auth needs to be told about both explicitly.
export APP_BIND=0.0.0.0
export DEV_LAN_ORIGIN="${origin},${tls_origin}"

echo "Publishing on ${origin} and ${tls_origin} (was 127.0.0.1 only)"
docker compose --profile tls up -d --wait

cat <<EOF

  SCAN AND COUNT (use this one):   ${tls_origin}/count/preflight
  No camera, no setup:             ${origin}/count/preflight

  Both devices must be on the same Wi-Fi. If nothing loads at all, it is
  almost always macOS's firewall — System Settings > Network > Firewall.

  The https address is the one to use. The camera is only exposed to a
  "secure context", which in practice means https — so scanning works there
  and nowhere else. Your browser will warn once that the certificate is not
  trusted: that is expected. The certificate is self-signed and names this
  machine's IP; accepting it still gives a real secure context, because the
  warning is about identity, not encryption.

    Chrome/Samsung Internet:  Advanced -> Proceed to ${lan_ip} (unsafe)
    Firefox:                  Advanced -> Accept the Risk and Continue

  Do that once per phone. Then open the preflight URL above and confirm
  "Secure context: Yes" before counting.

  The plain-http address still works for everything except the camera, so
  quantity and search-picker counting need no setup at all.

  Both URLs embed the IP, and it changes when the router hands out a new
  lease. Re-run this script when that happens — it regenerates the
  certificate for the new address.

  When you are done:  bun run docker:down && bun run docker:up
                      (stops the TLS proxy, restores the loopback-only bind)

EOF
