#!/usr/bin/env bash
# Runs the scorer (scripts/ocr-bench/score) in a throwaway, offline, memory-capped container from the app image,
# with the worktree mounted read-only at /app. One container at a time; nothing is pruned.
#
#   run-score.sh derive-gt   derive BENCH/gt/scan.json from the saved library-OCR markdown (prints counts and booleans)
#   run-score.sh score       score BENCH/out/* against BENCH/gt, write BENCH/report/{summary.txt,detail.txt,scores.json}
#   run-score.sh synthetic   the full pipeline on invented data under the container's /tmp (the dry run)
#   run-score.sh test        bun test of score/score.test.ts (synthetic data only)
#
# Privacy: every mode prints structure only (counts, booleans, codes); real content is read from BENCH and never echoed.
set -uo pipefail
. "$(dirname "$0")/common.sh"
WT="$(cd "$(dirname "$0")/../../.." && pwd)"
# Directory of saved library-OCR markdown renders (<id>-d<dpi>.md) the ground truth is derived from. Private; override
# with OCRB_LIBOCR. The default is the directory the recorded runs used.
LIBOCR="${OCRB_LIBOCR:-/Users/moni/.claude/jobs/c23a2caa/tmp/pdfcmp/ocr-dpi}"
MODE="${1:-}"
SCORER=scripts/ocr-bench/score/score.ts

guard
mkdir -p "$BENCH/gt" "$BENCH/report" "$BENCH/out"

run_bun() {
  # Extra docker arguments come first (mounts), then "--", then the bun arguments.
  local extra=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do extra+=("$1"); shift; done
  shift
  docker run --rm --network none --memory=1g --memory-swap=1g --cpus=2 --entrypoint bun \
    -v "$WT":/app:ro -w /app ${extra[@]+"${extra[@]}"} "$IMAGE" "$@"
}

case "$MODE" in
  derive-gt)
    run_bun -v "$BENCH/gt":/work/gt -v "$LIBOCR":/work/libocr:ro -- "$SCORER" derive-gt --bench /work --libocr /work/libocr
    ;;
  score)
    run_bun -v "$BENCH/out":/work/out:ro -v "$BENCH/gt":/work/gt:ro -v "$BENCH/report":/work/report -v "$LIBOCR":/work/libocr:ro -- \
      "$SCORER" score --bench /work --libocr /work/libocr
    ;;
  synthetic)
    run_bun -- "$SCORER" synthetic
    ;;
  test)
    run_bun -- test --timeout 30000 scripts/ocr-bench/score/score.test.ts
    ;;
  *)
    echo "usage: run-score.sh derive-gt|score|synthetic|test" >&2
    exit 2
    ;;
esac
