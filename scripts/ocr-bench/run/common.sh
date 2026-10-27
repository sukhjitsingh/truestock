#!/usr/bin/env bash
# Shared constants/helpers for run/*.sh (sourced, not executed).

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Scratch directory OUTSIDE the repo: models, node_modules, page images, results, ground truth (private content).
# Override with OCRB_BENCH; the default is the directory the recorded runs used.
BENCH="${OCRB_BENCH:-/Users/moni/.claude/jobs/c23a2caa/tmp/bench}"
IMAGE=truestock-app:latest

# Prints one "-v <host>:/bench/<name>:ro" per top-level HARNESS entry except node_modules.
# Why not mount HARNESS itself at /bench: BENCH/nm must appear at /bench/node_modules, and Docker cannot create that
# mountpoint inside a read-only bind mount ("mkdir ...: read-only file system"). Mounting each entry separately
# leaves /bench itself writable-layer (empty, throwaway) while every harness file is still read-only.
harness_mounts() {
  local e n
  for e in "$HARNESS"/*; do
    n="$(basename "$e")"
    if [ "$n" = "node_modules" ]; then continue; fi
    printf '%s\n' "-v"
    printf '%s\n' "$e:/bench/$n:ro"
  done
  printf '%s\n' "-v"
  printf '%s\n' "$BENCH/nm:/bench/node_modules:ro"
}

free_gib() { df -k /Users | awk 'NR==2 {printf "%d", $4/1024/1024}'; }

# Refuse to continue when the volume holding BENCH has < 4 GiB free (spec).
guard() {
  local f
  f="$(free_gib)"
  echo "free on /Users: ${f} GiB"
  if [ "$f" -lt 4 ]; then echo "STOP: < 4 GiB free" >&2; exit 2; fi
}
