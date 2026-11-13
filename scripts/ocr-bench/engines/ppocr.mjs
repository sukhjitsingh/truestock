// PP-OCRv6-small detect + recognise, called directly from Node (no Paddle, no Python, no OpenCV).
//
//   --variant ppocr-node   onnxruntime-node (native addon)        --variant ppocr-web   onnxruntime-web (WASM, run in Node)
// The runtime is chosen by the variant name (a "web" token selects WASM, anything else is native) or forced with
// --runtime node|web. ALL pre- and post-processing is shared (lib/ppocr-pipeline.mjs); only the InferenceSession factory
// differs.
//
//   run-capped.sh ppocr-node ppocr 1536m 2 2 all
//   run-capped.sh ppocr-web  ppocr 1536m 2 2 all
//
// Engine flags (defaults in lib/ppocr-pipeline.mjs DEFAULTS):
//   --det-max-side 960   longer side of the detector input (never upscaled, sides rounded to 32). Sweepable.
//   --thresh 0.3  --box-thresh 0.5 (PaddleOCR: 0.6)  --unclip 1.5  --score-mode box|region  --pad 2 (original pixels)
//   --rec-batch 8  --rec-max-width 3200  --rec-out-mb 64  --rec-pad-value 0  --min-rec-conf 0  --max-boxes 3000
//   --bgr / --no-bgr   channel order fed to the models (default BGR like PaddleOCR)
//   --prefilter / --no-prefilter   integer average-downscale before bilinear when shrinking by 2x or more (default on)
//   --arena / --no-arena   ORT CPU memory arena (native runtime only; default on). Memory pattern is always off
//                          (input shapes are dynamic).
//   --repeat N           run every page N times back to back (page-level pass stats go into stagesMs extras)
//   --models /work/models/ppocr   directory with det.onnx, rec.onnx, dict.txt
//
// Extras written to _run.json by an exit hook (the runner has no extension point): threadsObserved (max entry count of
// /proc/self/task seen), runtime, ort version, effective parameters, totals per stage, recognition batches.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boolFlag, numFlag, strFlag } from '../lib/cli.mjs';
import { runEngine } from '../lib/engine.mjs';
import { maxRssMb, rssMb } from '../lib/measure.mjs';
import { DEFAULTS, createPpocrSessions, loadDict, recognizePage } from '../lib/ppocr-pipeline.mjs';

const ENGINE = 'ppocr';

function countThreads() {
  try {
    return readdirSync('/proc/self/task').length;
  } catch {
    return null;
  }
}

const observed = { threadsMax: null, threadsAfterLoad: null };
function sampleThreads() {
  const n = countThreads();
  if (n !== null && (observed.threadsMax === null || n > observed.threadsMax)) observed.threadsMax = n;
}

function pickRuntime(variant, flags) {
  const forced = strFlag(flags, 'runtime');
  if (forced) {
    if (forced !== 'node' && forced !== 'web') throw new Error('--runtime must be node or web');
    return forced;
  }
  return /(^|[-_.])web([-_.]|$)/.test(variant) ? 'web' : 'node';
}

function readParams(flags) {
  const num = (flag, key) => numFlag(flags, flag, DEFAULTS[key]);
  const scoreMode = strFlag(flags, 'score-mode', DEFAULTS.scoreMode);
  if (scoreMode !== 'box' && scoreMode !== 'region') throw new Error('--score-mode must be box or region');
  return {
    detMaxSide: num('det-max-side', 'detMaxSide'),
    thresh: num('thresh', 'thresh'),
    boxThresh: num('box-thresh', 'boxThresh'),
    unclip: num('unclip', 'unclip'),
    pad: num('pad', 'pad'),
    scoreMode,
    recBatch: num('rec-batch', 'recBatch'),
    recMaxWidth: num('rec-max-width', 'recMaxWidth'),
    recOutMb: num('rec-out-mb', 'recOutMb'),
    recPadValue: num('rec-pad-value', 'recPadValue'),
    minRecConf: num('min-rec-conf', 'minRecConf'),
    maxBoxes: num('max-boxes', 'maxBoxes'),
    bgr: boolFlag(flags, 'bgr', DEFAULTS.bgr),
    prefilter: boolFlag(flags, 'prefilter', DEFAULTS.prefilter),
  };
}

const totals = { stagesMs: {}, pages: 0, boxes: 0, recBatches: 0, maxRecWidth: 0 };
let runMeta = null;

process.on('exit', () => {
  if (!runMeta) return;
  try {
    const file = join(runMeta.outDir, runMeta.variant, '_run.json');
    const run = JSON.parse(readFileSync(file, 'utf8'));
    Object.assign(run, {
      runtime: runMeta.runtime,
      ortVersion: runMeta.ortVersion,
      threadsObserved: observed.threadsMax,
      threadsAfterLoad: observed.threadsAfterLoad,
      ppocr: { params: runMeta.params, repeat: runMeta.repeat, arena: runMeta.arena, totals },
    });
    writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  } catch (e) {
    console.error(`could not extend _run.json: ${e?.message ?? e}`);
  }
});

await runEngine({
  engine: ENGINE,
  init: async ({ opts, flags }) => {
    const modelDir = strFlag(flags, 'models', '/work/models/ppocr');
    const runtime = pickRuntime(opts.variant, flags);
    const arena = boolFlag(flags, 'arena', true);
    const params = readParams(flags);
    const repeat = Math.max(1, Math.floor(numFlag(flags, 'repeat', 1)));
    const dict = loadDict(readFileSync(join(modelDir, 'dict.txt'), 'utf8'));
    const s = await createPpocrSessions({ runtime, threads: opts.threads, modelDir, arena });
    runMeta = { outDir: opts.outDir, variant: opts.variant, runtime, ortVersion: s.version, params, repeat, arena };
    sampleThreads();
    observed.threadsAfterLoad = countThreads();
    const sampler = setInterval(sampleThreads, 25);
    sampler.unref();
    return { ...s, dict, params, repeat, sampler };
  },
  recognize: async (state, { image }) => {
    const pipe = { ort: state.ort, det: state.det, rec: state.rec, dict: state.dict, params: state.params, onRun: sampleThreads };
    let last = null;
    const passStats = {};
    for (let pass = 1; pass <= state.repeat; pass++) {
      const t0 = performance.now();
      last = await recognizePage(pipe, image);
      sampleThreads();
      if (state.repeat > 1) {
        // Extras in stagesMs: pass wall time (ms) and process memory (MB) right after the pass. inferMs of the page is
        // the sum of all passes; the stage timings and words are those of the LAST pass (warm).
        passStats[`pass${pass}Ms`] = Math.round((performance.now() - t0) * 10) / 10;
        passStats[`pass${pass}RssMb`] = rssMb();
        passStats[`pass${pass}MaxRssMb`] = maxRssMb();
      }
    }
    totals.pages++;
    totals.boxes += last.info.boxes;
    totals.recBatches += last.info.recBatches;
    totals.maxRecWidth = Math.max(totals.maxRecWidth, last.info.maxRecWidth);
    for (const [k, v] of Object.entries(last.stagesMs)) totals.stagesMs[k] = Math.round(((totals.stagesMs[k] ?? 0) + v) * 10) / 10;
    return { words: last.words, stagesMs: { ...last.stagesMs, ...passStats } };
  },
  close: async (state) => {
    clearInterval(state.sampler);
    await state.det?.release?.();
    await state.rec?.release?.();
  },
});
