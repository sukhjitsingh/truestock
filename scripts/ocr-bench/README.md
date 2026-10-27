# ocr-bench

Harness for measuring small OCR candidates (PP-OCRv6-small via ONNX, tesseract.js, Granite-Docling) on the same
page images, inside memory-capped, offline Docker containers. Spike tooling only: not wired into the app, not part of
the root `package.json`, no lockfile.

This directory holds code only. Models, node_modules, rendered page images and results live in a scratch directory
outside the repo (`BENCH` in `run/common.sh`) because images and results can contain private document content.

## Layout

```
package.json          exact pins; "overrides" force ONE onnxruntime-node/-web/-common (all 1.31.1)
lib/                  shared helpers, reuse them, do not copy them into an engine
  engine.mjs          runEngine({engine, init, recognize, close}): the shared main() of every engine
  cli.mjs             parseArgs, strFlag/numFlag/boolFlag, parseImageName, commonOptions
  png.mjs             decodePng / encodePng / toGray / toRgb (pngjs)
  resize.mjs          resizeBilinear(img, w, h, {float})
  rows.mjs            wordsToRows / wordsToMarkdown (words with boxes -> one visual row per line)
  measure.mjs         createTimer, maxRssMb, rssMb, cgroupPeakMb, cgroupLimitMb, cgroupSplitMb
  output.mjs          result and _run.json writers, stubs, validation
  mask.mjs            maskText / maskError (letters -> a, digits -> 9)
engines/
  echo.mjs            fake recogniser used to prove the runner; test flags --sleep-ms --alloc-mb --throw-doc --crash-after
  smoke-models.mjs    NOT an engine: offline load-check of the model sets (--what ppocr|tesseract|granite)
run/
  common.sh           paths, harness_mounts(), free_gib(), guard() (>= 4 GiB free)
  provision.sh        npm | models | granite | render | all  (the only steps that use the network, except render)
  run-capped.sh       one measured, capped, offline run
  finish.mjs          host-side: turns docker inspect facts into _docker.json plus stub results
  check-out.mjs       contract checker for an out/<variant> directory (structure only)
  lint.sh             eslint (repo config) + tsc visibility check, in the app image
  fetch-tessdata.mjs, fetch-granite.mjs, render-images.mjs   used by provision.sh
```

## Model files (all under `BENCH/models`, mounted read-only at `/work/models`)

| Path | Source |
|---|---|
| `ppocr/det.onnx`, `ppocr/rec.onnx`, `ppocr/dict.txt` | copied from the earlier library cache (pp-ocrv6-small, oar-ocr v0.7.0) |
| `tessdata/best_int/eng.traineddata` | `@tesseract.js-data/eng@1.0.0` (`4.0.0_best_int`, gunzipped) |
| `tessdata/fast/eng.traineddata` | official `tesseract-ocr/tessdata_fast`, tag 4.1.0 (the npm package has no `4.0.0_fast`) |
| `hf/onnx-community/granite-docling-258M-ONNX/...` | Hugging Face, via transformers.js (`provision.sh granite`) |

## Run

All docker invocations are inside script files; call them by absolute path.

```
run/provision.sh npm              # install node_modules into BENCH/nm (ONNXRUNTIME_NODE_INSTALL_CUDA=skip)
run/provision.sh models           # tessdata
run/provision.sh granite --combo q4   # also: q8, min; add --no-smoke to skip the decode check
run/provision.sh render [--max-mp N]  # PDFs -> BENCH/img/*.png + manifest.json (offline)

run/run-capped.sh <variant> <engine> <mem> <cpus> <threads> <imgs-csv|all> [engine flags...]
run/run-capped.sh echo-ok echo 1536m 2 2 scan-d100.png
node run/check-out.mjs <out-dir> <variant> --expect scan-d100,photo-d100   # host node; structure only
run/lint.sh
```

`lint.sh` runs in a container that is attached to the `truestock_default` compose network (copied from the
earlier spike-checks pattern) and mounts the worktree read-write at `/app`, with anonymous volumes over
`node_modules` and `.next`. It does not use the database. It is not a `--network none` run.

`run-capped.sh` starts `docker run -d --network none --memory=M --memory-swap=M --cpus=C --entrypoint node`, with
the harness read-only at `/bench`, `BENCH/nm` at `/bench/node_modules`, images and models read-only, `BENCH/out`
writable. It polls the container, kills it at `OCRB_TIMEOUT_SEC` (default 900; integer-second granularity, so +/- 1 s),
reads `OOMKilled` and `ExitCode` from `docker inspect`, saves the last 200 log lines to `out/<variant>/_log.txt`,
removes the container, and writes `_docker.json` plus stub results for any image that produced none. Other knobs:
`OCRB_DOCKER_ARGS`, `OCRB_NODE_ARGS`. Status values: ok, image-errors, timeout, oom-killed, init-failed, uncaught,
crash, docker-error, no-run-file.

### Environment overrides

| Variable | Used by | Meaning |
|---|---|---|
| `OCRB_BENCH` | all `run/*.sh` | scratch directory outside the repo (models, `nm/`, `img/`, `out/`, `gt/`, `report/`) |
| `OCRB_LIBOCR` | `run-score.sh` | directory of saved library-OCR markdown renders the ground truth is derived from |
| `OCRB_SCAN_DIR`, `OCRB_PHOTO_DIR` | `provision.sh render` | directories holding the source PDFs (private; mounted read-only, offline) |
| `OCRB_HOST_NODE` | `run-capped.sh` | host node used for `finish.mjs` (default: `node` on PATH) |
| `OCRB_TIMEOUT_SEC`, `OCRB_DOCKER_ARGS`, `OCRB_NODE_ARGS` | `run-capped.sh` | wall-clock kill, extra `docker run` args, extra node args |

