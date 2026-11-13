#!/usr/bin/env bash
# One measured engine run in a memory/CPU-capped, OFFLINE, throwaway container.
#
# Usage (absolute path, no cd; positional args):
#   run-capped.sh <variant> <engine> <mem> <cpus> <threads> <imgs-csv|all> [extra engine flags...]
#
#   variant   result dir name under BENCH/out/ and container name ocrb-<variant>   e.g. ppocr-node-t2
#   engine    file under HARNESS/engines/ without .mjs                             e.g. echo
#   mem       --memory AND --memory-swap (equal, so no swap)                       e.g. 1536m
#   cpus      --cpus                                                               e.g. 2
#   threads   passed to the engine as --threads                                    e.g. 2
#   imgs-csv  comma list of file names under BENCH/img (scan-d150.png,photo-d100.png), full /work/img/... paths
#             also accepted; "all" = every PNG in BENCH/img
#   extra     everything after the 6th arg goes to the engine verbatim (e.g. --psm 6 --sleep-ms 500)
#
# Environment knobs (all optional):
#   OCRB_TIMEOUT_SEC   wall-clock cap for the whole container run (default 900); on expiry the container is killed
#                      and the run is recorded as status=timeout
#   OCRB_DOCKER_ARGS   extra raw `docker run` args, word-split   e.g. "-e HF_HUB_OFFLINE=1"
#   OCRB_NODE_ARGS     extra node flags, word-split              e.g. "--max-old-space-size=900"
#
# What it does (the recipe from the bench spec):
#   * docker run -d --name ocrb-<variant> --network none --memory=M --memory-swap=M --cpus=C --entrypoint node
#     harness files read-only at /bench (+ BENCH/nm at /bench/node_modules, ro), BENCH/img and BENCH/models ro at
#     /work/img and /work/models, BENCH/out rw at /work/out. Never --privileged.
#   * polls until the container exits or OCRB_TIMEOUT_SEC elapses (then docker kill)
#   * reads docker inspect State.OOMKilled / ExitCode / StartedAt / FinishedAt, saves the last 200 log lines to
#     out/<variant>/_log.txt (may contain engine stderr; stays in BENCH), then docker rm -f
#   * run/finish.mjs (host node) writes out/<variant>/_docker.json {oomKilled, exitCode, wallSec, mem, cpus, ...}, a
#     stub result JSON (error "oom-killed" / "timeout (wall-clock cap)" / "crash: exit N") for every requested image
#     without a result file, and a stub _run.json if the engine never wrote one
#   * prints one summary line:  variant=.. status=.. exit=.. oomKilled=.. wallSec=.. maxRssMb=.. cgroupPeakMb=..
# Exit status of this script: 0 if the container ran (whatever the outcome; read status), 2 on usage error / low disk.
# Wall times come from an Intel-Mac Docker VM, not Hostinger: treat them as relative, tied to the cap used.
#
# Not `set -u`: macOS ships bash 3.2, where an empty array expands as unbound.
set -o pipefail

SELF="$(dirname "$0")"
# shellcheck source=common.sh
. "$SELF/common.sh"

if [ "$#" -lt 6 ]; then
  sed -n '2,/^set -o/p' "$0" | head -45 >&2
  exit 2
fi
VARIANT="$1"; ENGINE="$2"; MEM="$3"; CPUS="$4"; THREADS="$5"; IMGS="$6"
shift 6
EXTRA=("$@")
TIMEOUT_SEC="${OCRB_TIMEOUT_SEC:-900}"

case "$VARIANT" in *[!A-Za-z0-9._-]* | "") echo "bad variant: $VARIANT" >&2; exit 2 ;; esac
case "$ENGINE" in *[!A-Za-z0-9._-]* | "") echo "bad engine: $ENGINE" >&2; exit 2 ;; esac
case "$MEM" in *[!0-9mMgG]* | "") echo "bad mem: $MEM (e.g. 1536m)" >&2; exit 2 ;; esac
if [ ! -f "$HARNESS/engines/$ENGINE.mjs" ]; then echo "no such engine: $HARNESS/engines/$ENGINE.mjs" >&2; exit 2; fi
guard

NODE_BIN="${OCRB_HOST_NODE:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then echo "no host node on PATH (set OCRB_HOST_NODE): finish.mjs needs it" >&2; exit 2; fi

