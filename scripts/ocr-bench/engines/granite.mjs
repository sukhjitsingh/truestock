// Granite-Docling-258M engine (ONNX, quantised) through @huggingface/transformers in Node. Output is DocTags, which
// this file parses into the harness contract. Fully offline: models are read from --model-root (default
// /work/models/hf), nothing is fetched.
//
//   node engines/granite.mjs --variant granite-tile512 --img /work/img/scan-d150.png --out /work/out --threads 2 \
//        --tile 512x512 --overlap 48 [--max-new-tokens 1024] [--combo q4|q8|min] [--budget-ms 1200000]
//   node engines/granite.mjs --variant granite-whole    ... --whole-page       (the processor's own 512 px splitting)
//
// Modes
//   tiles (default)  the page is cut into overlapping --tile WxH squares (stride = tile - overlap, last tile aligned to
//                    the page edge, white padding when the page is smaller than a tile). Each tile is resized to the
//                    model's 512x512 (only when it is not already 512) and run as ONE global image, no processor
//                    splitting. Tiles are decoded independently, greedy, with a repetition guard, then stitched back
//                    into reading order by an ownership rule (see ownedRegion / stitchLines).
//   --whole-page     the whole page goes through the processor unmodified (do_image_splitting, long edge 2048, 512 px
//                    patches plus a global image): the model's native document mode. One generate() for the page.
//
// Flags (all optional)
//   --tile WxH            tile size in page pixels, default 512x512 (768x768 is downscaled to 512 for the model)
//   --overlap N           tile overlap in page pixels, default 48
//   --whole-page          native whole-page mode instead of tiles
//   --combo q4|q8|min     dtype set (see COMBOS), default q4; `min` gave degenerate output once, avoid it
//   --max-new-tokens N    per generate() call, default 1024 per tile, 4096 for --whole-page
//   --budget-ms N         wall-clock budget per PAGE, default 1200000 (20 min). On expiry the page stops, the sidecar
//                         keeps the partial results and the page is recorded as an error (PageBudgetExceeded)
//   --no-skip-blank       run tiles that are blank (uniform and bright); by default they are skipped and counted
//   --no-repeat-guard     disable the periodic-n-gram repetition guard
//   --inter-threads N     ORT inter-op threads, default 1 (intra-op threads come from the common --threads)
//   --model-root DIR      transformers.js local model root, default /work/models/hf
//   --prompt TEXT         default "Convert this page to docling."
//
// Extra outputs (underscore names, so check-out.mjs ignores them):
//   <out>/<variant>/_<image>.granite.json   raw DocTags per tile, per-tile and per-page stats
//   <out>/<variant>/_granite-run.json       process level: combo, thread observations, per-page totals
//
// Word boxes: DocTags gives ONE box per element (4 <loc_N> tokens on a 0..500 grid relative to the image the model
// saw). Per-word boxes are therefore ESTIMATED by splitting the element box (text: proportionally by characters;
// tables: evenly by row and by column). They are good to roughly a line, not a word. If a page has no loc tokens at
// all, `words` is [] and the sidecar says so.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boolFlag, numFlag, strFlag } from '../lib/cli.mjs';
import { runEngine } from '../lib/engine.mjs';
import { maxRssMb } from '../lib/measure.mjs';
import { resizeBilinear } from '../lib/resize.mjs';

const MODEL_ID = 'onnx-community/granite-docling-258M-ONNX';
const COMBOS = {
  min: { embed_tokens: 'q8', vision_encoder: 'q4f16', decoder_model_merged: 'q4f16' },
  q4: { embed_tokens: 'q8', vision_encoder: 'q4', decoder_model_merged: 'q4' },
  q8: { embed_tokens: 'q8', vision_encoder: 'q8', decoder_model_merged: 'q8' },
};
const LOC_GRID = 500; // <loc_N>, N in 0..499, relative to the image the model saw
const MODEL_SIZE = 512; // the vision encoder's image size
const PROMPT = 'Convert this page to docling.';
const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------------------------------------------
// DocTags parsing
// ---------------------------------------------------------------------------------------------------------------
const LEAF_TAG = /^(?:text|title|section_header_level_\d+|page_header|page_footer|caption|footnote|list_item|code|formula|reference)$/;
const CELL_WITH_TEXT = new Set(['fcel', 'ched', 'rhed', 'srow']);
const CELL_WITHOUT_TEXT = new Set(['ecel', 'lcel', 'ucel', 'xcel']);
const TOKEN_RE = /<\|[^|>]*\|>|<(\/?)([A-Za-z][A-Za-z_0-9]*)>|[^<]+|</g;

