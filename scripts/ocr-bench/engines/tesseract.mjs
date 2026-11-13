// tesseract.js 7.0.0 engine (pure WASM, worker_threads), fully offline.
//
//   node tesseract.mjs --variant tess-best-psm6 --img /work/img/scan-d150.png --out /work/out --threads 2
//
// Variant names decide the defaults (flags override them):
//   tess-<fast|best>-psm<N>[-wl]   fast -> tessdata_fast, best -> best_int; N = page segmentation mode;
//                                  -wl = second pass that re-reads numeric-looking / low-confidence words (see below).
// Other variant names (e.g. tess-best-psm6-w2, tess-best-psm6-rep2) fall back to best_int + PSM 6 unless flagged.
//
// Engine flags:
//   --tess-data fast|best_int   traineddata set under /work/models/tessdata/<set>
//   --psm N                     tessedit_pageseg_mode (default 6)
//   --wl                        second pass (default: on only for variants ending in -wl)
//   --workers N                 resident recognition workers (default 1). Pages go round-robin over the pool, one page
//                               at a time, so N=2 measures the memory/thread cost of a pool, NOT a speed-up.
//   --recycle K                 terminate + recreate a worker once it has recognised K pages (tesseract's WASM heap
//                               never shrinks; this is the mitigation under test). The recreate time is reported as the
//                               `load` stage of the page that triggered it.
//   --repeat R                  process the image list R times in one process. Pass 2+ re-use the same images through
//                               symlinks named <doc>p<pass>-d<dpi>.png, so their result files are <doc>p2-d<dpi>.json
//                               and pass 1 keeps its normal names.
//   --lang-path DIR|none        override the traineddata directory ("none" = omit langPath, which makes tesseract.js
//                               fall back to its CDN: used only to prove nothing can silently use the network)
//   --wl-chars CHARS            whitelist for the second pass (default 0123456789.,-$)
//   --wl-psm N                  PSM for the second pass (default 7, single line)
//   --wl-lowconf X              confidence below which a word is re-read as well (default 0.6)
// --threads is accepted (common contract) but tesseract.js has no thread knob: every worker is one thread.
//
// Second pass (-wl): for each first-pass word whose text matches /^[\d.,$()\-]+$/ or whose confidence < 0.6, crop its
// box with padding max(3, 0.2 * box height) px, upscale x2 (bilinear, gray), run a second worker configured with
// tessedit_char_whitelist and PSM 7, and accept the re-read when its mean confidence is higher. Words containing
// "(" or ")" are NOT re-read (the default whitelist cannot produce them, so an accepted re-read would silently drop
// the parentheses of a negative amount); they are counted as skippedParen.
//
// Extra facts that the shared contract has no field for:
//   * `_run.json` -> `flags._tess` (runEngine serialises the live `flags` object, which this file fills in):
//     version, core, threadsObserved (peak count of /proc/self/task), baselineThreads, passes[], secondPass totals.
//   * `<out>/<variant>/_tess-<image>.json`: tesseract's own `rawText` (PRIVATE content, stays in BENCH), mean
//     confidence, psm/oem/version, per-image second-pass counts. The leading "_" keeps it out of the per-image result
//     listing that check-out.mjs and the scorer read.
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runEngine } from '../lib/engine.mjs';
import { boolFlag, numFlag, parseArgs, parseImageName, strFlag } from '../lib/cli.mjs';
import { createTimer, maxRssMb, rssMb } from '../lib/measure.mjs';
import { encodePng } from '../lib/png.mjs';
import { resizeBilinear } from '../lib/resize.mjs';

const tesseract = await import('tesseract.js');
const createWorker = tesseract.createWorker ?? tesseract.default.createWorker;

const TESSDATA_DIRS = { fast: 'fast', best: 'best_int', best_int: 'best_int' };
const NUMERIC_RE = /^[\d.,$()\-]+$/;
const REPEAT_DIR = '/tmp/ocrb-rep';
const CACHE_DIR = '/tmp/tess-cache';

