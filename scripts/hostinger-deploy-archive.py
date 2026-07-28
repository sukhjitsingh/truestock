#!/usr/bin/env python3
"""Ship a prebuilt Next.js standalone archive to Hostinger's Node.js hosting.

Calls `POST /api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/
builds/from-archive` (Hostinger API, beta — see
https://github.com/hostinger/api-typescript-sdk). Verified against the SDK's
own generated client (api.ts): despite the archive being a binary file, the
endpoint takes a JSON body with the archive base64-encoded inline as the
`archive` string field — not multipart/form-data. Maximum archive size is
50MB *before* base64 (so up to ~67MB on the wire); this script enforces the
50MB pre-encoding limit itself so a failure is obvious rather than a 422 from
the API.

Deliberately overrides only `build_script` and `entry_file`:
- `build_script` points at a no-op script this repo's deploy workflow writes
  into the shipped package.json (see .github/workflows/deploy.yml) — the
  real `next build` already ran in GitHub Actions (spec §11's whole reason
  for building off-host), so Hostinger's own build step has nothing left to
  do beyond its own automatic install pass.
- `entry_file` points at `server.js`, the standalone output's entry point.

`app_type`, `root_directory`, `output_directory`, and `package_manager` are
left to Hostinger's auto-detection deliberately: the shipped archive still
contains `.next/`, `node_modules`, and a package.json naming next/react as
dependencies, which should be enough signal to detect "Next.js" correctly.
This is the one part of the pipeline that hasn't been exercised against a
live account (no credentials available while writing it) — read the printed
build options back from the response on the first real deploy and compare
against what you expected; override the extra fields here if detection
guesses wrong.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_ARCHIVE_BYTES = 50 * 1024 * 1024


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <path-to-archive.zip>", file=sys.stderr)
        return 2
    archive_path = sys.argv[1]

    size = os.path.getsize(archive_path)
    if size > MAX_ARCHIVE_BYTES:
        print(
            f"Archive is {size} bytes, over Hostinger's {MAX_ARCHIVE_BYTES}-byte "
            "createNodeJSBuildFromArchiveV1 limit. Trim dependencies or see "
            "docs/deploy.md's fallback plan.",
            file=sys.stderr,
        )
        return 1

    with open(archive_path, "rb") as f:
        archive_b64 = base64.b64encode(f.read()).decode("ascii")

    username = os.environ["HOSTINGER_USERNAME"]
    domain = os.environ["HOSTINGER_DOMAIN"]
    token = os.environ["HOSTINGER_API_TOKEN"]
    node_version = int(os.environ.get("HOSTINGER_NODE_VERSION", "22"))

    payload = {
        "archive": archive_b64,
        "node_version": node_version,
        "build_script": "noop-build",
        "entry_file": "server.js",
    }

    url = (
        "https://developers.hostinger.com/api/hosting/v1/accounts/"
        f"{urllib.parse.quote(username)}/websites/{urllib.parse.quote(domain)}"
        "/nodejs/builds/from-archive"
    )

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"Hostinger API returned {e.code}: {e.read().decode('utf-8', 'replace')}", file=sys.stderr)
        return 1

    print(json.dumps(body, indent=2))

    uuid = body.get("uuid")
    if not uuid:
        print("No build uuid in response — cannot poll for completion.", file=sys.stderr)
        return 1

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"build_uuid={uuid}\n")
    else:
        print(f"BUILD_UUID={uuid}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