const decodeEntities = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const squash = (s) => decodeEntities(s).replace(/\s+/g, ' ').trim();

/**
 * Parse (possibly truncated) DocTags into elements, in output order.
 *   text-like: { type, kind: 'text', box: [x0,y0,x1,y1] | null, text }
 *   table:     { type: 'otsl', kind: 'table', box, grid: string[][] (all rows, '' for empty cells),
 *                rows: string[][] (only rows with text, only cells with text), text }
 * `box` is on the 0..500 loc grid (null unless all four loc tokens were present). Elements without text are dropped.
 * Pictures are recognised only so their (non-text) body is not glued onto the previous element.
 */
export function parseDocTags(raw) {
  const elements = [];
  let cur = null;

  const endRow = (el) => {
    if (el.cell) el.row.push(el.cell);
    el.cell = null;
    if (el.row.length > 0) el.rawRows.push(el.row);
    el.row = [];
  };
  const finish = () => {
    if (!cur) return;
    const el = cur;
    cur = null;
    const box = el.locs.length === 4 ? el.locs.slice() : null;
    if (el.kind === 'table') {
      endRow(el);
      const grid = el.rawRows.map((cells) => cells.map((c) => squash(c.text)));
      const rows = grid.map((cells) => cells.filter(Boolean)).filter((cells) => cells.length > 0);
      if (rows.length === 0) return;
      elements.push({ type: 'otsl', kind: 'table', box, grid, rows, text: rows.map((r) => r.join(' ')).join('\n') });
    } else if (el.kind === 'text') {
      const text = squash(el.buf);
      if (text) elements.push({ type: el.type, kind: 'text', box, text });
    }
  };
  const open = (type) => {
    finish();
    const kind = type === 'otsl' ? 'table' : type === 'picture' ? 'picture' : 'text';
    cur = { type, kind, locs: [], started: false, buf: '', rawRows: [], row: [], cell: null };
  };

  for (const m of String(raw).matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (tok.startsWith('<|')) {
      if (tok.includes('end_of_text')) break;
      continue;
    }
    const name = m[2];
    if (name === undefined) {
      if (!cur || cur.kind === 'picture') continue;
      if (cur.kind === 'table') {
        if (cur.cell) cur.cell.text += tok;
      } else {
        cur.buf += tok;
        if (tok.trim()) cur.started = true;
      }
      continue;
    }
    if (m[1] === '/') {
      if (cur && cur.type === name) finish();
      continue;
    }
    const loc = /^loc_(\d+)$/.exec(name);
    if (loc) {
      if (cur && !cur.started && cur.locs.length < 4) cur.locs.push(Number(loc[1]));
      continue;
    }
    if (cur?.kind === 'table') {
      if (CELL_WITH_TEXT.has(name) || CELL_WITHOUT_TEXT.has(name)) {
        if (cur.cell) cur.row.push(cur.cell);
        cur.cell = { tag: name, text: '' };
        cur.started = true;
        continue;
      }
      if (name === 'nl') {
        endRow(cur);
        continue;
      }
    }
    if (LEAF_TAG.test(name) || name === 'otsl' || name === 'picture') open(name);
    // anything else (doctag, list containers, page_break, unknown tags): the tag itself carries no content
  }
  finish();
  return elements;
}

// ---------------------------------------------------------------------------------------------------------------
// Tile geometry and stitching
// ---------------------------------------------------------------------------------------------------------------
function axisPositions(page, tile, overlap) {
  if (page <= tile) return [0];
  const n = Math.ceil((page - overlap) / (tile - overlap));
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.round((i * (page - tile)) / (n - 1)));
  return out;
}

/**
 * Overlapping tile grid. Tiles are tileW x tileH in page pixels, evenly spaced so the last tile touches the page edge
 * (the effective overlap is therefore >= `overlap`); a page smaller than a tile gives one tile, padded by the caller.
 * Row-major order. Returns { pageW, pageH, tileW, tileH, overlap, cols, rows, xs, ys, tiles:[{index,col,row,x,y,w,h}] }.
 */
