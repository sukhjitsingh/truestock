#!/usr/bin/env bash
# One-time provisioning for the OCR bench. Documents (and redoes) everything that needs the network.
# Measured runs never use the network; only the steps below do, each in a throwaway container.
#
# Usage (absolute path, no cd):
#   /Users/.../scripts/ocr-bench/run/provision.sh npm        # install node_modules into BENCH/nm
#   /Users/.../scripts/ocr-bench/run/provision.sh models     # tessdata (fast, best_int); ppocr is a plain copy, see below
#   /Users/.../scripts/ocr-bench/run/provision.sh granite    # Granite-Docling ONNX into BENCH/models/hf (network)
#   /Users/.../scripts/ocr-bench/run/provision.sh render     # PDFs -> BENCH/img/*.png (+ manifest.json), offline
#   /Users/.../scripts/ocr-bench/run/provision.sh all        # npm, models, render (granite is opt-in)
#
# Guard: refuses to download anything when the volume holding BENCH has < 4 GiB free.
#
# Facts recorded here so a cold session can redo it:
#   * Install runs with ONNXRUNTIME_NODE_INSTALL_CUDA=skip (otherwise onnxruntime-node pulls CUDA libs).
#   * package.json "overrides" force ONE onnxruntime-node and ONE onnxruntime-web (transformers.js 4.3.1 would
#     otherwise bring 1.30.0 / 1.31.0-dev). Check with `npm ls onnxruntime-node onnxruntime-web onnxruntime-common`.
#   * node_modules is installed in BENCH/nm-src (a copy of package.json) and then moved to BENCH/nm.
#   * PP-OCRv6-small files are COPIED from the earlier library cache, not downloaded:
#       .../pdfcmp/rt/models/pp-ocrv6-small/oar-ocr-v0.7.0/pp-ocrv6_small_det.onnx -> models/ppocr/det.onnx
#       .../pp-ocrv6_small_rec.onnx                                                 -> models/ppocr/rec.onnx
#       .../ppocrv6_dict.txt                                                        -> models/ppocr/dict.txt
#   * @tesseract.js-data/eng@1.0.0 ships only 4.0.0 (full tessdata) and 4.0.0_best_int (gzipped). There is NO
#     4.0.0_fast in it, so "fast" comes from the official tesseract-ocr/tessdata_fast repo (tag 4.1.0) and
#     "best_int" from the npm package. See run/fetch-tessdata.mjs.
set -euo pipefail

SELF="$(dirname "$0")"
# shellcheck source=common.sh
. "$SELF/common.sh"
STEP="${1:-all}"

MOUNTS=()
while IFS= read -r line; do MOUNTS+=("$line"); done < <(harness_mounts)

step_npm() {
  guard
  mkdir -p "$BENCH/nm-src" "$BENCH/nm"
  cp "$HARNESS/package.json" "$BENCH/nm-src/package.json"
  docker run --rm --name ocrb-provision-npm \
    -e ONNXRUNTIME_NODE_INSTALL_CUDA=skip -e npm_config_update_notifier=false \
    -v "$BENCH/nm-src":/src -w /src --entrypoint npm "$IMAGE" \
    install --no-audit --no-fund
  if [ -d "$BENCH/nm-src/node_modules" ]; then
    rm -rf "$BENCH/nm"
    mv "$BENCH/nm-src/node_modules" "$BENCH/nm"
  fi
  echo "--- npm ls (duplicates check)"
  docker run --rm --name ocrb-provision-ls \
    -v "$BENCH/nm-src":/src -v "$BENCH/nm":/src/node_modules -w /src --entrypoint npm "$IMAGE" \
    ls onnxruntime-node onnxruntime-web onnxruntime-common || true
  rmdir "$BENCH/nm-src/node_modules" 2>/dev/null || true
  du -sh "$BENCH/nm"
}

# Networked container for HARNESS scripts that download into BENCH/models.
net_node() {
  docker run --rm --name ocrb-provision-net --memory=3g --memory-swap=3g \
    "${MOUNTS[@]}" -v "$BENCH/models":/work/models -w /bench \
    --entrypoint node "$IMAGE" "$@"
}

step_models() {
  guard
  mkdir -p "$BENCH/models/ppocr" "$BENCH/models/tessdata/fast" "$BENCH/models/tessdata/best_int"
  net_node /bench/run/fetch-tessdata.mjs
  ls -la "$BENCH/models/ppocr" "$BENCH/models/tessdata/fast" "$BENCH/models/tessdata/best_int"
}

step_granite() {
  guard
  mkdir -p "$BENCH/models/hf"
  net_node /bench/run/fetch-granite.mjs "$@"
  du -sh "$BENCH/models/hf"
}

step_render() {
  # Offline: real PDFs mounted read-only, images written to BENCH/img.
  # The input directories hold private documents and are never part of the repo. Override with OCRB_SCAN_DIR and
  # OCRB_PHOTO_DIR; the defaults are the directories the recorded runs used.
  local scan_dir="${OCRB_SCAN_DIR:-/Users/moni/Claude_Workspace/truestock/var/invoices/1}"
  local photo_dir="${OCRB_PHOTO_DIR:-/Users/moni/.claude/jobs/c23a2caa/tmp/pdfcmp/photo}"
  guard
  docker run --rm --name ocrb-provision-render --network none \
    "${MOUNTS[@]}" \
    -v "$scan_dir":/in/scan:ro \
    -v "$photo_dir":/in/photo:ro \
    -v "$BENCH/img":/work/img -w /bench --entrypoint node "$IMAGE" \
    /bench/run/render-images.mjs "$@"
}

case "$STEP" in
  npm) step_npm ;;
  models) step_models ;;
  granite) shift; step_granite "$@" ;;
  render) shift; step_render "$@" ;;
  all) step_npm; step_models; step_render ;;
  *) echo "unknown step: $STEP" >&2; exit 1 ;;
esac
