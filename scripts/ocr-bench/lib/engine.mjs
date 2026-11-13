// runEngine(): the shared main() of every engine. An engine file only supplies init() and recognize();
// this module owns the CLI, image loop, timing, memory measurement, error masking and ALL output files, so the
// contract is implemented exactly once.
//
//   runEngine({
//     engine: 'echo',                                   // written into every result as `engine`
//     init: async ({ opts, flags }) => state,           // load models; its wall time is _run.json `loadMs`
//     recognize: async (state, ctx) => ({ words, markdown?, stagesMs? }),
//                                                        // ctx = { image: {width,height,channels:4,data}, doc, page,
//                                                        //         dpi, name, path, opts, flags }
//     close: async (state) => {},                       // optional; terminate workers/sessions
//   })
//
// Guarantees: images are processed sequentially in one process; an exception in one page is caught, masked and
// recorded as that page's `error` and the loop continues; if --timeout-ms (per image) fires, that image gets
// error "timeout after N ms", the remaining images get a "skipped" stub, _run.json says exitReason "timeout" and the
// process exits 124 (a hung native call cannot be interrupted, so the process is ended instead of continuing).
// Exit codes: 0 done (even if some pages errored), 124 timeout, 3 init failed, 1 uncaught error, 2 usage error.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { commonOptions, parseArgs, parseImageName } from './cli.mjs';
import { maskError } from './mask.mjs';
import { cgroupLimitMb, cgroupPeakMb, cgroupSplitMb, elapsedMs, maxRssMb, rssMb } from './measure.mjs';
import { makeImageResult, stubImageResult, validateImageResult, writeImageResult, writeRunFile } from './output.mjs';
import { decodePng } from './png.mjs';
import { wordsToMarkdown } from './rows.mjs';

class TimeoutError extends Error {
  constructor(ms) {
    super(`timeout after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

function withTimeout(promise, ms) {
  if (!ms) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runEngine({ engine, init, recognize, close, argv = process.argv.slice(2) }) {
  let opts;
  let flags;
  try {
    ({ flags } = parseArgs(argv));
    opts = commonOptions(flags);
  } catch (e) {
    console.error(`usage error: ${e.message}`);
    console.error(`usage: node ${engine}.mjs --variant V --img a.png,b.png --out /work/out --threads N [--timeout-ms N]`);
    process.exit(2);
  }

  const items = opts.imgs.map((path) => {
    const info = parseImageName(path);
    return { path, info, name: info?.name ?? basename(path).replace(/\.[^.]*$/, '') };
  });
  const baseOf = (item) => ({ engine, variant: opts.variant, doc: item.info?.doc ?? 'unknown', dpi: item.info?.dpi ?? 0 });

  const run = {
    variant: opts.variant,
    engine,
    node: process.version,
    threads: opts.threads,
    loadMs: 0,
    maxRssMb: 0,
    cgroupPeakMb: null,
    cgroupLimitMb: cgroupLimitMb(),
    rssAfterLoadMb: null,
    flags,
    images: [],
    exitReason: 'running',
  };
  const done = new Set();
  let finished = false;

  const finish = (exitReason, code, stubError) => {
    if (finished) return;
    finished = true;
    for (const item of items) {
      if (done.has(item.name)) continue;
      writeImageResult(opts.outDir, opts.variant, item.name, stubImageResult({ ...baseOf(item), error: stubError ?? exitReason }));
      run.images.push({ name: item.name, ok: false, error: stubError ?? exitReason });
    }
    run.exitReason = exitReason;
    run.maxRssMb = maxRssMb();
    run.cgroupPeakMb = cgroupPeakMb();
    run.cgroupSplitAtExit = cgroupSplitMb();
    writeRunFile(opts.outDir, opts.variant, run);
    process.exit(code);
  };

  for (const evt of ['uncaughtException', 'unhandledRejection']) {
    process.on(evt, (e) => {
      console.error(e?.stack ?? e);
      finish('uncaught', 1, `uncaught: ${maskError(e)}`);
    });
  }

  const tLoad = performance.now();
  let state;
  try {
    state = await init({ opts, flags });
  } catch (e) {
    console.error(e?.stack ?? e);
    finish('init-failed', 3, `init-failed: ${maskError(e)}`);
  }
  run.loadMs = elapsedMs(tLoad);
  run.rssAfterLoadMb = rssMb();

  let errors = 0;
  let timedOut = false;
  for (const item of items) {
    let result;
    let inferMs = 0;
    try {
      if (!item.info) throw new Error('image file name does not match <doc>-d<dpi>.png');
      const tDecode = performance.now();
      const image = decodePng(readFileSync(item.path));
      const decodeMs = elapsedMs(tDecode);
      const t0 = performance.now();
      try {
        const res = await withTimeout(
          Promise.resolve().then(() => recognize(state, { image, ...item.info, path: item.path, opts, flags })),
          opts.timeoutMs,
        );
        inferMs = performance.now() - t0;
        const words = res.words ?? [];
        result = makeImageResult({
          ...baseOf(item),
          imageWidth: image.width,
          imageHeight: image.height,
          words,
          markdown: typeof res.markdown === 'string' ? res.markdown : wordsToMarkdown(words),
          inferMs,
          stagesMs: { decode: decodeMs, ...res.stagesMs },
        });
        validateImageResult(result);
      } catch (e) {
        inferMs = performance.now() - t0;
        throw e;
      }
    } catch (e) {
      console.error(e?.stack ?? e);
      if (e instanceof TimeoutError) timedOut = true;
      result = stubImageResult({ ...baseOf(item), error: e instanceof TimeoutError ? e.message : maskError(e) });
      result.timings.inferMs = Math.round(inferMs * 10) / 10;
      errors++;
    }
    writeImageResult(opts.outDir, opts.variant, item.name, result);
    done.add(item.name);
    run.images.push({
      name: item.name,
      ok: result.error === null,
      error: result.error,
      inferMs: result.timings.inferMs,
      words: result.words.length,
      imageWidth: result.imageWidth,
      imageHeight: result.imageHeight,
      rssMbAfter: rssMb(),
      maxRssMbSoFar: maxRssMb(),
      cgroupPeakMbSoFar: cgroupPeakMb(),
    });
    if (timedOut) finish('timeout', 124, 'skipped: an earlier image timed out');
  }

  try {
    await close?.(state);
  } catch (e) {
    console.error(`close failed: ${maskError(e)}`);
  }
  finish(errors > 0 ? 'image-errors' : 'ok', 0);
}
