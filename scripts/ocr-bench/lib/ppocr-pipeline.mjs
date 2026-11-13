// PP-OCR (PaddleOCR) detection + recognition pipeline in pure JS: DB text detection and CTC text recognition around two
// ONNX sessions. No OpenCV, no native code of its own. Runtime-agnostic: the caller passes the `ort` module (the
// onnxruntime-node or the onnxruntime-web namespace) and two ready InferenceSessions, so one set of pre- and
// post-processing serves both runtimes. Used by engines/ppocr.mjs and tests/ppocr-synthetic.mjs; importing this module
// has no side effects.
//
// Models (PP-OCRv6-small, oar-ocr v0.7.0 export), verified with onnxruntime itself:
//   det  input  "x"  float32 [N,3,H,W]  (H, W dynamic)      output [N,1,H,W]  probability map (same size as the input)
//   rec  input  "x"  float32 [N,3,48,W] (W dynamic)         output [N,T,18710] per-step class probabilities
//   dictionary file: 18708 characters, one per line. CTC classes = [blank] + dictionary + [space] = 18710.
// Pre-processing follows PaddleOCR: det mean/std are the ImageNet values, rec is (x/255 - 0.5)/0.5; PaddleOCR feeds the
// channels in BGR order (the models were trained on cv2 images), so `bgr` defaults to true.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resizeBilinear } from './resize.mjs';
import { createTimer } from './measure.mjs';

export const DEFAULTS = {
  detMaxSide: 960, // longer side of the detection input is limited to this (never upscaled), sides rounded to 32
  thresh: 0.3, // binarisation threshold on the probability map
  boxThresh: 0.5, // minimum box score. PaddleOCR uses 0.6, which dropped a lone narrow "1" cell and a whole short line (measured)
  scoreMode: 'box', // 'box': mean prob inside the axis-aligned box (PaddleOCR), 'region': mean over the component only
  unclip: 1.5, // box expansion: distance = area * unclip / perimeter (PaddleOCR DB post-processing)
  pad: 2, // extra pixels around every box in ORIGINAL image pixels
  recBatch: 8, // maximum crops per recognition batch
  recMaxWidth: 3200, // crops wider than this (after scaling to height 48) are squeezed horizontally
  recOutMb: 64, // soft cap on the size of one recognition output tensor (N*T*classes floats); shrinks the batch
  recPadValue: 0, // value of the right padding of narrower crops in a batch, in normalised space: 0 = mid-grey (PaddleOCR), 1 = white
  bgr: true, // feed channels in B, G, R order like PaddleOCR
  prefilter: true, // average-downscale by an integer factor before bilinear when shrinking by 2x or more (anti-alias)
  minRecConf: 0, // drop words whose recognition confidence is below this (0 keeps everything)
  maxBoxes: 3000, // hard cap on detected boxes per page (largest score first)
};

export const REC_HEIGHT = 48;
const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];

/** dictionary text -> class table. index 0 = CTC blank (''), 1..n = dictionary lines, n+1 = ' '. */
export function loadDict(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return ['', ...lines.map((l) => l.replace(/\r$/, '')), ' '];
}

/**
 * The only runtime-specific code: load the ORT namespace and create the detection and recognition sessions.
 *   runtime 'node'  onnxruntime-node, native CPU provider, `threads` intra-op threads, 1 inter-op thread
 *   runtime 'web'   onnxruntime-web WASM build run inside Node, numThreads = threads (ORT's own worker threads),
 *                   wasm files taken from the package's dist directory, SIMD on, no proxy worker
 * Memory pattern optimisation is off for both (input shapes are dynamic). `arena` only applies to the native runtime.
 * Returns { ort, det, rec, version, wasmPaths? }.
 */
export async function createPpocrSessions({ runtime, threads = 2, modelDir, arena = true }) {
  const detPath = join(modelDir, 'det.onnx');
  const recPath = join(modelDir, 'rec.onnx');
  if (runtime === 'node') {
    const ort = await import('onnxruntime-node');
    const so = {
      executionProviders: ['cpu'],
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
      enableMemPattern: false,
      enableCpuMemArena: arena,
      logSeverityLevel: 3,
    };
    const det = await ort.InferenceSession.create(detPath, so);
    const rec = await ort.InferenceSession.create(recPath, so);
    return { ort, det, rec, version: ort.env?.versions?.node ?? null };
  }
  if (runtime !== 'web') throw new Error(`unknown runtime ${runtime}`);
  const ort = await import('onnxruntime-web');
  const distDir = fileURLToPath(new URL('./', import.meta.resolve('onnxruntime-web')));
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.wasmPaths = distDir;
  if ('simd' in ort.env.wasm) ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  const so = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableMemPattern: false, logSeverityLevel: 3 };
  const det = await ort.InferenceSession.create(detPath, so);
  const rec = await ort.InferenceSession.create(recPath, so);
  return { ort, det, rec, version: ort.env?.versions?.web ?? null, wasmPaths: distDir };
}