`run-capped.sh` deletes `BENCH/out/<variant>` before each run. Copy results you want to keep first.

## Scoring

`run/run-score.sh derive-gt|score|synthetic|test` runs `score/` (bun, in the app image, offline, 1 GiB, read-only
worktree). The scorer reads `BENCH/out/*`, derives a scan ground truth from the library OCR (a per-field consensus of
three renders that must itself pass the real template's gate), runs each engine page through the REAL
`extractWithOcrTemplate`, and writes `BENCH/report/{summary.txt,detail.txt,scores.json}`: structure only (counts,
booleans, codes, masked error text). A leak guard throws if a report would contain a money-shaped token or a ground-truth
word. Variants whose names match the knob/cap/proof pattern (`-b`, `-bt`, `-pw`, `-rep`, `-rec`, `-s###`, `-w#`, `-m###`,
`tess-proof-*`) are listed apart as exploratory and excluded from the best-per-family choice, the photo table and the
merges; override with `--exploratory <regex>`. `run-score.sh test` runs the 74 unit tests on invented data only.

### Mount layout note

The harness is mounted entry by entry (`/bench/lib`, `/bench/engines`, ...) rather than as one `/bench` mount.
Docker cannot create the `/bench/node_modules` mountpoint inside a read-only bind mount, so the one-mount recipe in
the original spec fails with a read-only file system error.

## Engine contract

An engine file supplies `init` and `recognize` to `runEngine`; the library owns the CLI, loop, timing, memory
measurement, error masking and every output file.

```
node /bench/engines/<engine>.mjs --variant V --img /work/img/scan-d150.png,... --out /work/out --threads 2 [--timeout-ms N]
```

Per image `out/<V>/<doc>-d<dpi>.json`: `engine, variant, doc, dpi, imageWidth, imageHeight, words[{text, conf, box}],
markdown, timings{inferMs, stagesMs}, error`. Per process `out/<V>/_run.json`: `variant, engine, node, threads,
loadMs, maxRssMb, cgroupPeakMb, cgroupLimitMb, rssAfterLoadMb, flags, images[], exitReason, cgroupSplitAtExit`.

Images run sequentially in one process. A bad page is caught, masked, recorded as that page's `error`, and the loop
continues. Exit codes: 0 done, 124 timeout (`--timeout-ms` per image; remaining images get a "skipped" stub), 3 init
failed, 1 uncaught, 2 usage.

Image names follow `<doc>[p<page>]-d<dpi>.png`. The photo PDF is a JPEG wrapper whose page size equals the image
size at 72 dpi, so for the photo "dpi" is an upscale factor, not a physical resolution.

Limits worth knowing: a run killed from outside (OOM, wall-clock timeout) loses `_run.json`, so there is no
peak-memory figure for it; `_docker.json` and the stub results still exist. `rows.mjs` clusters words into rows with
a tolerance of 0.5 times the median word height.

## Offline recipes

Granite (transformers.js 4.3.1). The fetch step stores files at `<cacheDir>/<model id>/<repo path>`, which is also the
layout of a local model directory:

```js
tf.env.localModelPath = '/work/models/hf';
tf.env.allowLocalModels = true;   // not false: allowLocalModels=false plus allowRemoteModels=false throws
tf.env.allowRemoteModels = false;
const processor = await tf.AutoProcessor.from_pretrained('onnx-community/granite-docling-258M-ONNX');
const model = await tf.AutoModelForVision2Seq.from_pretrained('onnx-community/granite-docling-258M-ONNX',
  { dtype: { embed_tokens: 'q8', vision_encoder: 'q4', decoder_model_merged: 'q4' }, device: 'cpu' });
```

dtype suffixes in transformers.js 4.3.1: `q8` -> `_quantized`, `q4` -> `_q4`, `q4f16` -> `_q4f16`. Three combinations are
provisioned: `q4`, `q8`, and `min` (q4f16 for vision and decoder). Prefer `q4` or `q8`: `min` loads and runs but gave
degenerate output on the one synthetic probe it was tried on.

tesseract.js 7:
`createWorker('eng', 1, { langPath: '/work/models/tessdata/<fast|best_int>', gzip: false, cacheMethod: 'none' })`.

onnxruntime-node: `ort.InferenceSession.create('/work/models/ppocr/det.onnx', { intraOpNumThreads, interOpNumThreads: 1 })`.

## Images

`BENCH/img/manifest.json` lists each image (doc, page, dpi, file, width, height, bytes, sha256, megapixels).
`render-meta.json` records page counts and anything skipped. Renders above 25 megapixels are skipped by default
(the photo at 200 dpi is about 41 MP); `provision.sh render --max-mp 45` produces it.

## Lint

`run/lint.sh` runs the repo's eslint config over this directory with `--max-warnings 0`, plus two non-vacuity probes
(file count, and a deliberate rules-of-hooks violation that must be flagged), then checks that the root `tsc`
program does not include these files. Caveat: the repo eslint config applies only next, react and react-hooks rules to
`.mjs` files, so "lint clean" here is a weak statement (no `no-var`, `no-debugger` or `eqeqeq`).
