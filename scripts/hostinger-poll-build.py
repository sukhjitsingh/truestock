#!/usr/bin/env python3
"""Poll a Hostinger Node.js build until it finishes, streaming logs.

Uses `GET .../nodejs/builds/{uuid}/logs` (with `from_line` to fetch only new
output each time — documented for exactly this polling pattern) and
`GET .../nodejs/builds` to read the build's current `state`. Exits non-zero
if the build fails or doesn't reach a terminal state within the timeout, so
the calling workflow step fails loudly rather than silently deploying
nothing.

The exact shape of the list endpoint's pagination envelope (whether builds
sit under a `data` key or are returned as a bare array) was not verified
against a live account — this script tries both. Confirm on the first real
deploy and simplify if one shape turns out to be the only one.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

POLL_INTERVAL_SECONDS = 5
TIMEOUT_SECONDS = 10 * 60
TERMINAL_STATES = {"completed", "failed"}


def api_get(url: str, token: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def extract_builds(listing) -> list:
    if isinstance(listing, list):
        return listing
    if isinstance(listing, dict):
        return listing.get("data") or listing.get("builds") or []
    return []


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <build-uuid>", file=sys.stderr)
        return 2
    build_uuid = sys.argv[1]

    username = os.environ["HOSTINGER_USERNAME"]
    domain = os.environ["HOSTINGER_DOMAIN"]
    token = os.environ["HOSTINGER_API_TOKEN"]
    base = (
        f"https://developers.hostinger.com/api/hosting/v1/accounts/{username}"
        f"/websites/{domain}/nodejs/builds"
    )

    from_line = 0
    state = "pending"
    deadline = time.time() + TIMEOUT_SECONDS

    while time.time() < deadline:
        try:
            logs = api_get(f"{base}/{build_uuid}/logs?from_line={from_line}", token)
        except urllib.error.HTTPError as e:
            print(f"log fetch failed ({e.code}), retrying: {e.read().decode('utf-8', 'replace')}")
            time.sleep(POLL_INTERVAL_SECONDS)
            continue

        if logs.get("logs"):
            sys.stdout.write(logs["logs"])
            sys.stdout.flush()
        from_line += logs.get("lines", 0)

        listing = api_get(f"{base}?per_page=10", token)
        match = next((b for b in extract_builds(listing) if b.get("uuid") == build_uuid), None)
        if match:
            state = match.get("state", state)

        if state in TERMINAL_STATES:
            break
        time.sleep(POLL_INTERVAL_SECONDS)

    print(f"\nFinal build state: {state}")
    if state != "completed":
        print(
            "Build did not complete successfully — the previous deployment "
            "is still live (Hostinger doesn't cut over until a build "
            "succeeds; see docs/deploy.md's 'what breaks halfway' section). "
            "Check the logs above.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