// ---------------------------------------------------------------------------------------------------------------------
// image helpers (RGBA, row-major, interleaved)

/** Average-downscale by an integer factor k (k x k blocks). Keeps the 4-channel layout. */
export function boxDownscale(img, k) {
  if (k <= 1) return img;
  const { width: sw, height: sh, channels: c, data } = img;
  const dw = Math.max(1, Math.floor(sw / k));
  const dh = Math.max(1, Math.floor(sh / k));
  const out = new Uint8Array(dw * dh * c);
  const area = k * k;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      for (let ch = 0; ch < c; ch++) {
        let sum = 0;
        for (let yy = 0; yy < k; yy++) {
          const row = ((y * k + yy) * sw + x * k) * c + ch;
          for (let xx = 0; xx < k; xx++) sum += data[row + xx * c];
        }
        out[(y * dw + x) * c + ch] = Math.round(sum / area);
      }
    }
  }
  return { width: dw, height: dh, channels: c, data: out };
}

/** Copy the integer rectangle [x0,x1) x [y0,y1) out of an image. */
export function cropImage(img, x0, y0, x1, y1) {
  const { width: sw, channels: c, data } = img;
  const w = x1 - x0;
  const h = y1 - y0;
  const out = new Uint8Array(w * h * c);
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * sw + x0) * c;
    out.set(data.subarray(s, s + w * c), y * w * c);
  }
  return { width: w, height: h, channels: c, data: out };
}

// ---------------------------------------------------------------------------------------------------------------------
// detection

/**
 * Resize for the detector and normalise into a CHW float tensor.
 * Returns { data, width, height } of the model input.
 */
export function prepareDet(img, p) {
  const longSide = Math.max(img.width, img.height);
  const scale = Math.min(1, p.detMaxSide / longSide);
  const round32 = (v) => Math.max(32, Math.round((v * scale) / 32) * 32);
  const dw = round32(img.width);
  const dh = round32(img.height);
  let src = img;
  if (p.prefilter) {
    const k = Math.floor(Math.min(img.width / dw, img.height / dh));
    if (k >= 2) src = boxDownscale(img, k);
  }
  const rs = resizeBilinear(src, dw, dh, { float: true });
  const plane = dw * dh;
  const data = new Float32Array(3 * plane);
  const order = p.bgr ? [2, 1, 0] : [0, 1, 2];
  const c = rs.channels;
  for (let k = 0; k < 3; k++) {
    const ch = order[k];
    const mean = DET_MEAN[k];
    const inv = 1 / (255 * DET_STD[k]);
    const off = k * plane;
    const bias = mean / DET_STD[k];
    for (let i = 0; i < plane; i++) data[off + i] = rs.data[i * c + ch] * inv - bias;
  }
  return { data, width: dw, height: dh };
}

/**
 * Probability map -> axis-aligned text boxes in map coordinates.
 * Threshold, 8-connected components (iterative flood fill with an explicit stack), box score, unclip.
 * Returns [{ x0, y0, x1, y1, score }] sorted by score descending (capped at p.maxBoxes).
 */