export function tileGrid(pageW, pageH, tileW, tileH, overlap) {
  if (!(overlap >= 0 && overlap < Math.min(tileW, tileH))) throw new Error('overlap must be in [0, tile size)');
  const xs = axisPositions(pageW, tileW, overlap);
  const ys = axisPositions(pageH, tileH, overlap);
  const tiles = [];
  ys.forEach((y, row) => xs.forEach((x, col) => tiles.push({ index: tiles.length, col, row, x, y, w: tileW, h: tileH })));
  return { pageW, pageH, tileW, tileH, overlap, cols: xs.length, rows: ys.length, xs, ys, tiles };
}

/**
 * The part of the page a tile is responsible for: neighbouring tiles split their overlap strip at its midpoint, outer
 * tiles own everything out to infinity. Half-open: x0 <= x < x1, y0 <= y < y1. Every page point has exactly one owner.
 */
export function ownedRegion(grid, tile) {
  const axis = (pos, size, i) => ({
    lo: i === 0 ? -Infinity : (pos[i - 1] + size + pos[i]) / 2,
    hi: i === pos.length - 1 ? Infinity : (pos[i] + size + pos[i + 1]) / 2,
  });
  const ax = axis(grid.xs, grid.tileW, tile.col);
  const ay = axis(grid.ys, grid.tileH, tile.row);
  return { x0: ax.lo, x1: ax.hi, y0: ay.lo, y1: ay.hi };
}

/** Spread a string over [x0,x1] x [y0,y1] as word boxes, proportionally by character count. */
function spreadWords(text, x0, x1, y0, y1) {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  const total = parts.reduce((s, p) => s + p.length, 0) + parts.length - 1;
  const bottom = Math.max(y1, y0 + 1);
  const words = [];
  let at = 0;
  for (const p of parts) {
    words.push({ text: p, box: [x0 + ((x1 - x0) * at) / total, y0, x0 + ((x1 - x0) * (at + p.length)) / total, bottom] });
    at += p.length + 1;
  }
  return words;
}

/**
 * Elements (loc grid) -> lines in PAGE pixels. A text element is one line; a table gives one line per non-empty row.
 * Word boxes are estimated (see the header). `tile` = { x, y, w, h } is the page region the model saw, so a loc value
 * v maps to x + v / 500 * w. Lines without a box have box null and no words (they keep their text for the markdown).
 */
export function elementsToLines(elements, tile, tileIndex = 0) {
  const lines = [];
  const toPage = (b) => [tile.x + (b[0] / LOC_GRID) * tile.w, tile.y + (b[1] / LOC_GRID) * tile.h, tile.x + (b[2] / LOC_GRID) * tile.w, tile.y + (b[3] / LOC_GRID) * tile.h];
  const push = (kind, text, words, y0, y1) => {
    const x0 = Math.min(...words.map((w) => w.box[0]));
    const x1 = Math.max(...words.map((w) => w.box[2]));
    lines.push({ tile: tileIndex, kind, text, box: [x0, y0, x1, Math.max(y1, y0 + 1)], y0, y1: Math.max(y1, y0 + 1), words });
  };
  for (const el of elements) {
    const box = el.box ? toPage(el.box) : null;
    if (el.kind === 'table') {
      const nRows = el.grid.length;
      const nCols = Math.max(1, ...el.grid.map((r) => r.length));
      el.grid.forEach((cells, i) => {
        const texts = cells.filter(Boolean);
        if (texts.length === 0) return;
        if (!box) {
          lines.push({ tile: tileIndex, kind: 'table', text: texts.join(' '), box: null, words: [] });
          return;
        }
        const ry0 = box[1] + ((box[3] - box[1]) * i) / nRows;
        const ry1 = box[1] + ((box[3] - box[1]) * (i + 1)) / nRows;
        const cw = (box[2] - box[0]) / nCols;
        const words = [];
        cells.forEach((c, j) => {
          if (c) words.push(...spreadWords(c, box[0] + j * cw, box[0] + (j + 1) * cw, ry0, ry1));
        });
        push('table', texts.join(' '), words, ry0, ry1);
      });
    } else if (!box) {
      lines.push({ tile: tileIndex, kind: 'text', text: el.text, box: null, words: [] });
    } else {
      push('text', el.text, spreadWords(el.text, box[0], box[2], box[1], box[3]), box[1], box[3]);
    }
  }
  return lines;
}

