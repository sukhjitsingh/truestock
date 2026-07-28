#!/usr/bin/env bash
# Assembles the Next.js `output: 'standalone'` build into the archive shape
# Hostinger's from-archive API expects, per Next's own documented standalone
# deployment recipe: `.next/standalone/` is the app root, but it does not
# include `.next/static/` or `public/` — those are copied in by hand.
#
# Also injects a `noop-build` script into the shipped package.json. The real
# `next build` already ran (this script assumes it just did, in CI) — this
# repo's whole reason for building off-host (spec §11) is to keep that
# expensive step off Hostinger's shared 3GB box. Overriding the archive
# deploy's `build_script` to this no-op is what actually accomplishes that;
# see scripts/hostinger-deploy-archive.py for the deploy call itself.
#
# Usage: scripts/package-standalone.sh [output-zip-path]
set -euo pipefail

OUT_ZIP="${1:-deploy/truestock-deploy.zip}"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

if [ ! -d ".next/standalone" ]; then
  echo "package-standalone: .next/standalone not found — run 'bun run build' first." >&2
  exit 1
fi

cp -r .next/standalone/. "$STAGE_DIR/"
mkdir -p "$STAGE_DIR/.next"
cp -r .next/static "$STAGE_DIR/.next/static"
if [ -d public ]; then
  cp -r public "$STAGE_DIR/public"
fi

node -e '
  const fs = require("fs");
  const path = process.argv[1] + "/package.json";
  const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
  pkg.scripts = Object.assign({}, pkg.scripts, { "noop-build": "true" });
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2));
' "$STAGE_DIR"

mkdir -p "$(dirname "$OUT_ZIP")"
rm -f "$OUT_ZIP"
( cd "$STAGE_DIR" && zip -qr - . ) > "$OUT_ZIP"

echo "package-standalone: wrote $OUT_ZIP ($(du -h "$OUT_ZIP" | cut -f1))"
