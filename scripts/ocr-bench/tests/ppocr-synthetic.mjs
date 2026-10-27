// Offline sanity test for the PP-OCR pipeline on a SYNTHETIC page (no real content anywhere in this file).
//
// The page is a hand-written one-page PDF (standard Helvetica / Helvetica-Bold / Courier text, fictional invoice-like
// strings) rendered by the bundled PDFium WASM at 150 dpi. Known strings in, OCR out: the test proves the whole chain
// (detect, crop, recognise, CTC decode, dictionary indexing, channel order) reads text, on both ORT runtimes.
//
//   node /bench/tests/ppocr-synthetic.mjs [--runtime node|web|both] [--models /work/models/ppocr] [--threads 2]
//        [--save /work/out/synthetic.png]
//
// Needs node_modules next to the harness (/bench/node_modules in the capped container) and the model files. Exit code
// 0 = every check passed, 1 = a check failed, 2 = usage / setup error. Prints only synthetic text and numbers.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import { boolFlag, numFlag, parseArgs, strFlag } from '../lib/cli.mjs';
import { encodePng } from '../lib/png.mjs';
import {
  createPpocrSessions,
  DEFAULTS,
  loadDict,
  prepareRecBatch,
  recognizePage,
  REC_HEIGHT,
} from '../lib/ppocr-pipeline.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const runtimeFlag = strFlag(flags, 'runtime', 'both');
const modelDir = strFlag(flags, 'models', '/work/models/ppocr');
const threads = numFlag(flags, 'threads', 2);
const savePath = strFlag(flags, 'save');
const DPI = numFlag(flags, 'dpi', 150);
// Optional detector / grouping overrides, to probe the defaults on the synthetic page (anything omitted = DEFAULTS).
const overrides = {};
for (const [flag, key] of [
  ['det-max-side', 'detMaxSide'],
  ['thresh', 'thresh'],
  ['box-thresh', 'boxThresh'],
  ['unclip', 'unclip'],
  ['pad', 'pad'],
]) {
  const v = numFlag(flags, flag);
  if (v !== undefined) overrides[key] = v;
}
if (flags['bgr'] !== undefined) overrides.bgr = boolFlag(flags, 'bgr', DEFAULTS.bgr);
if (flags['prefilter'] !== undefined) overrides.prefilter = boolFlag(flags, 'prefilter', DEFAULTS.prefilter);

// ---- the synthetic page -------------------------------------------------------------------------------------------

const LINES = [
  { font: 'F1', size: 11, y: 740, text: 'NORTHWIND TRADERS SAMPLE INVOICE 00417' },
  { font: 'F1', size: 11, y: 718, text: 'Ship to: 100 Example Street, Springfield' },
  { font: 'F1', size: 11, y: 696, text: 'Terms NET 30 Due 04/15/2026 Page 1 of 1' },
  { font: 'F3', size: 10, y: 674, text: 'SKU 10428 CASE 6 PK 24 UNIT 12.50 EXT 75.00' },
  { font: 'F2', size: 12, y: 652, text: 'SUBTOTAL 1200.00 TAX 84.50' },
  { font: 'F1', size: 9, y: 630, text: 'All sales final. Returns within 14 days with receipt.' },
];
const COLUMNS = [50, 95, 170, 380, 450];
const HEADER = ['QTY', 'ITEM', 'DESCRIPTION', 'UNIT', 'EXT'];
const ROWS = [
  ['6', '10428', 'WIDGET ALPHA 750ML', '12.50', '75.00'],
  ['2', '20931', 'GADGET BETA 1L', '8.75', '17.50'],
  ['12', '30177', 'SPROCKET GAMMA 12PK', '21.00', '252.00'],
  ['1', '40562', 'COG DELTA 1.75L', '33.25', '33.25'],
];
const TABLE_Y0 = 570;
const TABLE_DY = 24;