/**
 * Stitch per-tile lines into page reading order.
 *   - a LINE is kept by the tile that owns its vertical centre,
 *   - a WORD is kept by the tile that owns its horizontal centre (so words in an overlap are kept once),
 *   - fragments of the same visual row (from different tile columns, or side-by-side blocks) are merged left to right.
 * perTile: [{ tile, lines }]. Returns { lines: string[], words: [{text, box}] } (boxes in page pixels, unclamped).
 */
export function stitchLines(perTile, grid) {
  const frags = [];
  for (const { tile, lines } of perTile) {
    const own = ownedRegion(grid, tile);
    lines.forEach((line, idx) => {
      if (line.box === null) {
        const yc = tile.y + (tile.h * (idx + 0.5)) / lines.length;
        if (yc >= own.y0 && yc < own.y1) frags.push({ yc, h: tile.h / lines.length, x0: tile.x, words: [], text: line.text });
        return;
      }
      const yc = (line.y0 + line.y1) / 2;
      if (!(yc >= own.y0 && yc < own.y1)) return;
      const words = line.words.filter((w) => {
        const xc = (w.box[0] + w.box[2]) / 2;
        return xc >= own.x0 && xc < own.x1;
      });
      if (words.length > 0) frags.push({ yc, h: line.y1 - line.y0, x0: words[0].box[0], words, text: words.map((w) => w.text).join(' ') });
    });
  }
  frags.sort((a, b) => a.yc - b.yc);
  const rows = [];
  for (const f of frags) {
    const last = rows.at(-1);
    if (last && Math.abs(f.yc - last.yc) < 0.5 * Math.min(f.h, last.h)) {
      last.frags.push(f);
      last.yc = (last.yc * (last.frags.length - 1) + f.yc) / last.frags.length;
      last.h = Math.min(last.h, f.h);
    } else {
      rows.push({ yc: f.yc, h: f.h, frags: [f] });
    }
  }
  const lines = [];
  const words = [];
  for (const r of rows) {
    r.frags.sort((a, b) => a.x0 - b.x0);
    lines.push(r.frags.map((f) => f.text).join(' '));
    for (const f of r.frags) words.push(...f.words);
  }
  return { lines, words };
}

// ---------------------------------------------------------------------------------------------------------------
// Repetition guard
// ---------------------------------------------------------------------------------------------------------------
/**
 * Detect a periodic tail in a token id array. Period p in 1..maxPeriod, needing max(minReps, ceil(minTokens / p))
 * repeats. Returns null or { period, reps, keepLen }: keepLen cuts the sequence down to ONE period of the loop.
 */