export function detectBoxes(prob, width, height, p) {
  const n = width * height;
  const bitmap = new Uint8Array(n);
  for (let i = 0; i < n; i++) bitmap[i] = prob[i] > p.thresh ? 1 : 0;

  let integral = null;
  const iw = width + 1;
  if (p.scoreMode === 'box') {
    integral = new Float64Array(iw * (height + 1));
    for (let y = 0; y < height; y++) {
      let rowSum = 0;
      for (let x = 0; x < width; x++) {
        rowSum += prob[y * width + x];
        integral[(y + 1) * iw + x + 1] = integral[y * iw + x + 1] + rowSum;
      }
    }
  }

  const stack = new Int32Array(n);
  const boxes = [];
  for (let start = 0; start < n; start++) {
    if (bitmap[start] !== 1) continue;
    let sp = 0;
    stack[sp++] = start;
    bitmap[start] = 2;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    let sum = 0;
    while (sp > 0) {
      const q = stack[--sp];
      const qy = (q / width) | 0;
      const qx = q - qy * width;
      count++;
      sum += prob[q];
      if (qx < minX) minX = qx;
      if (qx > maxX) maxX = qx;
      if (qy < minY) minY = qy;
      if (qy > maxY) maxY = qy;
      const yLo = qy > 0 ? qy - 1 : 0;
      const yHi = qy < height - 1 ? qy + 1 : height - 1;
      const xLo = qx > 0 ? qx - 1 : 0;
      const xHi = qx < width - 1 ? qx + 1 : width - 1;
      for (let yy = yLo; yy <= yHi; yy++) {
        for (let xx = xLo; xx <= xHi; xx++) {
          const r = yy * width + xx;
          if (bitmap[r] === 1) {
            bitmap[r] = 2;
            stack[sp++] = r;
          }
        }
      }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (Math.min(bw, bh) < 3) continue;
    let score;
    if (integral) {
      const s =
        integral[(maxY + 1) * iw + maxX + 1] - integral[minY * iw + maxX + 1] - integral[(maxY + 1) * iw + minX] +
        integral[minY * iw + minX];
      score = s / (bw * bh);
    } else {
      score = sum / count;
    }
    if (score < p.boxThresh) continue;
    const d = (bw * bh * p.unclip) / (2 * (bw + bh));
    const x0 = Math.max(0, minX - d);
    const y0 = Math.max(0, minY - d);
    const x1 = Math.min(width, maxX + 1 + d);
    const y1 = Math.min(height, maxY + 1 + d);
    if (Math.min(x1 - x0, y1 - y0) < 5) continue;
    boxes.push({ x0, y0, x1, y1, score });
  }
  boxes.sort((a, b) => b.score - a.score);
  return boxes.length > p.maxBoxes ? boxes.slice(0, p.maxBoxes) : boxes;
}

// ---------------------------------------------------------------------------------------------------------------------
// recognition

/** Fill one CHW slot of the batch tensor from a crop resized to height 48 (bilinear), normalised to [-1, 1]. */
function writeRecSlot(batch, slot, dims, crop, resizedW, p) {
  const { width: W } = dims;
  let src = crop;
  if (p.prefilter) {
    const k = Math.floor(crop.height / REC_HEIGHT);
    if (k >= 2) src = boxDownscale(crop, k);
  }
  const rs = resizeBilinear(src, resizedW, REC_HEIGHT, { float: true });
  const plane = REC_HEIGHT * W;
  const base = slot * 3 * plane;
  const order = p.bgr ? [2, 1, 0] : [0, 1, 2];
  const c = rs.channels;
  for (let k = 0; k < 3; k++) {
    const ch = order[k];
    const off = base + k * plane;
    for (let y = 0; y < REC_HEIGHT; y++) {
      const srow = y * resizedW;
      const drow = off + y * W;
      for (let x = 0; x < resizedW; x++) batch[drow + x] = rs.data[(srow + x) * c + ch] / 127.5 - 1;
    }
  }
}

/** Items already carry integer crop rectangles. Returns { data, width, count } (padding is p.recPadValue, 0 = mid-grey). */
export function prepareRecBatch(img, items, p) {
  const entries = items.map((it) => {
    const crop = cropImage(img, it.cx0, it.cy0, it.cx1, it.cy1);
    const ratio = crop.width / crop.height;
    const resizedW = Math.min(p.recMaxWidth, Math.max(8, Math.ceil(REC_HEIGHT * ratio)));
    return { crop, resizedW };
  });
  const W = Math.max(32, ...entries.map((e) => e.resizedW));
  const data = new Float32Array(items.length * 3 * REC_HEIGHT * W);
  if (p.recPadValue) data.fill(p.recPadValue);
  entries.forEach((e, i) => writeRecSlot(data, i, { width: W }, e.crop, e.resizedW, p));
  return { data, width: W, count: items.length };
}

/** CTC greedy decode of a [n, t, c] probability tensor into [{ text, conf }]. */
export function ctcDecode(probs, n, t, c, dict) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let text = '';
    let confSum = 0;
    let kept = 0;
    let prev = -1;
    const base = i * t * c;
    for (let s = 0; s < t; s++) {
      const off = base + s * c;
      let best = 0;
      let bestP = probs[off];
      for (let k = 1; k < c; k++) {
        const v = probs[off + k];
        if (v > bestP) {
          bestP = v;
          best = k;
        }
      }
      if (best !== prev && best !== 0) {
        text += dict[best];
        confSum += bestP;
        kept++;
      }
      prev = best;
    }
    out.push({ text, conf: kept > 0 ? confSum / kept : 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// page driver

/**
 * Run detection and recognition on one RGBA page.
 *   ctx = { ort, det, rec, dict, params, onRun? }   (onRun is called after every session.run, e.g. to sample threads)
 * Returns { words, stagesMs, info } where words = [{ text, conf, box:[x0,y0,x1,y1] }] in original pixel coordinates.
 */
export async function recognizePage(ctx, image) {
  const { ort, det, rec, dict } = ctx;
  const p = { ...DEFAULTS, ...ctx.params };
  const t = createTimer();
  const info = { boxes: 0, recBatches: 0, recStride: null, maxRecWidth: 0, detWidth: 0, detHeight: 0 };

  const prep = t.timeSync('preprocessDet', () => prepareDet(image, p));
  info.detWidth = prep.width;
  info.detHeight = prep.height;
  const detIn = new ort.Tensor('float32', prep.data, [1, 3, prep.height, prep.width]);
  const detOut = await t.time('det', async () => {
    const res = await det.run({ [det.inputNames[0]]: detIn });
    ctx.onRun?.();
    return res[det.outputNames[0]];
  });
  const probMap = detOut.data;
  const mapBoxes = t.timeSync('postprocessDet', () => detectBoxes(probMap, prep.width, prep.height, p));
  detOut.dispose?.();
  detIn.dispose?.();

  const sx = image.width / prep.width;
  const sy = image.height / prep.height;
  const items = [];
  for (const b of mapBoxes) {
    const x0 = Math.max(0, b.x0 * sx - p.pad);
    const y0 = Math.max(0, b.y0 * sy - p.pad);
    const x1 = Math.min(image.width, b.x1 * sx + p.pad);
    const y1 = Math.min(image.height, b.y1 * sy + p.pad);
    const cx0 = Math.floor(x0);
    const cy0 = Math.floor(y0);
    const cx1 = Math.min(image.width, Math.max(cx0 + 2, Math.ceil(x1)));
    const cy1 = Math.min(image.height, Math.max(cy0 + 2, Math.ceil(y1)));
    if (cx1 - cx0 < 2 || cy1 - cy0 < 2) continue;
    items.push({ box: [x0, y0, x1, y1], cx0, cy0, cx1, cy1, ratio: (cx1 - cx0) / (cy1 - cy0) });
  }
  info.boxes = items.length;
  items.sort((a, b) => a.ratio - b.ratio);

  const words = [];
  const classes = dict.length;
  let stride = 4; // assumed until the first recognition output shows the real width-to-steps ratio
  for (let at = 0; at < items.length; ) {
    // widest crop of the batch is the last one (items are sorted by aspect ratio); size the batch by its output tensor
    let n = Math.min(p.recBatch, items.length - at);
    const budgetFloats = (p.recOutMb * 1048576) / 4;
    for (; n > 1; n--) {
      const widest = Math.min(p.recMaxWidth, Math.max(32, Math.ceil(REC_HEIGHT * items[at + n - 1].ratio)));
      if (n * Math.ceil(widest / stride) * classes <= budgetFloats) break;
    }
    const slice = items.slice(at, at + n);
    at += n;
    const batch = t.timeSync('preprocessRec', () => prepareRecBatch(image, slice, p));
    info.recBatches++;
    info.maxRecWidth = Math.max(info.maxRecWidth, batch.width);
    const recIn = new ort.Tensor('float32', batch.data, [batch.count, 3, REC_HEIGHT, batch.width]);
    const recOut = await t.time('rec', async () => {
      const res = await rec.run({ [rec.inputNames[0]]: recIn });
      ctx.onRun?.();
      return res[rec.outputNames[0]];
    });
    const [rn, rt, rc] = recOut.dims;
    if (rc !== classes) throw new Error(`recognition output has ${rc} classes but the dictionary table has ${classes}`);
    stride = batch.width / rt;
    info.recStride = Math.round(stride * 100) / 100;
    const decoded = t.timeSync('decode', () => ctcDecode(recOut.data, rn, rt, rc, dict));
    recOut.dispose?.();
    recIn.dispose?.();
    decoded.forEach((d, i) => {
      const text = d.text.trim();
      if (text === '' || d.conf < p.minRecConf) return;
      words.push({ text, conf: d.conf, box: slice[i].box });
    });
  }
  return { words, stagesMs: t.stagesMs, info };
}