function buildPdf() {
  const ops = [];
  const put = (font, size, x, y, text) => ops.push(`BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET`);
  for (const l of LINES) put(l.font, l.size, 50, l.y, l.text);
  HEADER.forEach((h, i) => put('F2', 10, COLUMNS[i], TABLE_Y0, h));
  ROWS.forEach((row, r) => row.forEach((cell, i) => put('F1', 10, COLUMNS[i], TABLE_Y0 - TABLE_DY * (r + 1), cell)));
  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function renderPage() {
  const lib = await PDFiumLibrary.init();
  try {
    const doc = await lib.loadDocument(buildPdf());
    const page = doc.getPage(0);
    const r = await page.render({ scale: DPI / 72, render: 'bitmap', colorSpace: 'RGBA', transparent: false });
    page.close();
    doc.destroy();
    return { width: r.width, height: r.height, channels: 4, data: new Uint8Array(r.data) };
  } finally {
    lib.destroy();
  }
}

// ---- scoring --------------------------------------------------------------------------------------------------------

const norm = (s) => s.replace(/\s+/g, ' ').trim();

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** For each expected string: exact word match, contained inside a longer word (merged), and best edit distance. */
function score(expected, words) {
  const texts = words.map((w) => norm(w.text));
  let exact = 0;
  let merged = 0;
  let editSum = 0;
  let charSum = 0;
  const misses = [];
  for (const e of expected) {
    let best = e.length;
    for (const t of texts) best = Math.min(best, editDistance(e, t));
    const isExact = best === 0;
    // "Merged" = the string survives inside a longer recognised word. Only meaningful for 3+ characters; a one-character
    // cell found inside some other word is not evidence of anything.
    const isMerged = !isExact && e.length >= 3 && texts.some((t) => t.includes(e));
    if (isExact) exact++;
    else if (isMerged) merged++;
    else misses.push(`${e} -> best distance ${best}`);
    editSum += isMerged ? 0 : best;
    charSum += e.length;
  }
  return { exact, merged, total: expected.length, cer: editSum / charSum, misses };
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

// ---- run ------------------------------------------------------------------------------------------------------------

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};

let image;
try {
  image = await renderPage();
} catch (e) {
  console.error(`could not render the synthetic page: ${e?.message ?? e}`);
  process.exit(2);
}
let dark = 0;
for (let i = 0; i < image.width * image.height; i++) if (image.data[i * 4] < 128) dark++;
check('synthetic page rendered with text', dark > 1000 && image.width > DPI * 7, `size=${image.width}x${image.height} darkPixels=${dark}`);
if (savePath) writeFileSync(savePath, encodePng(image));

const lineExpected = LINES.map((l) => l.text);
const cellExpected = [...HEADER, ...ROWS.flat()];
const dict = loadDict(readFileSync(join(modelDir, 'dict.txt'), 'utf8'));
check('dictionary table has 18710 classes (blank + 18708 chars + space)', dict.length === 18710, `length=${dict.length}`);

const runtimes = runtimeFlag === 'both' ? ['node', 'web'] : [runtimeFlag];
const results = {};
for (const runtime of runtimes) {
  let s;
  try {
    s = await createPpocrSessions({ runtime, threads, modelDir });
  } catch (e) {
    check(`[${runtime}] sessions load`, false, e?.message ?? String(e));
    continue;
  }
  const t0 = performance.now();
  const res = await recognizePage({ ...s, dict, params: overrides }, image);
  const ms = Math.round(performance.now() - t0);
  results[runtime] = res;
  const lines = score(lineExpected, res.words);
  const cells = score(cellExpected, res.words);
  const meanConf = res.words.reduce((a, w) => a + (w.conf ?? 0), 0) / Math.max(1, res.words.length);
  console.log(
    `[${runtime}] ort=${s.version} boxes=${res.words.length} ms=${ms} meanConf=${meanConf.toFixed(3)} stagesMs=${JSON.stringify(res.stagesMs)} recStride=${res.info.recStride}`,
  );
  check(`[${runtime}] full lines read exactly`, lines.exact >= 5, `${lines.exact}/${lines.total} exact, cer=${lines.cer.toFixed(3)}`);
  check(`[${runtime}] table cells read exactly as separate words`, cells.exact + cells.merged >= 0.8 * cells.total, `${cells.exact} exact + ${cells.merged} merged of ${cells.total}, cer=${cells.cer.toFixed(3)}`);
  check(`[${runtime}] columns not merged`, cells.merged <= 0.1 * cells.total, `merged=${cells.merged}`);
  for (const m of [...lines.misses, ...cells.misses]) console.log(`  miss: ${m}`);
  check(`[${runtime}] confidences in 0..1 and high on clean text`, res.words.every((w) => w.conf >= 0 && w.conf <= 1) && meanConf > 0.85, `meanConf=${meanConf.toFixed(3)}`);
  check(`[${runtime}] boxes inside the page`, res.words.every((w) => w.box[0] >= 0 && w.box[1] >= 0 && w.box[2] <= image.width && w.box[3] <= image.height));

  // The recognition head must emit probabilities (softmax inside the model), or "confidence" would be meaningless.
  const first = res.words[0];
  const item = { cx0: Math.floor(first.box[0]), cy0: Math.floor(first.box[1]), cx1: Math.ceil(first.box[2]), cy1: Math.ceil(first.box[3]) };
  const batch = prepareRecBatch(image, [item], { ...DEFAULTS });
  const out = await s.rec.run({ [s.rec.inputNames[0]]: new s.ort.Tensor('float32', batch.data, [1, 3, REC_HEIGHT, batch.width]) });
  const o = out[s.rec.outputNames[0]];
  const classes = o.dims[2];
  let sum = 0;
  for (let k = 0; k < classes; k++) sum += o.data[(o.dims[1] >> 1) * classes + k];
  check(`[${runtime}] recognition output is a probability distribution`, Math.abs(sum - 1) < 1e-3, `sum=${sum.toFixed(5)} steps=${o.dims[1]} for width ${batch.width}`);
  await s.det.release?.();
  await s.rec.release?.();
}

if (results.node && results.web) {
  const a = results.node.words;
  const b = results.web.words;
  let same = 0;
  for (const w of a) if (b.some((v) => v.text === w.text && iou(v.box, w.box) > 0.9)) same++;
  const agree = same / Math.max(1, Math.max(a.length, b.length));
  check('node and web runtimes agree (same text, box IoU > 0.9)', agree >= 0.95, `${same} of ${Math.max(a.length, b.length)} words identical, boxes node=${a.length} web=${b.length}`);
}

if (boolFlag(flags, 'verbose', false)) for (const [rt, r] of Object.entries(results)) console.log(rt, r.words.map((w) => w.text).join(' | '));
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