export function findRepeat(ids, { maxPeriod = 48, minReps = 4, minTokens = 64 } = {}) {
  const n = ids.length;
  for (let p = 1; p <= maxPeriod; p++) {
    const reps = Math.max(minReps, Math.ceil(minTokens / p));
    if (n < p * reps) continue;
    let ok = true;
    for (let i = n - 1; i >= n - p * (reps - 1); i--) {
      if (ids[i] !== ids[i - p]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let j = n - 1;
    while (j - p >= 0 && ids[j] === ids[j - p]) j--;
    const start = j + 1 - p; // first index of the first period of the loop
    return { period: p, reps: Math.floor((n - start) / p), keepLen: start + p };
  }
  return null;
}

/**
 * Text-level repetition: the model often loops on whole elements whose loc numbers differ every time
 * (`<text><loc_0><loc_51>...x</text>` over and over), which a token-exact period check cannot see. Here every
 * <loc_N> is treated as the same unit. Returns null or { period, reps, cutAt } where cutAt is the string offset that
 * keeps exactly one period of the loop.
 */
export function findTextRepeat(raw, { maxPeriod = 40, minReps = 6, minUnits = 36 } = {}) {
  const units = [];
  for (const m of String(raw).matchAll(/<[^>]*>|[^<\s]+/g)) {
    units.push({ key: /^<loc_\d+>$/.test(m[0]) ? '<loc>' : m[0], end: m.index + m[0].length });
  }
  const hit = findRepeat(units.map((u) => u.key), { maxPeriod, minReps, minTokens: minUnits });
  return hit ? { period: hit.period, reps: hit.reps, cutAt: units[hit.keepLen - 1].end } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Model plumbing
// ---------------------------------------------------------------------------------------------------------------
function taskCount() {
  try {
    return readdirSync('/proc/self/task').length;
  } catch {
    return null;
  }
}

function cutTile(img, t) {
  const total = t.w * t.h;
  const data = new Uint8Array(total * 3).fill(255);
  let sum = 0;
  let sumSq = 0;
  let seen = 0;
  const xEnd = Math.min(t.w, img.width - t.x);
  for (let y = 0; y < t.h; y++) {
    const sy = t.y + y;
    if (sy >= img.height) break;
    for (let x = 0; x < xEnd; x++) {
      const si = (sy * img.width + t.x + x) * 4;
      const di = (y * t.w + x) * 3;
      const r = img.data[si];
      const g = img.data[si + 1];
      const b = img.data[si + 2];
      data[di] = r;
      data[di + 1] = g;
      data[di + 2] = b;
      const l = (299 * r + 587 * g + 114 * b) / 1000;
      sum += l;
      sumSq += l * l;
      seen++;
    }
  }
  sum += 255 * (total - seen);
  sumSq += 255 * 255 * (total - seen);
  const mean = sum / total;
  const std = Math.sqrt(Math.max(0, sumSq / total - mean * mean));
  return { rgb: { width: t.w, height: t.h, channels: 3, data }, mean, std };
}

function pageToRgb(img) {
  const n = img.width * img.height;
  const data = new Uint8Array(n * 3);
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
    data[k] = img.data[j];
    data[k + 1] = img.data[j + 1];
    data[k + 2] = img.data[j + 2];
  }
  return { width: img.width, height: img.height, channels: 3, data };
}

/** Generate for one image (a tile, or the whole page in native mode). Returns { rec, elements }. */
async function runOne(state, rgb, tile, deadline) {
  const { tf, processor, model } = state;
  const rec = {
    index: tile.index, col: tile.col, row: tile.row, x: tile.x, y: tile.y, w: tile.w, h: tile.h,
    blank: false, raw: '', tokens: 0, keptTokens: 0, promptTokens: 0,
    preprocessMs: 0, prefillMs: 0, generateMs: 0, tokPerSec: 0, decodeTokPerSec: 0,
    stop: null, repeatGuard: null, elements: 0, empty: false, error: null,
  };
  const t0 = performance.now();
  const raw = new tf.RawImage(new Uint8ClampedArray(rgb.data.buffer, rgb.data.byteOffset, rgb.data.length), rgb.width, rgb.height, 3);
  const inputs = await processor(state.prompt, [raw], state.whole ? {} : { do_image_splitting: false });
  rec.preprocessMs = round1(performance.now() - t0);
  const promptLen = inputs.input_ids.dims.at(-1);
  rec.promptTokens = promptLen;

  let produced = 0;
  let prefillMs = 0;
  const tGen = performance.now();
  const streamer = {
    put(ids) {
      if (ids[0].length === 1) {
        produced++;
        if (produced === 1) prefillMs = performance.now() - tGen;
      }
    },
    end() {},
  };
  let stop = null;
  let repeat = null;
  let textLoop = false;
  const stopper = (allIds) => {
    if (performance.now() >= deadline) {
      stop = 'budget';
      return [true];
    }
    const gen = allIds[0].length - promptLen;
    if (state.repeatGuard && gen >= 64 && gen % 16 === 0) {
      const found = findRepeat(allIds[0].slice(promptLen).map(Number));
      if (found) {
        repeat = found;
        stop = 'repeat';
        return [true];
      }
      if (gen >= 128 && gen % 64 === 0) {
        const tail = processor.tokenizer.decode(allIds[0].slice(Math.max(promptLen, allIds[0].length - 600)).map(Number), {
          skip_special_tokens: false,
          clean_up_tokenization_spaces: false,
        });
        if (findTextRepeat(tail)) {
          textLoop = true;
          stop = 'repeat';
          return [true];
        }
      }
    }
    return [false];
  };
  const out = await model.generate({ ...inputs, max_new_tokens: state.maxNew, do_sample: false, num_beams: 1, stopping_criteria: [stopper], streamer });
  const generateMs = performance.now() - tGen;
  let genIds = Array.from(out.data.slice(promptLen), Number);
  rec.tokens = produced;
  if (repeat) {
    genIds = genIds.slice(0, repeat.keepLen);
    rec.repeatGuard = { kind: 'tokens', period: repeat.period, reps: repeat.reps, keptTokens: repeat.keepLen };
  }
  rec.keptTokens = genIds.length;
  rec.raw = processor.tokenizer.decode(genIds, { skip_special_tokens: false, clean_up_tokenization_spaces: false });
  if (state.repeatGuard && !repeat) {
    // Whole-output text check: also catches loops that ran to the token limit, and trims the one that stopped early.
    const loop = findTextRepeat(rec.raw);
    if (loop || textLoop) {
      rec.repeatGuard = { kind: 'text', period: loop?.period ?? null, reps: loop?.reps ?? null, keptChars: loop ? loop.cutAt : rec.raw.length };
      if (loop) rec.raw = rec.raw.slice(0, loop.cutAt);
    }
  }
  rec.stop = stop ?? (/<\|end_of_text\|>\s*$/.test(rec.raw) ? 'eos' : produced >= state.maxNew ? 'max' : 'other');
  if (rec.stop === 'max' && rec.repeatGuard) rec.stop = 'max+repeat';
  rec.prefillMs = round1(prefillMs);
  rec.generateMs = round1(generateMs);
  rec.tokPerSec = generateMs > 0 ? round3(produced / (generateMs / 1000)) : 0;
  rec.decodeTokPerSec = generateMs - prefillMs > 0 && produced > 1 ? round3((produced - 1) / ((generateMs - prefillMs) / 1000)) : 0;
  const elements = parseDocTags(rec.raw);
  rec.elements = elements.length;
  rec.empty = elements.length === 0;
  return { rec, elements };
}

function numericStats(markdown) {
  const tokens = markdown.split(/\s+/).filter(Boolean);
  return {
    numericTokens: tokens.filter((t) => /\d/.test(t)).length,
    moneyLikeTokens: tokens.filter((t) => /^[$-]?\d[\d,]*\.\d{2}$/.test(t)).length,
  };
}

function parseTileFlag(s) {
  const m = /^(\d+)x(\d+)$/.exec(s);
  if (!m) throw new Error('--tile must look like 512x512');
  return { w: Number(m[1]), h: Number(m[2]) };
}

async function init({ opts, flags }) {
  const tasksBeforeLoad = taskCount();
  const tf = await import('@huggingface/transformers');
  tf.env.localModelPath = strFlag(flags, 'model-root', '/work/models/hf');
  tf.env.allowLocalModels = true;
  tf.env.allowRemoteModels = false;
  const combo = strFlag(flags, 'combo', 'q4');
  if (!COMBOS[combo]) throw new Error(`unknown --combo ${combo}`);
  const whole = boolFlag(flags, 'whole-page', false);
  const tile = parseTileFlag(strFlag(flags, 'tile', '512x512'));
  const interThreads = numFlag(flags, 'inter-threads', 1);
  const processor = await tf.AutoProcessor.from_pretrained(MODEL_ID);
  // Pre-sized tiles must not be re-scaled by the processor (it would up-scale to a 2048 long edge and then squash to
  // 512 with an un-filtered resize); the tile is resized here, once, with lib/resize.mjs, when it is not 512 already.
  if (!whole) processor.image_processor.do_resize = false;
  const model = await tf.AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
    dtype: COMBOS[combo],
    device: 'cpu',
    session_options: { intraOpNumThreads: opts.threads, interOpNumThreads: interThreads },
  });
  const messages = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: strFlag(flags, 'prompt', PROMPT) }] }];
  const state = {
    tf, processor, model, combo, whole, tile,
    overlap: numFlag(flags, 'overlap', 48),
    prompt: processor.apply_chat_template(messages, { add_generation_prompt: true }),
    maxNew: numFlag(flags, 'max-new-tokens', whole ? 4096 : 1024),
    budgetMs: numFlag(flags, 'budget-ms', 1200000),
    skipBlank: boolFlag(flags, 'skip-blank', true),
    repeatGuard: boolFlag(flags, 'repeat-guard', true),
    threads: { intra: opts.threads, inter: interThreads, tasksBeforeLoad, tasksAfterLoad: taskCount(), tasksMax: taskCount() ?? 0 },
    pages: [],
  };
  console.log(`[granite] loaded combo=${combo} mode=${whole ? 'whole-page' : `tiles ${tile.w}x${tile.h} overlap ${state.overlap}`} intra=${opts.threads} inter=${interThreads} tasks before/after load=${tasksBeforeLoad}/${state.threads.tasksAfterLoad}`);
  return state;
}