# Resolve images -> container paths (for the engine) and base names (for finish.mjs).
IMG_PATHS=""
IMG_NAMES=""
if [ "$IMGS" = "all" ]; then
  IMGS=""
  for f in "$BENCH"/img/*.png; do IMGS="${IMGS:+$IMGS,}$(basename "$f")"; done
fi
OLDIFS="$IFS"; IFS=','
for i in $IMGS; do
  IFS="$OLDIFS"
  b="$(basename "$i")"
  if [ ! -f "$BENCH/img/$b" ]; then echo "no such image in BENCH/img: $b" >&2; exit 2; fi
  IMG_PATHS="${IMG_PATHS:+$IMG_PATHS,}/work/img/$b"
  IMG_NAMES="${IMG_NAMES:+$IMG_NAMES,}${b%.png}"
  IFS=','
done
IFS="$OLDIFS"
if [ -z "$IMG_PATHS" ]; then echo "no images given" >&2; exit 2; fi

MOUNTS=()
while IFS= read -r line; do MOUNTS+=("$line"); done < <(harness_mounts)
DOCKER_EXTRA=()
if [ -n "${OCRB_DOCKER_ARGS:-}" ]; then read -r -a DOCKER_EXTRA <<< "$OCRB_DOCKER_ARGS"; fi
NODE_ARGS=()
if [ -n "${OCRB_NODE_ARGS:-}" ]; then read -r -a NODE_ARGS <<< "$OCRB_NODE_ARGS"; fi

NAME="ocrb-$VARIANT"
OUT="$BENCH/out/$VARIANT"
docker rm -f "$NAME" >/dev/null 2>&1   # stale container of the same name (ours only)
rm -rf "$OUT"                          # no stale results may mask a failure
mkdir -p "$OUT"

DOCKER_ERR=""
docker run -d --name "$NAME" --network none \
  --memory="$MEM" --memory-swap="$MEM" --cpus="$CPUS" \
  "${MOUNTS[@]}" \
  -v "$BENCH/img":/work/img:ro -v "$BENCH/models":/work/models:ro -v "$BENCH/out":/work/out \
  -w /bench "${DOCKER_EXTRA[@]}" --entrypoint node "$IMAGE" \
  "${NODE_ARGS[@]}" "/bench/engines/$ENGINE.mjs" \
  --variant "$VARIANT" --img "$IMG_PATHS" --out /work/out --threads "$THREADS" "${EXTRA[@]}" \
  >"$OUT/.docker-run.out" 2>"$OUT/.docker-run.err"
RC=$?
START=$SECONDS
TIMED_OUT=0
if [ "$RC" -ne 0 ]; then
  DOCKER_ERR="docker run failed (rc=$RC)"
else
  while true; do
    RUNNING="$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)"
    if [ "$RUNNING" != "true" ]; then break; fi
    if [ $((SECONDS - START)) -ge "$TIMEOUT_SEC" ]; then
      TIMED_OUT=1
      docker kill "$NAME" >/dev/null 2>&1
      break
    fi
    sleep 0.5
  done
  docker wait "$NAME" >/dev/null 2>&1
fi
POLLED=$((SECONDS - START))

OOM="false"; EXITC=""; STARTED=""; FINISHED=""
if [ -z "$DOCKER_ERR" ]; then
  FACTS="$(docker inspect -f '{{.State.OOMKilled}}|{{.State.ExitCode}}|{{.State.StartedAt}}|{{.State.FinishedAt}}' "$NAME" 2>/dev/null)"
  OOM="${FACTS%%|*}"; REST="${FACTS#*|}"
  EXITC="${REST%%|*}"; REST="${REST#*|}"
  STARTED="${REST%%|*}"; FINISHED="${REST#*|}"
  docker logs --tail 200 "$NAME" >"$OUT/_log.txt" 2>&1
fi
docker rm -f "$NAME" >/dev/null 2>&1

FIN=("$NODE_BIN" "$HARNESS/run/finish.mjs" --out-dir "$BENCH/out" --variant "$VARIANT" --engine "$ENGINE"
  --imgs "$IMG_NAMES" --oom "$OOM" --timed-out "$TIMED_OUT" --polled-sec "$POLLED"
  --mem "$MEM" --cpus "$CPUS" --threads "$THREADS" --timeout-sec "$TIMEOUT_SEC")
if [ -n "$EXITC" ]; then FIN+=(--exit-code "$EXITC"); fi
if [ -n "$STARTED" ]; then FIN+=(--started "$STARTED" --finished "$FINISHED"); fi
if [ -n "$DOCKER_ERR" ]; then FIN+=(--docker-error "$DOCKER_ERR"); fi
"${FIN[@]}"