// ---------------------------------------------------------------------------------------------------------------
// --repeat: expand the image list before runEngine sees it
// ---------------------------------------------------------------------------------------------------------------
function expandRepeat(argv) {
  const { flags } = parseArgs(argv);
  const repeat = Math.max(1, Math.floor(numFlag(flags, 'repeat', 1)));
  const img = strFlag(flags, 'img');
  if (repeat === 1 || !img) return { argv, perPass: null };
  const paths = img.split(',').map((s) => s.trim()).filter(Boolean);
  mkdirSync(REPEAT_DIR, { recursive: true });
  const all = [...paths];
  for (let pass = 2; pass <= repeat; pass++) {
    for (const p of paths) {
      const info = parseImageName(p);
      if (!info) {
        all.push(p);
        continue;
      }
      const link = join(REPEAT_DIR, `${info.doc}p${pass}-d${info.dpi}.png`);
      try {
        symlinkSync(p, link);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      all.push(link);
    }
  }
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--img') i++;
    else if (!argv[i].startsWith('--img=')) out.push(argv[i]);
  }
  out.push('--img', all.join(','));
  return { argv: out, perPass: paths.length };
}

let expanded;
try {
  expanded = expandRepeat(process.argv.slice(2));
} catch (e) {
  console.error(`usage error: cannot prepare --repeat: ${e.message}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------
const round1 = (n) => Math.round(n * 10) / 10;

function threadCount() {
  try {
    return readdirSync('/proc/self/task').length;
  } catch {
    return null;
  }
}

function resolveConfig(variant, flags) {
  const m = /^tess-(fast|best)-psm(\d+)(-wl)?/.exec(variant);
  const setName = strFlag(flags, 'tess-data', m ? m[1] : 'best');
  const tessData = TESSDATA_DIRS[setName];
  if (!tessData) throw new Error(`--tess-data must be fast or best_int (got ${setName})`);
  const langOverride = strFlag(flags, 'lang-path');
  return {
    tessData,
    psm: numFlag(flags, 'psm', m ? Number(m[2]) : 6),
    wl: boolFlag(flags, 'wl', Boolean(m?.[3])),
    workers: Math.max(1, Math.floor(numFlag(flags, 'workers', 1))),
    recycle: Math.max(0, Math.floor(numFlag(flags, 'recycle', 0))),
    repeat: Math.max(1, Math.floor(numFlag(flags, 'repeat', 1))),
    langPath: langOverride === 'none' ? undefined : (langOverride ?? `/work/models/tessdata/${tessData}`),
    wlChars: strFlag(flags, 'wl-chars', '0123456789.,-$'),
    wlPsm: numFlag(flags, 'wl-psm', 7),
    wlLowConf: numFlag(flags, 'wl-lowconf', 0.6),
  };
}

async function detectCore() {
  try {
    const { simd, relaxedSimd } = await import('wasm-feature-detect');
    const [s, r] = [await simd(), await relaxedSimd()];
    return r ? 'relaxedsimd-lstm' : s ? 'simd-lstm' : 'lstm';
  } catch {
    return 'unknown';
  }
}

/**
 * Create one tesseract.js worker, offline. An `errorHandler` is mandatory: without it tesseract.js THROWS inside its
 * message callback on any worker error (uncaught in the main thread), and for a bad langPath createWorker() would
 * never settle at all. Racing the handler against creation turns that into an ordinary rejection.
 */
async function spawnWorker(cfg, params) {
  let fail;
  const failed = new Promise((_, reject) => {
    fail = reject;
  });
  failed.catch(() => {});
  const errorHandler = (data) => fail(new Error(String(data)));
  const options = { gzip: false, cacheMethod: 'none', cachePath: CACHE_DIR, errorHandler };
  if (cfg.langPath !== undefined) options.langPath = cfg.langPath;
  const tw = await Promise.race([createWorker('eng', 1, options), failed]);
  await tw.setParameters(params);
  return { tw, pages: 0 };
}

/** tesseract.js's terminate() does not wait for the thread; awaiting the raw worker_threads Worker does. */
async function stopWorker(slot) {
  const raw = slot.tw.worker;
  await slot.tw.terminate();
  await raw.terminate();
}

function extractWords(blocks) {
  const words = [];
  for (const b of blocks ?? []) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines ?? []) {
        for (const w of l.words ?? []) {
          const bb = w.bbox;
          if (!bb || typeof w.text !== 'string' || w.text.trim() === '') continue;
          words.push({ text: w.text.trim(), conf: (w.confidence ?? 0) / 100, box: [bb.x0, bb.y0, bb.x1, bb.y1] });
        }
      }
    }
  }
  return words;
}

/** Crop `box` (+pad) out of an RGBA image, convert to gray, upscale x2 bilinear, encode as a gray PNG. */
function cropGray2xPng(image, box, pad) {
  const { width: W, height: H, data } = image;
  const x0 = Math.max(0, Math.floor(box[0] - pad));
  const y0 = Math.max(0, Math.floor(box[1] - pad));
  const x1 = Math.min(W, Math.ceil(box[2] + pad));
  const y1 = Math.min(H, Math.ceil(box[3] + pad));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 2 || h < 2) return null;
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = ((y0 + y) * W + x0) * 4;
    for (let x = 0; x < w; x++, s += 4) gray[y * w + x] = (299 * data[s] + 587 * data[s + 1] + 114 * data[s + 2] + 500) / 1000;
  }
  const up = resizeBilinear({ width: w, height: h, channels: 1, data: gray }, w * 2, h * 2);
  return encodePng(up, { level: 1 });
}

// ---------------------------------------------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------------------------------------------
const baselineThreads = threadCount();
let sampler = null;
let state = null;

function startSampler(info) {
  const sample = () => {
    const n = threadCount();
    if (n !== null && n > (info.threadsObserved ?? 0)) info.threadsObserved = n;
  };
  sample();
  sampler = setInterval(sample, 20);
  sampler.unref();
  return sample;
}

await runEngine({
  engine: 'tesseract',
  argv: expanded.argv,
  init: async ({ opts, flags }) => {
    const cfg = resolveConfig(opts.variant, flags);
    const info = {
      note: 'filled in by engines/tesseract.mjs; runEngine serialises this object as _run.json flags._tess',
      tesseractJs: '7.0.0',
      core: await detectCore(),
      tessData: cfg.tessData,
      psm: cfg.psm,
      wl: cfg.wl,
      workers: cfg.workers,
      recycle: cfg.recycle,
      repeat: cfg.repeat,
      threadsFlag: opts.threads,
      threadsFlagIgnored: true,
      baselineThreads,
      threadsAfterLoad: null,
      threadsObserved: baselineThreads,
      workerThreadsAdded: null,
      recycles: 0,
      passes: [],
      secondPass: { candidates: 0, reread: 0, accepted: 0, changedText: 0, skippedParen: 0, emptyReread: 0, ms: 0 },
    };
    flags._tess = info;
    const sample = startSampler(info);

    const pool = [];
    for (let i = 0; i < cfg.workers; i++) pool.push(await spawnWorker(cfg, { tessedit_pageseg_mode: String(cfg.psm) }));
    let wlWorker = null;
    if (cfg.wl) {
      wlWorker = await spawnWorker(cfg, {
        tessedit_pageseg_mode: String(cfg.wlPsm),
        tessedit_char_whitelist: cfg.wlChars,
      });
    }
    await new Promise((r) => setTimeout(r, 60)); // let the sampler see the settled thread count
    sample();
    info.threadsAfterLoad = threadCount();
    info.workerThreadsAdded = info.threadsAfterLoad === null || baselineThreads === null ? null : info.threadsAfterLoad - baselineThreads;

    state = {
      cfg,
      info,
      sample,
      pool,
      wlWorker,
      imageIndex: 0,
      perPass: expanded.perPass ?? opts.imgs.length,
      passAcc: { pass: 1, images: 0, recognizeMs: 0, secondPassMs: 0, loadMs: 0 },
      outDir: join(opts.outDir, opts.variant),
    };
    return state;
  },

  recognize: async (st, ctx) => {
    const { cfg, info, pool } = st;
    const t = createTimer();
    const slot = pool[st.imageIndex % pool.length];
    st.imageIndex++;

    if (cfg.recycle > 0 && slot.pages >= cfg.recycle) {
      await t.time('load', async () => {
        await stopWorker(slot);
        const fresh = await spawnWorker(cfg, { tessedit_pageseg_mode: String(cfg.psm) });
        slot.tw = fresh.tw;
        slot.pages = 0;
      });
      info.recycles++;
    }

    const bytes = readFileSync(ctx.path);
    const res = await t.time('recognize', () => slot.tw.recognize(bytes, {}, { text: true, blocks: true }));
    slot.pages++;
    const words = extractWords(res.data.blocks);
    const firstPassWords = words.length;

    const sp = { candidates: 0, reread: 0, accepted: 0, changedText: 0, skippedParen: 0, emptyReread: 0 };
    if (st.wlWorker) {
      await t.time('secondPass', async () => {
        for (const w of words) {
          const numeric = NUMERIC_RE.test(w.text);
          if (!numeric && !(w.conf < cfg.wlLowConf)) continue;
          sp.candidates++;
          if (/[()]/.test(w.text)) {
            sp.skippedParen++;
            continue;
          }
          const h = w.box[3] - w.box[1];
          const png = cropGray2xPng(ctx.image, w.box, Math.max(3, Math.round(0.2 * h)));
          if (!png) continue;
          sp.reread++;
          const r = await st.wlWorker.tw.recognize(png, {}, { text: false, blocks: true });
          const rw = extractWords(r.data.blocks);
          if (rw.length === 0) {
            sp.emptyReread++;
            continue;
          }
          const text = rw.map((x) => x.text).join('');
          const conf = rw.reduce((a, x) => a + x.conf, 0) / rw.length;
          if (conf > (w.conf ?? 0)) {
            sp.accepted++;
            if (text !== w.text) sp.changedText++;
            w.text = text;
            w.conf = conf;
          }
        }
      });
    }

    st.sample();
    const stages = t.stagesMs;
    const sec = info.secondPass;
    for (const k of Object.keys(sp)) sec[k] += sp[k];
    sec.ms = round1(sec.ms + (stages.secondPass ?? 0));

    // Side file: tesseract's own text (private) and facts the contract has no field for.
    mkdirSync(st.outDir, { recursive: true });
    writeFileSync(
      join(st.outDir, `_tess-${ctx.name}.json`),
      `${JSON.stringify({
        image: ctx.name,
        rawText: res.data.text,
        meanConfidence: res.data.confidence,
        psm: res.data.psm,
        oem: res.data.oem,
        version: res.data.version,
        firstPassWords,
        secondPass: st.wlWorker ? sp : null,
        workerPagesSoFar: slot.pages,
      })}\n`,
    );

    // Per-pass accounting (a pass = one walk over the original image list).
    const acc = st.passAcc;
    acc.images++;
    acc.recognizeMs += stages.recognize ?? 0;
    acc.secondPassMs += stages.secondPass ?? 0;
    acc.loadMs += stages.load ?? 0;
    if (acc.images >= st.perPass) {
      info.passes.push({
        pass: acc.pass,
        images: acc.images,
        recognizeMs: round1(acc.recognizeMs),
        secondPassMs: round1(acc.secondPassMs),
        loadMs: round1(acc.loadMs),
        rssMbAfter: rssMb(),
        maxRssMbAfter: maxRssMb(),
        threadsNow: threadCount(),
      });
      st.passAcc = { pass: acc.pass + 1, images: 0, recognizeMs: 0, secondPassMs: 0, loadMs: 0 };
    }

    return {
      words: words.map((w) => ({ text: w.text, conf: w.conf, box: w.box })),
      stagesMs: { load: stages.load ?? 0, recognize: stages.recognize ?? 0, secondPass: stages.secondPass ?? 0 },
    };
  },

  close: async (st) => {
    st.sample();
    if (sampler) clearInterval(sampler);
    for (const slot of st.pool) await stopWorker(slot);
    if (st.wlWorker) await stopWorker(st.wlWorker);
  },
});