async function recognize(state, ctx) {
  const { image, name, opts } = ctx;
  const pageStart = performance.now();
  const deadline = pageStart + state.budgetMs;
  const grid = state.whole
    ? { pageW: image.width, pageH: image.height, tileW: image.width, tileH: image.height, overlap: 0, cols: 1, rows: 1, xs: [0], ys: [0], tiles: [{ index: 0, col: 0, row: 0, x: 0, y: 0, w: image.width, h: image.height }] }
    : tileGrid(image.width, image.height, state.tile.w, state.tile.h, state.overlap);
  const recs = [];
  const perTile = [];
  const errors = [];
  let budgetHit = false;
  let blankTiles = 0;
  let prepMs = 0;
  const wholeRgb = state.whole ? pageToRgb(image) : null;

  for (const tile of grid.tiles) {
    if (performance.now() >= deadline) {
      budgetHit = true;
      break;
    }
    let rgb = wholeRgb;
    if (!state.whole) {
      const tc = performance.now();
      const cut = cutTile(image, tile);
      if (state.skipBlank && cut.std < 8 && cut.mean > 150) {
        blankTiles++;
        recs.push({ index: tile.index, col: tile.col, row: tile.row, x: tile.x, y: tile.y, w: tile.w, h: tile.h, blank: true, raw: '', tokens: 0, generateMs: 0 });
        prepMs += performance.now() - tc;
        continue;
      }
      rgb = tile.w === MODEL_SIZE && tile.h === MODEL_SIZE ? cut.rgb : resizeBilinear(cut.rgb, MODEL_SIZE, MODEL_SIZE);
      prepMs += performance.now() - tc;
    }
    try {
      const { rec, elements } = await runOne(state, rgb, tile, deadline);
      recs.push(rec);
      perTile.push({ tile, lines: elementsToLines(elements, tile, tile.index) });
      if (rec.stop === 'budget') budgetHit = true;
      const tasks = taskCount();
      if (tasks !== null) state.threads.tasksMax = Math.max(state.threads.tasksMax, tasks);
      console.log(`[granite] ${name} tile ${tile.index + 1}/${grid.tiles.length} r${tile.row}c${tile.col} prompt=${rec.promptTokens} tokens=${rec.tokens} prefill=${(rec.prefillMs / 1000).toFixed(1)}s gen=${(rec.generateMs / 1000).toFixed(1)}s tok/s=${rec.tokPerSec} stop=${rec.stop} elements=${rec.elements} tasks=${tasks} maxRssMb=${maxRssMb()}`);
    } catch (e) {
      errors.push(e);
      recs.push({ index: tile.index, col: tile.col, row: tile.row, x: tile.x, y: tile.y, w: tile.w, h: tile.h, raw: '', tokens: 0, generateMs: 0, error: `${e?.name ?? 'Error'}` });
      console.error(`[granite] ${name} tile ${tile.index + 1} failed: ${e?.name ?? 'Error'}`);
    }
    if (budgetHit) break;
  }

  const tAsm = performance.now();
  const stitched = stitchLines(perTile, grid);
  const markdown = stitched.lines.join('\n');
  const words = stitched.words
    .map((w) => ({ text: w.text, conf: null, box: [Math.max(0, w.box[0]), Math.max(0, w.box[1]), Math.min(image.width, w.box[2]), Math.min(image.height, w.box[3])] }))
    .filter((w) => w.box[2] > w.box[0] && w.box[3] > w.box[1]);
  const asmMs = performance.now() - tAsm;

  const run = recs.filter((r) => !r.blank && !r.error);
  const sum = (key) => run.reduce((s, r) => s + (r[key] ?? 0), 0);
  const genSec = sum('generateMs') / 1000;
  const tokens = sum('tokens');
  const pageSec = (performance.now() - pageStart) / 1000;
  const locSeen = perTile.some((p) => p.lines.some((l) => l.box !== null));
  const totals = {
    mode: state.whole ? 'whole-page' : 'tiles',
    tilesTotal: grid.tiles.length,
    tilesRun: run.length,
    tilesNotReached: grid.tiles.length - recs.length,
    blankTiles,
    emptyTiles: run.filter((r) => r.empty).length,
    failedTiles: recs.filter((r) => r.error).length,
    tokens,
    tokensPerTile: run.length ? round1(tokens / run.length) : 0,
    generateSec: round1(genSec),
    generateSecPerTile: run.length ? round1(genSec / run.length) : 0,
    prefillSecPerTile: run.length ? round1(sum('prefillMs') / 1000 / run.length) : 0,
    tokensPerSec: genSec > 0 ? round3(tokens / genSec) : 0,
    preprocessSec: round1((sum('preprocessMs') + prepMs) / 1000),
    pageSec: round1(pageSec),
    tilesPerSec: pageSec > 0 ? round3(run.length / pageSec) : 0,
    repeatGuardFired: run.filter((r) => r.repeatGuard).length,
    hitMaxTokens: run.filter((r) => String(r.stop).startsWith('max')).length,
    budgetExceeded: budgetHit,
    ...numericStats(markdown),
    locTokensSeen: locSeen,
    wordBoxesAreEstimated: true,
    wordsReturned: words.length,
    threadTasksMax: state.threads.tasksMax,
    maxRssMbAtPageEnd: maxRssMb(),
  };
  const sidecar = {
    engine: 'granite', variant: opts.variant, image: name, combo: state.combo,
    tile: state.whole ? null : { w: state.tile.w, h: state.tile.h, overlap: state.overlap, cols: grid.cols, rows: grid.rows },
    maxNewTokens: state.maxNew, budgetMs: state.budgetMs, page: { width: image.width, height: image.height },
    totals, tiles: recs,
    note: locSeen ? 'word boxes are estimated from element boxes (loc tokens), not per-word predictions' : 'no loc tokens seen: words is empty',
    partialMarkdown: budgetHit ? markdown : undefined,
  };
  mkdirSync(join(opts.outDir, opts.variant), { recursive: true });
  writeFileSync(join(opts.outDir, opts.variant, `_${name}.granite.json`), `${JSON.stringify(sidecar)}\n`);
  state.pages.push({ image: name, ...totals });
  console.log(`[granite] ${name} done: tiles=${totals.tilesRun}/${totals.tilesTotal} blank=${blankTiles} empty=${totals.emptyTiles} tokens=${tokens} genSec=${totals.generateSec} pageSec=${totals.pageSec} repeatGuard=${totals.repeatGuardFired} numeric=${totals.numericTokens} budgetExceeded=${budgetHit}`);

  if (budgetHit) {
    const err = new Error(`tiles ${run.length} of ${grid.tiles.length} in ${Math.round(pageSec)} s`);
    err.name = 'PageBudgetExceeded';
    throw err;
  }
  if (errors.length > 0 && run.length === 0) throw errors[0];
  return {
    words: locSeen ? words : [],
    markdown,
    stagesMs: {
      preprocess: round1(sum('preprocessMs') + prepMs),
      prefill: round1(sum('prefillMs')),
      generate: round1(sum('generateMs')),
      assemble: round1(asmMs),
    },
  };
}

async function close(state) {
  const { outDir, variant } = state.opts;
  mkdirSync(join(outDir, variant), { recursive: true });
  const info = {
    engine: 'granite', variant, combo: state.combo, dtype: COMBOS[state.combo],
    mode: state.whole ? 'whole-page' : 'tiles', tile: state.tile, overlap: state.overlap, maxNewTokens: state.maxNew,
    budgetMs: state.budgetMs, threads: state.threads, pages: state.pages,
  };
  writeFileSync(join(outDir, variant, '_granite-run.json'), `${JSON.stringify(info, null, 2)}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  await runEngine({
    engine: 'granite',
    init: async (args) => {
      const state = await init(args);
      state.opts = args.opts;
      return state;
    },
    recognize,
    close,
  });
}
