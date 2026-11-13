#!/usr/bin/env bash
# Run tests/granite-synthetic.mjs inside a capped, offline container (synthetic page only, no real content).
#   tests/run-granite-synthetic.sh [mem=3g] [cpus=2] [test flags...]
#   tests/run-granite-synthetic.sh 3g 2 --parse-only          # unit checks of the DocTags parser and tile geometry
#   tests/run-granite-synthetic.sh 3g 2                        # also renders a synthetic page and runs the engine
#   tests/run-granite-synthetic.sh 3g 2 --modes tile512 --combo q8
# Outputs land in BENCH/out/_granite-synthetic/ (the test's --dir default is /work/out/_granite-synthetic).
SELF="$(dirname "${BASH_SOURCE[0]}")"
. "$SELF/../run/common.sh"
MEM="${1:-3g}"
CPUS="${2:-2}"
shift 2 2>/dev/null
guard
MOUNTS=()
while IFS= read -r line; do MOUNTS+=("$line"); done < <(harness_mounts)
NAME=ocrb-granite-synth
docker rm -f "$NAME" >/dev/null 2>&1
docker run --rm --name "$NAME" --network none --memory="$MEM" --memory-swap="$MEM" --cpus="$CPUS" \
  "${MOUNTS[@]}" -v "$BENCH/img":/work/img:ro -v "$BENCH/models":/work/models:ro -v "$BENCH/out":/work/out \
  -w /bench --entrypoint node "$IMAGE" /bench/tests/granite-synthetic.mjs "$@"
